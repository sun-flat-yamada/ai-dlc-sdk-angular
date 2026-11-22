import type { GateFailure } from './telemetry.js';
import { VERIFIED_ANNOTATION } from './subsystem-cases.js';
import { stripAnsi } from './exec.js';

const MAX_FAILURES = 40;

/** Angular CLI / esbuild / tsc errors: `✘ [ERROR] TS2322: ...` followed by `src/x.ts:12:4:`. */
export function parseBuildErrors(output: string): GateFailure[] {
  const lines = stripAnsi(output).split(/\r?\n/);
  const failures: GateFailure[] = [];
  for (let i = 0; i < lines.length && failures.length < MAX_FAILURES; i++) {
    const line = lines[i]!;
    const esbuild = /\[ERROR\]\s*(.+)$/.exec(line);
    const tsc = /^(.+?\.(?:ts|html|scss|css))\((\d+),(\d+)\):\s*error\s+(TS\d+:.+)$/.exec(line);
    if (tsc) {
      failures.push({ where: `${tsc[1]}:${tsc[2]}:${tsc[3]}`, message: tsc[4]!.trim() });
    } else if (esbuild) {
      let where = '';
      for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
        const loc = /^\s*(\S+?\.(?:ts|html|scss|css)):(\d+):(\d+):?\s*$/.exec(lines[j]!);
        if (loc) {
          where = `${loc[1]}:${loc[2]}:${loc[3]}`;
          break;
        }
      }
      const message = esbuild[1]!.replace(/\s*\[plugin [^\]]+\]\s*$/, '').trim();
      failures.push({
        where:
          where || (/exceeded maximum budget/i.test(message) ? 'angular.json budgets' : 'build'),
        message,
      });
    }
  }
  return failures;
}

/** ESLint "stylish" output: a file path line followed by `  12:5  error  message  rule`. */
export function parseLintErrors(output: string): {
  failures: GateFailure[];
  errors: number;
  warnings: number;
} {
  const lines = stripAnsi(output).split(/\r?\n/);
  const failures: GateFailure[] = [];
  let file = '';
  let errors = 0;
  let warnings = 0;
  for (const line of lines) {
    const entry = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)\s{2,}(\S+)\s*$/.exec(line);
    if (entry) {
      if (entry[3] === 'error') {
        errors++;
        if (failures.length < MAX_FAILURES) {
          failures.push({
            where: `${file}:${entry[1]}:${entry[2]}`,
            message: `${entry[4]} (${entry[5]})`,
          });
        }
      } else {
        warnings++;
      }
      continue;
    }
    if (/^\S.*\.(ts|html|js)$/.test(line.trim()) && !line.startsWith(' ')) {
      file = line.trim();
    }
  }
  const summary = /(\d+) problems? \((\d+) errors?, (\d+) warnings?\)/.exec(stripAnsi(output));
  if (summary) {
    errors = Number(summary[2]);
    warnings = Number(summary[3]);
  }
  return { failures, errors, warnings };
}

/** Vitest default reporter: `FAIL  src/x.spec.ts > Suite > case` blocks with the assertion message. */
export function parseVitestFailures(output: string): GateFailure[] {
  const lines = stripAnsi(output).split(/\r?\n/);
  const failures: GateFailure[] = [];
  for (let i = 0; i < lines.length && failures.length < MAX_FAILURES; i++) {
    const m = /^\s*FAIL\s+(.+)$/.exec(lines[i]!);
    if (!m) continue;
    let message = '';
    for (let j = i + 1; j < Math.min(lines.length, i + 12); j++) {
      const l = lines[j]!.trim();
      if (/^(AssertionError|Error|TypeError|ReferenceError|Expected|Received|expected)/.test(l)) {
        message = message ? `${message} / ${l}` : l;
        if (message.length > 300) break;
      }
      if (/^\s*FAIL\s+/.test(lines[j]!)) break;
    }
    failures.push({ where: m[1]!.trim(), message: message || 'test failed' });
  }
  return failures;
}

