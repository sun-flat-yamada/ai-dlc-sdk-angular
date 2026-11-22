/**
 * Staged quality gates. Each gate runs only when the previous one passed.
 *
 *   Gate 0  inputs     ui-bindings.yaml <-> HTML <-> OpenAPI <-> Excel consistency
 *   Gate 1  boundary   boundary-guard (changes vs. the baseline)
 *   Gate 2  build      Angular build + lint (static analysis)
 *   Gate 3  unit       unit tests + coverage thresholds
 *   Gate 4  subsystem  Excel-derived Playwright tests = FINAL QUALITY GATE
 *
 *   npm run aidlc:gate                          # all gates
 *   npm run aidlc:gate -- --only build,unit     # subset
 *   npm run aidlc:gate -- --json                # machine-readable result
 */
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { readBaseline, runBoundaryGuard } from './boundary-guard.js';
import { parseWorkbooks } from './excel-to-test-ast.js';
import { inputsGate } from './validate-inputs.js';
import {
  AidlcConfig,
  AidlcPaths,
  GateConfig,
  findRepoRoot,
  loadConfig,
  resolvePaths,
} from './lib/config.js';
import { DependencyGuard } from './lib/dependency-guard.js';
import { RepositoryGuard } from './lib/repository-guard.js';
import { exec, stripAnsi, tail } from './lib/exec.js';
import { isMain, log, rel, runCli } from './lib/cli.js';
import { enforceSandbox } from './lib/sandbox.js';
import {
  caseIdsInTitle,
  parseBuildErrors,
  parseCoverageSummary,
  parseLintErrors,
  parsePlaywrightReport,
  parseVitestFailures,
} from './lib/output-parsers.js';
import {
  SubsystemCase,
  SubsystemCaseFile,
  VERIFIED_ANNOTATION,
  hashCases,
  requiredVerifications,
} from './lib/subsystem-cases.js';
import { GateName, GateResult } from './lib/telemetry.js';

export const GATE_ORDER: GateName[] = ['inputs', 'boundary', 'build', 'lint', 'unit', 'subsystem'];

export interface GateRunOptions {
  only?: GateName[];
  /** Do not execute external commands; every non-boundary gate is reported as skipped. */
  dryRun?: boolean;
  /** Revert boundary violations (used by the loop). */
  revertViolations?: boolean;
  baseline?: string;
  /**
   * Hash of the Excel-derived cases that the orchestrator computed at the start of the run and keeps
   * in memory. When set, Gate 4 also requires `baseline.json` to exist (it is never deleted mid-run).
   */
  expectedCasesSha256?: string;
  /**
   * In-memory fingerprint of git-ignored dependency directories (node_modules), captured by the
   * orchestrator before the agent ran. Checked by Gate 1; build caches are cleared before the gates.
   */
  dependencies?: DependencyGuard;
  /** In-memory capture of `.git/` metadata and refs, checked and restored first by Gate 1. */
  repository?: RepositoryGuard;
  echo?: boolean;
}

function skipped(gate: GateName, summary: string): GateResult {
  return { gate, status: 'skipped', durationMs: 0, summary, failures: [] };
}

async function runCommand(paths: AidlcPaths, gate: GateConfig, echo: boolean) {
  return exec(gate.command, {
    cwd: paths.root,
    timeoutMs: gate.timeoutMinutes * 60_000,
    echo,
    killProcessGroup: true,
  });
}

