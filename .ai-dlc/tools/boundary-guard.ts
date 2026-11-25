/**
 * Boundary guard: checks every change since the baseline against `boundary-policy.yaml`
 * and (optionally) reverts violations.
 *
 *   npm run aidlc:guard                       # report only
 *   npm run aidlc:guard -- --revert           # revert violating files
 *   npm run aidlc:guard -- --baseline main    # compare with another ref
 *   npm run aidlc:guard -- --snapshot         # record the current HEAD as the baseline
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  BoundaryClassifier,
  BoundaryReport,
  evaluateChanges,
  loadBoundaryPolicy,
} from './lib/boundary.js';
import { AidlcPaths, findRepoRoot, loadConfig, resolvePaths } from './lib/config.js';
import { DependencyGuard } from './lib/dependency-guard.js';
import { FileChange, Git } from './lib/git.js';
import {
  ExtensibleFileVersions,
  explainReferenceRemovals,
  ReferenceRemoval,
} from './lib/reference-removal.js';
import { RepositoryGuard } from './lib/repository-guard.js';
import { isMain, log, runCli } from './lib/cli.js';
import { enforceSandbox } from './lib/sandbox.js';
import { GateResult, writeJsonAtomic } from './lib/telemetry.js';

export interface BaselineSnapshot {
  ref: string;
  sha: string;
  createdAt: string;
  /** SHA-256 of the Excel-derived cases at snapshot time (expected values must not drift). */
  subsystemCasesSha256?: string;
}

export function baselineFile(paths: AidlcPaths): string {
  return path.join(paths.outputs.telemetry, 'baseline.json');
}

export function readBaseline(paths: AidlcPaths): BaselineSnapshot | undefined {
  const file = baselineFile(paths);
  return existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as BaselineSnapshot)
    : undefined;
}

export async function recordBaseline(
  paths: AidlcPaths,
  ref = 'HEAD',
  subsystemCasesSha256?: string,
): Promise<BaselineSnapshot> {
  const git = new Git(paths.root);
  const snapshot: BaselineSnapshot = {
    ref,
    sha: await git.resolve(ref),
    createdAt: new Date().toISOString(),
    ...(subsystemCasesSha256 ? { subsystemCasesSha256 } : {}),
  };
  writeJsonAtomic(baselineFile(paths), snapshot);
  return snapshot;
}

export interface GuardOptions {
  baseline: string;
  revert: boolean;
  /** Fingerprint of git-ignored directories (node_modules) captured before the agent ran. */
  dependencies?: DependencyGuard;
  /**
   * In-memory capture of `.git/` metadata and refs taken before the agent ran. Checked (and restored)
   * first, so that the boundary check below reads a trusted `.git/`.
   */
  repository?: RepositoryGuard;
}

