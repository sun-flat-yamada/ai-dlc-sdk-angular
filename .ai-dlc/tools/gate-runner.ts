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
import path from 'node:path';
import { parseArgs } from 'node:util';
import { readBaseline, runBoundaryGuard } from './boundary-guard.js';
import { inputsGate } from './validate-inputs.js';
import {
  AidlcConfig,
  AidlcPaths,
  GateConfig,
  findRepoRoot,
  loadConfig,
  resolvePaths,
} from './lib/config.js';
import { exec, stripAnsi, tail } from './lib/exec.js';
import { isMain, log, rel, runCli } from './lib/cli.js';
import {
  caseIdsInTitle,
  parseBuildErrors,
  parseCoverageSummary,
  parseLintErrors,
  parsePlaywrightReport,
  parseVitestFailures,
} from './lib/output-parsers.js';
import { SubsystemCaseFile, hashCases } from './lib/subsystem-cases.js';
import { GateName, GateResult } from './lib/telemetry.js';

export const GATE_ORDER: GateName[] = ['inputs', 'boundary', 'build', 'lint', 'unit', 'subsystem'];

export interface GateRunOptions {
  only?: GateName[];
  /** Do not execute external commands; every non-boundary gate is reported as skipped. */
  dryRun?: boolean;
  /** Revert boundary violations (used by the loop). */
  revertViolations?: boolean;
  baseline?: string;
  echo?: boolean;
}

function skipped(gate: GateName, summary: string): GateResult {
  return { gate, status: 'skipped', durationMs: 0, summary, failures: [] };
}

async function runCommand(paths: AidlcPaths, gate: GateConfig, echo: boolean) {
  return exec(gate.command, { cwd: paths.root, timeoutMs: gate.timeoutMinutes * 60_000, echo });
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

export async function runSubsystemGate(
  paths: AidlcPaths,
  config: AidlcConfig,
  echo = false,
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
  const cases = JSON.parse(readFileSync(paths.subsystemCases, 'utf8')) as SubsystemCaseFile;
  // Expected values come from humans. Any drift from the snapshot is tampering, not a fix.
  const snapshotHash = readBaseline(paths)?.subsystemCasesSha256;
  const actualHash = hashCases(cases.cases);
  if (actualHash !== cases.casesSha256 || (snapshotHash && snapshotHash !== actualHash)) {
    return fail('Expected values were modified', [
      {
        where: rel(paths.root, paths.subsystemCases),
        message:
          'subsystem-cases.json differs from the Excel snapshot. Never edit expected values; regenerate with `npm run aidlc:parse-excel`.',
      },
    ]);
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
  const reportFile = path.join(paths.root, gate.reportFile);
  rmSync(reportFile, { force: true });
  const r = await exec(gate.command, {
    cwd: paths.root,
    timeoutMs: gate.timeoutMinutes * 60_000,
    echo,
    env: { PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile },
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
    if (bad.length === 0) {
      passedCases++;
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
        await runBoundaryGuard(paths, { baseline, revert: options.revertViolations ?? false })
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
              : await runSubsystemGate(paths, config, echo);
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