/** A TCP port on localhost that nothing listens on right now. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}

export async function runBuildGate(
  paths: AidlcPaths,
  config: AidlcConfig,
  echo = false,
): Promise<GateResult> {
  const r = await runCommand(paths, config.gates.build, echo);
  const failures = r.exitCode === 0 ? [] : parseBuildErrors(r.output);
  return {
    gate: 'build',
    status: r.exitCode === 0 ? 'pass' : 'fail',
    durationMs: r.durationMs,
    summary:
      r.exitCode === 0
        ? 'Build succeeded'
        : `Build failed (${failures.length} error(s))${r.timedOut ? ' — timed out' : ''}`,
    failures,
    logTail: r.exitCode === 0 ? undefined : tail(stripAnsi(r.output), 60),
  };
}

export async function runLintGate(
  paths: AidlcPaths,
  config: AidlcConfig,
  echo = false,
): Promise<GateResult> {
  const r = await runCommand(paths, config.gates.lint, echo);
  const parsed = parseLintErrors(r.output);
  const pass = r.exitCode === 0;
  return {
    gate: 'lint',
    status: pass ? 'pass' : 'fail',
    durationMs: r.durationMs,
    summary: pass
      ? `Lint passed (${parsed.warnings} warning(s))`
      : `Lint failed (${parsed.errors} error(s), ${parsed.warnings} warning(s))`,
    failures: pass
      ? []
      : parsed.failures.length
        ? parsed.failures
        : [{ where: 'lint', message: tail(stripAnsi(r.output), 5) }],
    metrics: { errors: parsed.errors, warnings: parsed.warnings },
    logTail: pass ? undefined : tail(stripAnsi(r.output), 60),
  };
}

export async function runUnitGate(
  paths: AidlcPaths,
  config: AidlcConfig,
  echo = false,
): Promise<GateResult> {
  const gate = config.gates.unit;
  const summaryFile = gate.coverage ? path.join(paths.root, gate.coverage.summaryFile) : undefined;
  if (summaryFile) rmSync(summaryFile, { force: true });
  const r = await runCommand(paths, gate, echo);
  const failures = r.exitCode === 0 ? [] : parseVitestFailures(r.output);
  const output = stripAnsi(r.output);
  const passed = Number(/Tests\s+(?:\d+ failed \| )?(\d+) passed/.exec(output)?.[1] ?? 0);
  const failed = Number(/Tests\s+(\d+) failed/.exec(output)?.[1] ?? 0);
  const metrics: Record<string, number> = { passed, failed };
  if (r.exitCode !== 0) {
    return {
      gate: 'unit',
      status: 'fail',
      durationMs: r.durationMs,
      summary: `Unit tests failed (${failed || failures.length} failing)${r.timedOut ? ' — timed out' : ''}`,
      failures: failures.length ? failures : [{ where: 'unit', message: tail(output, 8) }],
      metrics,
      logTail: tail(output, 80),
    };
  }
  if (gate.coverage && summaryFile) {
    if (!existsSync(summaryFile)) {
      return {
        gate: 'unit',
        status: 'fail',
        durationMs: r.durationMs,
        summary: `Coverage summary not found: ${rel(paths.root, summaryFile)}`,
        failures: [
          {
            where: rel(paths.root, summaryFile),
            message: 'Run the unit tests with coverage (json-summary reporter).',
          },
        ],
        metrics,
      };
    }
    const cov = parseCoverageSummary(readFileSync(summaryFile, 'utf8'));
    Object.assign(metrics, {
      coverageStatements: cov.statements,
      coverageBranches: cov.branches,
      coverageFunctions: cov.functions,
      coverageLines: cov.lines,
    });
    const below = (Object.keys(cov) as (keyof typeof cov)[]).filter(
      (k) => cov[k] < gate.coverage!.thresholds[k],
    );
    if (below.length) {
      return {
        gate: 'unit',
        status: 'fail',
        durationMs: r.durationMs,
        summary: `Coverage below threshold: ${below.map((k) => `${k} ${cov[k]}% < ${gate.coverage!.thresholds[k]}%`).join(', ')}`,
        failures: below.map((k) => ({
          where: `coverage.${k}`,
          message: `${cov[k]}% < ${gate.coverage!.thresholds[k]}%`,
        })),
        metrics,
      };
    }
  }
  return {
    gate: 'unit',
    status: 'pass',
    durationMs: r.durationMs,
    summary: `${passed} unit test(s) passed`,
    failures: [],
    metrics,
  };
}

function listSpecs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) =>
    /\.spec\.ts$/.test(f),
  );
}

const KIT_ASSERTIONS = ['expectApiRequests', 'expectCss', 'expectUi', 'expectNoRequest'];

/**
 * Static checks of the generated tests (issue #18): they must not write the verification records of
 * the subsystem kit themselves, and every kit assertion must be awaited (an unawaited assertion can
 * fail after the test already passed). Returns the problems (empty when the tests are fine).
 */
