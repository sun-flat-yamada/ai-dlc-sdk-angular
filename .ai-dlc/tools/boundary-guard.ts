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
import { Git } from './lib/git.js';
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
}

/** Runs the guard and returns the report plus a gate result for the loop. */
export async function runBoundaryGuard(
  paths: AidlcPaths,
  options: GuardOptions,
): Promise<{ report: BoundaryReport; gate: GateResult; reverted: string[] }> {
  const started = Date.now();
  const git = new Git(paths.root);
  const classifier = new BoundaryClassifier(loadBoundaryPolicy(paths.boundaryPolicy));
  const changes = await git.changesSince(options.baseline);
  const report = evaluateChanges(classifier, options.baseline, changes);
  const reverted: string[] = [];
  if (options.revert) {
    for (const v of report.violations) {
      await git.restore(v.path, options.baseline);
      if (v.from) await git.restore(v.from, options.baseline);
      reverted.push(v.path);
    }
  }
  const gate: GateResult = {
    gate: 'boundary',
    status: report.violations.length === 0 ? 'pass' : 'fail',
    durationMs: Date.now() - started,
    summary:
      report.violations.length === 0
        ? `${report.changes.length} changed path(s), no boundary violation`
        : `${report.violations.length} boundary violation(s)${options.revert ? ' — reverted' : ''}`,
    failures: report.violations.map((v) => ({
      where: v.from ? `${v.from} -> ${v.path}` : v.path,
      message: `[${v.zone}/${v.rule}] ${v.message}${options.revert ? ' (reverted to baseline)' : ''}`,
    })),
    metrics: { changedPaths: report.changes.length, violations: report.violations.length },
  };
  return { report, gate, reverted };
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
    for (const f of gate.failures) log.warn(`${f.where}: ${f.message}`);
    log.info(gate.summary);
  }
  return gate.status === 'pass' ? 0 : 1;
}

if (isMain(import.meta.url)) {
  runCli(main);
}