export interface CoverageSummary {
  statements: number;
  branches: number;
  functions: number;
  lines: number;
}

/** Reads `coverage-summary.json` (istanbul json-summary) percentages. */
export function parseCoverageSummary(json: string): CoverageSummary {
  const total = (JSON.parse(json) as { total: Record<string, { pct: number | string }> }).total;
  const pct = (k: string) => {
    const v = total[k]?.pct;
    return typeof v === 'number' ? v : 100; // "Unknown" when there is nothing to cover
  };
  return {
    statements: pct('statements'),
    branches: pct('branches'),
    functions: pct('functions'),
    lines: pct('lines'),
  };
}

/** Result of one Playwright test, flattened from the JSON reporter. */
export interface PlaywrightTestResult {
  title: string;
  file: string;
  status: 'passed' | 'failed' | 'skipped' | 'timedOut' | 'interrupted' | 'flaky';
  error?: string;
  /** `aidlc-verified` annotations: `<case ID>:<api|css|ui>:<index>` of every verified expectation. */
  verified?: string[];
  /** Playwright project (`mutant-<kind>` in mutation runs). */
  project?: string;
  /** Every annotation of the last result, deduplicated. */
  annotations?: { type: string; description: string }[];
}

interface PwSuite {
  title?: string;
  file?: string;
  specs?: {
    title: string;
    file?: string;
    tests?: {
      status?: string;
      projectName?: string;
      annotations?: { type: string; description?: string }[];
      results?: {
        status?: string;
        error?: { message?: string };
        annotations?: { type: string; description?: string }[];
      }[];
    }[];
  }[];
  suites?: PwSuite[];
}

export function parsePlaywrightReport(json: string): PlaywrightTestResult[] {
  const report = JSON.parse(json) as { suites?: PwSuite[] };
  const out: PlaywrightTestResult[] = [];
  const walk = (suite: PwSuite, prefix: string[]) => {
    const titles = suite.title ? [...prefix, suite.title] : prefix;
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const results = t.results ?? [];
        const last = results[results.length - 1];
        let status: PlaywrightTestResult['status'];
        if (t.status === 'skipped' || last?.status === 'skipped') status = 'skipped';
        else if (t.status === 'flaky') status = 'flaky';
        else if (t.status === 'expected') status = 'passed';
        else status = (last?.status as PlaywrightTestResult['status']) ?? 'failed';
        if (status === 'passed' && t.status === 'unexpected') status = 'failed';
        const error = results.map((r) => r.error?.message).find(Boolean);
        const verified = [
          ...new Set(
            [...(t.annotations ?? []), ...(last?.annotations ?? [])]
              .filter((a) => a.type === VERIFIED_ANNOTATION && a.description)
              .map((a) => a.description!),
          ),
        ];
        out.push({
          title: [...titles.slice(1), spec.title].join(' > '),
          file: spec.file ?? suite.file ?? '',
          status,
          ...(error ? { error: stripAnsi(error).split('\n').slice(0, 6).join('\n') } : {}),
          ...(verified.length ? { verified } : {}),
          ...(t.projectName ? { project: t.projectName } : {}),
          annotations: [
            ...new Map(
              [...(t.annotations ?? []), ...(last?.annotations ?? [])]
                .filter((a) => a.description !== undefined)
                .map((a) => [
                  `${a.type}\u0000${a.description}`,
                  { type: a.type, description: a.description! },
                ]),
            ).values(),
          ],
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child, titles);
  };
  for (const s of report.suites ?? []) walk(s, []);
  return out;
}

/** Extracts `[CASE-ID]` tags from a test title. */
export function caseIdsInTitle(title: string): string[] {
  return [...title.matchAll(/\[([A-Za-z0-9][\w.-]*)\]/g)].map((m) => m[1]!);
}