export function lintGeneratedTests(specDir: string): GateResult['failures'] {
  const problems: GateResult['failures'] = [];
  for (const file of listSpecs(specDir)) {
    const abs = path.join(specDir, file);
    const where = (line: number) => `${rel(path.resolve(specDir, '../../../..'), abs)}:${line}`;
    const lines = readFileSync(abs, 'utf8').split(/\r?\n/);
    lines.forEach((text, i) => {
      if (new RegExp(`${VERIFIED_ANNOTATION}|\\bannotations\\b`).test(text)) {
        problems.push({
          where: where(i + 1),
          message:
            'Generated tests must not touch test annotations: the subsystem kit records verified expectations itself.',
        });
      }
      for (const m of text.matchAll(new RegExp(`\\b(${KIT_ASSERTIONS.join('|')})\\s*\\(`, 'g'))) {
        if (/^\s*import\b/.test(text) || /\bfrom\s+['"]/.test(text)) continue;
        const before = text.slice(0, m.index).trimEnd();
        if (!/(\bawait|=>|\breturn)$/.test(before)) {
          problems.push({
            where: where(i + 1),
            message: `\`${m[1]}(…)\` must be awaited (\`await ${m[1]}(…)\`).`,
          });
        }
      }
    });
  }
  return problems;
}

/** Labels of the expectations of `c` that no passing test recorded as verified. */
export function unverified(
  c: SubsystemCase,
  tests: readonly { status: string; verified?: string[] }[],
): string[] {
  const seen = new Set(tests.filter((t) => t.status === 'passed').flatMap((t) => t.verified ?? []));
  return requiredVerifications(c)
    .filter((r) => !seen.has(r.key))
    .map((r) => r.label);
}

/**
 * Verifies that the expected values in `subsystem-cases.json` are exactly what the Excel workbooks
 * say. Everything under `.ai-dlc/outputs/` is writable by the agent and git-ignored, so the file's
 * own `casesSha256` and `baseline.json` prove nothing on their own: the trusted references are the
 * workbooks in the immutable `.ai-dlc/inputs/` (re-parsed here) and the hash the orchestrator keeps
 * in memory. Returns the failure messages (empty when the cases are intact).
 */
export async function verifyCaseIntegrity(
  paths: AidlcPaths,
  config: AidlcConfig,
  cases: SubsystemCaseFile,
  expectedCasesSha256?: string,
): Promise<string[]> {
  const problems: string[] = [];
  const actualHash = hashCases(cases.cases);
  if (actualHash !== cases.casesSha256)
    problems.push('The cases do not match the casesSha256 recorded in subsystem-cases.json.');
  try {
    const fromExcel = (await parseWorkbooks(paths, config)).casesSha256;
    if (actualHash !== fromExcel)
      problems.push('The cases differ from the Excel workbooks in .ai-dlc/inputs/subsystem-tests.');
  } catch (e) {
    problems.push(`The Excel workbooks could not be re-parsed: ${(e as Error).message}`);
  }
  if (expectedCasesSha256 !== undefined && actualHash !== expectedCasesSha256)
    problems.push('The cases differ from the snapshot taken at the start of the run.');
  const snapshot = readBaseline(paths);
  if (snapshot?.subsystemCasesSha256 && snapshot.subsystemCasesSha256 !== actualHash)
    problems.push('The cases differ from the hash recorded in baseline.json.');
  if (expectedCasesSha256 !== undefined && snapshot?.subsystemCasesSha256 !== expectedCasesSha256)
    problems.push('baseline.json is missing or was modified during the run.');
  return problems;
}

export async function runSubsystemGate(
  paths: AidlcPaths,
  config: AidlcConfig,
  echo = false,
  expectedCasesSha256?: string,
): Promise<GateResult> {
  const gate = config.gates.subsystem;
  const started = Date.now();
  const fail = (
    summary: string,
    failures: GateResult['failures'],
    metrics?: Record<string, number>,
  ): GateResult => ({
    gate: 'subsystem',
    status: 'fail',
    durationMs: Date.now() - started,
    summary,
    failures,
    ...(metrics ? { metrics } : {}),
  });
  if (!existsSync(paths.subsystemCases)) {
    return fail('subsystem-cases.json not found', [
      {
        where: rel(paths.root, paths.subsystemCases),
        message: 'Run `npm run aidlc:parse-excel` first.',
      },
    ]);
  }
  let cases: SubsystemCaseFile;
  try {
    cases = JSON.parse(readFileSync(paths.subsystemCases, 'utf8')) as SubsystemCaseFile;
    if (!Array.isArray(cases.cases)) throw new Error('"cases" is not an array');
  } catch (e) {
    return fail('Expected values were modified', [
      {
        where: rel(paths.root, paths.subsystemCases),
        message: `subsystem-cases.json is unreadable (${(e as Error).message}). Regenerate it with \`npm run aidlc:parse-excel\`.`,
      },
    ]);
  }
  // Expected values come from humans. Any drift from the Excel workbooks is tampering, not a fix.
  const problems = await verifyCaseIntegrity(paths, config, cases, expectedCasesSha256);
  if (problems.length) {
    return fail(
      'Expected values were modified',
      problems.map((p) => ({
        where: rel(paths.root, paths.subsystemCases),
        message: `${p} Never edit expected values; regenerate with \`npm run aidlc:parse-excel\`.`,
      })),
    );
  }
  const specDir = path.join(paths.outputs.generatedTests, 'subsystem');
  if (listSpecs(specDir).length === 0) {
    return fail(
      'No generated subsystem tests',
      [
        {
          where: rel(paths.root, specDir),
          message:
            'Generate Playwright tests (`*.spec.ts`) for every case, titled with `[<case ID>]` (skill 03-excel-subsystem-gate).',
        },
      ],
      { cases: cases.cases.length, passed: 0, passRate: 0 },
    );
  }
  const lint = lintGeneratedTests(specDir);
  if (lint.length) {
    return fail(`${lint.length} problem(s) in the generated subsystem tests`, lint, {
      cases: cases.cases.length,
      passed: 0,
      passRate: 0,
    });
  }
  const reportFile = path.join(paths.root, gate.reportFile);
  rmSync(reportFile, { force: true });
  // A fresh port per run: a server the agent left on the default port cannot answer for the app.
  const port = await freePort();
  const r = await exec(gate.command, {
    cwd: paths.root,
    timeoutMs: gate.timeoutMinutes * 60_000,
    echo,
    env: { PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile, AIDLC_SUBSYSTEM_PORT: String(port) },
    killProcessGroup: true,
  });
  if (!existsSync(reportFile)) {
    return {
      ...fail(`Playwright did not produce ${rel(paths.root, reportFile)} (exit ${r.exitCode})`, [
        { where: 'playwright', message: tail(stripAnsi(r.output), 10) },
      ]),
      logTail: tail(stripAnsi(r.output), 80),
    };
  }
  const results = parsePlaywrightReport(readFileSync(reportFile, 'utf8'));
  const byCase = new Map<string, typeof results>();
  for (const t of results) {
    for (const id of caseIdsInTitle(t.title)) {
      byCase.set(id, [...(byCase.get(id) ?? []), t]);
    }
  }
  const failures: GateResult['failures'] = [];
  let passedCases = 0;
  for (const c of cases.cases) {
    const tests = byCase.get(c.id) ?? [];
    if (tests.length === 0) {
      if (gate.requireAllCasesCovered)
        failures.push({ where: c.id, message: `No test titled with [${c.id}] (${c.title})` });
      continue;
    }
    const bad = tests.filter((t) => t.status !== 'passed');
    const missing = gate.requireVerifiedExpectations ? unverified(c, tests) : [];
    if (bad.length === 0 && missing.length === 0) {
      passedCases++;
    } else if (bad.length === 0) {
      for (const label of missing) {
        failures.push({
          where: c.id,
          message: `Expectation never verified by a passing test: ${label}. A test that does not check the Excel expectation does not count.`,
        });
      }
    } else {
      for (const t of bad) {
        failures.push({
          where: `${c.id} ${t.title}`,
          message:
            t.status === 'skipped'
              ? 'Skipped tests do not count — implement it.'
              : (t.error ?? t.status),
        });
      }
    }
  }
  const unknown = [...byCase.keys()].filter((id) => !cases.cases.some((c) => c.id === id));
  for (const id of unknown)
    failures.push({
      where: id,
      message: 'Test refers to a case ID that is not in the Excel specification.',
    });
  const passRate = cases.cases.length ? passedCases / cases.cases.length : 0;
  const metrics = {
    cases: cases.cases.length,
    passed: passedCases,
    passRate,
    tests: results.length,
  };
  const pass = failures.length === 0 && passRate >= gate.minPassRate;
  return {
    gate: 'subsystem',
    status: pass ? 'pass' : 'fail',
    durationMs: Date.now() - started,
    summary: `${passedCases}/${cases.cases.length} subsystem case(s) passed (${(passRate * 100).toFixed(1)}%)`,
    failures,
    metrics,
    ...(pass ? {} : { logTail: tail(stripAnsi(r.output), 60) }),
  };
}

/** Runs the gates in order; a failing gate turns the remaining gates into `skipped`. */
export async function runGates(
  paths: AidlcPaths,
  config: AidlcConfig,
  options: GateRunOptions = {},
): Promise<GateResult[]> {
  const selected = options.only?.length ? options.only : GATE_ORDER;
  const results: GateResult[] = [];
  let blocked: GateName | undefined;
  if (!options.dryRun) options.dependencies?.clearCaches();
  for (const name of GATE_ORDER) {
    if (!selected.includes(name)) continue;
    if (blocked) {
      results.push(skipped(name, `Skipped: gate "${blocked}" failed`));
      continue;
    }
    let result: GateResult;
    if (name === 'inputs') {
      result = inputsGate(paths);
    } else if (name === 'boundary') {
      const baseline = options.baseline ?? readBaseline(paths)?.sha ?? config.project.baseRef;
      result = (
        await runBoundaryGuard(paths, {
          baseline,
          revert: options.revertViolations ?? false,
          ...(options.dependencies ? { dependencies: options.dependencies } : {}),
          ...(options.repository ? { repository: options.repository } : {}),
        })
      ).gate;
    } else if (options.dryRun) {
      result = skipped(name, 'Skipped: dry-run');
    } else if (name !== 'subsystem' && !config.gates[name].enabled) {
      result = skipped(name, 'Disabled in aidlc.config.yaml');
    } else if (name === 'subsystem' && !config.gates.subsystem.enabled) {
      result = skipped(name, 'Disabled in aidlc.config.yaml');
    } else {
      log.step(`Gate: ${name}`);
      const echo = options.echo ?? false;
      result =
        name === 'build'
          ? await runBuildGate(paths, config, echo)
          : name === 'lint'
            ? await runLintGate(paths, config, echo)
            : name === 'unit'
              ? await runUnitGate(paths, config, echo)
              : await runSubsystemGate(paths, config, echo, options.expectedCasesSha256);
    }
    log.info(`[${result.status.toUpperCase()}] ${name}: ${result.summary}`);
    results.push(result);
    if (result.status === 'fail') blocked = name;
  }
  return results;
}

/** All gates passed — skipped gates do NOT count as passed. */
export function allGatesPassed(results: readonly GateResult[]): boolean {
  return results.length > 0 && results.every((r) => r.status === 'pass');
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      only: { type: 'string' },
      json: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      baseline: { type: 'string' },
    },
  });
  const root = findRepoRoot();
  const paths = resolvePaths(root);
  const config = loadConfig(paths.config);
  await enforceSandbox(config, 'aidlc:gate', values['dry-run'] ? 'tool' : 'agent');
  const only = values.only?.split(',').map((s) => s.trim()) as GateName[] | undefined;
  const invalid = only?.filter((g) => !GATE_ORDER.includes(g));
  if (invalid?.length)
    throw new Error(`Unknown gate(s): ${invalid.join(', ')}. Valid: ${GATE_ORDER.join(', ')}`);
  const results = await runGates(paths, config, {
    ...(only ? { only } : {}),
    dryRun: values['dry-run'],
    ...(values.baseline ? { baseline: values.baseline } : {}),
    echo: !values.json,
  });
  if (values.json) console.log(JSON.stringify(results, null, 2));
  return allGatesPassed(results) ? 0 : 1;
}

if (isMain(import.meta.url)) {
  runCli(main);
}