/** Runs the guard and returns the report plus a gate result for the loop. */
export async function runBoundaryGuard(
  paths: AidlcPaths,
  options: GuardOptions,
): Promise<{ report: BoundaryReport; gate: GateResult; reverted: string[] }> {
  const started = Date.now();
  const git = new Git(paths.root);
  const classifier = new BoundaryClassifier(loadBoundaryPolicy(paths.boundaryPolicy));
  const repo = options.repository ? await options.repository.check(options.revert) : [];
  const { base, tree, changes } = await git.snapshotChanges(options.baseline);
  const referenceRemovals = classifier.policy.removeReferencesToDeleted
    ? await analyseReferenceRemovals(git, classifier, base, tree, changes)
    : undefined;
  const report = evaluateChanges(classifier, options.baseline, changes, {
    ...(referenceRemovals ? { referenceRemovals } : {}),
  });
  const reverted: string[] = [];
  if (options.revert) {
    for (const v of report.violations) {
      await git.restore(v.path, options.baseline);
      if (v.from) await git.restore(v.from, options.baseline);
      reverted.push(v.path);
    }
  }
  const deps = options.dependencies ? await options.dependencies.check(options.revert) : undefined;
  const failures: GateResult['failures'] = repo.map((v) => ({
    where: v.where,
    message: `[git/${v.rule}] ${v.message}`,
  }));
  failures.push(
    ...report.violations.map((v) => ({
      where: v.from ? `${v.from} -> ${v.path}` : v.path,
      message: `[${v.zone}/${v.rule}] ${v.message}${options.revert ? ' (reverted to baseline)' : ''}`,
    })),
  );
  for (const c of deps?.changed ?? []) {
    failures.push({
      where: c.path,
      message: `[ignored/dependency-changed] ${c.files} file(s) changed in a git-ignored dependency directory. Never modify installed packages; change the implementation instead.${
        deps?.restored
          ? ` (${deps.restored.ok ? deps.restored.detail : `NOT restored: ${deps.restored.detail}`})`
          : ''
      }`,
    });
  }
  const violations = repo.length + report.violations.length + (deps?.changed.length ?? 0);
  const gate: GateResult = {
    gate: 'boundary',
    status: violations === 0 ? 'pass' : 'fail',
    durationMs: Date.now() - started,
    summary:
      violations === 0
        ? `${report.changes.length} changed path(s), no boundary violation`
        : `${violations} boundary violation(s)${options.revert ? ' — reverted' : ''}`,
    failures,
    metrics: {
      changedPaths: report.changes.length,
      violations,
      ...(deps ? { dependencyViolations: deps.changed.length } : {}),
      ...(options.repository ? { repositoryViolations: repo.length } : {}),
      ...(report.referenceRemovals.length
        ? { referenceRemovals: report.referenceRemovals.length }
        : {}),
    },
  };
  return { report, gate, reverted };
}

/**
 * Reads both versions of each extensible file with removed lines, when files of the deletable zone
 * were deleted, and decides whether the removed lines only reference those files (issue #20).
 */
async function analyseReferenceRemovals(
  git: Git,
  classifier: BoundaryClassifier,
  base: string,
  tree: string,
  changes: readonly FileChange[],
): Promise<Map<string, ReferenceRemoval> | undefined> {
  const deleted = new Set(
    changes.flatMap((c) => {
      const gone = c.status === 'deleted' ? c.path : c.status === 'renamed' ? c.from : undefined;
      return gone && classifier.classify(gone) === 'deletable' ? [gone] : [];
    }),
  );
  if (!deleted.size) return undefined;
  const files: ExtensibleFileVersions[] = [];
  for (const c of changes) {
    if (c.status !== 'modified' || !c.deleted || classifier.classify(c.path) !== 'extensible')
      continue;
    const [baseline, current] = await Promise.all([
      git.readBlob(base, c.path),
      git.readBlob(tree, c.path),
    ]);
    if (baseline !== undefined && current !== undefined)
      files.push({ path: c.path, baseline, current });
  }
  return files.length ? explainReferenceRemovals(files, deleted) : undefined;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      baseline: { type: 'string' },
      revert: { type: 'boolean', default: false },
      snapshot: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
  });
  const root = findRepoRoot();
  const paths = resolvePaths(root);
  const config = loadConfig(paths.config);
  await enforceSandbox(config, 'aidlc:guard', 'tool');
  if (values.snapshot) {
    const snap = await recordBaseline(paths, values.baseline ?? 'HEAD');
    log.info(`Baseline recorded: ${snap.ref} (${snap.sha.slice(0, 12)})`);
    return 0;
  }
  const baseline = values.baseline ?? readBaseline(paths)?.sha ?? config.project.baseRef;
  const { report, gate } = await runBoundaryGuard(paths, { baseline, revert: values.revert });
  if (values.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    log.info(`Baseline: ${baseline}`);
    for (const c of report.changes)
      log.info(`  ${c.status.padEnd(8)} ${c.zone.padEnd(12)} ${c.path}`);
    for (const r of report.referenceRemovals)
      for (const u of r.units.filter((x) => x.removed))
        log.info(`  reference removed ${r.path}:${u.startLine}-${u.endLine} (${u.reason})`);
    for (const f of gate.failures) log.warn(`${f.where}: ${f.message}`);
    log.info(gate.summary);
  }
  return gate.status === 'pass' ? 0 : 1;
}

if (isMain(import.meta.url)) {
  runCli(main);
}
