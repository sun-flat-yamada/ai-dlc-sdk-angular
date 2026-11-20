import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Token / credit usage of one Copilot CLI call (from `--usage-output-file`). */
export interface UsageRecord {
  aiCredits?: number;
  premiumRequests?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheTokens?: number;
  reasoningTokens?: number;
}

export interface CopilotCallRecord {
  id: string;
  skills: string[];
  phase: 'implement' | 'fix' | 'reverse-doc' | 'qcd';
  startedAt: string;
  endedAt: string;
  durationMs: number;
  dryRun: boolean;
  exitCode: number;
  promptFile: string;
  promptChars: number;
  /** chars / 4 heuristic; replaced by `usage` when the CLI reports real numbers. */
  estimatedInputTokens: number;
  outputChars: number;
  estimatedOutputTokens: number;
  usage?: UsageRecord;
  changedFiles: string[];
  /** Post-process only: changes outside the paths the call may write (restored unless --no-revert). */
  violations?: GateFailure[];
}

export type GateName = 'inputs' | 'boundary' | 'build' | 'lint' | 'unit' | 'subsystem';
export type GateStatus = 'pass' | 'fail' | 'skipped';

export interface GateFailure {
  /** Short location such as `src/app/x.ts:12` or a test title. */
  where: string;
  message: string;
}

export interface GateResult {
  gate: GateName;
  status: GateStatus;
  durationMs: number;
  summary: string;
  failures: GateFailure[];
  metrics?: Record<string, number>;
  /** Tail of the raw tool output (for the fix prompt). */
  logTail?: string;
}

export interface IterationRecord {
  index: number;
  startedAt: string;
  endedAt?: string;
  copilotCalls: CopilotCallRecord[];
  gates: GateResult[];
  passed: boolean;
}

export interface RunRecord {
  runId: string;
  mode: 'full-loop' | 'reverse-doc';
  startedAt: string;
  endedAt?: string;
  dryRun: boolean;
  maxIterations: number;
  baseline: string | null;
  result: 'running' | 'passed' | 'exhausted' | 'error';
  error?: string;
  iterations: IterationRecord[];
  postProcess: CopilotCallRecord[];
  /** Lines added / deleted per boundary zone over the whole run. */
  changeStats?: Record<string, { files: number; added: number; deleted: number }>;
}

export interface RunHistory {
  schemaVersion: 1;
  runs: RunRecord[];
}

export function readRunHistory(file: string): RunHistory {
  if (!existsSync(file)) {
    return { schemaVersion: 1, runs: [] };
  }
  return JSON.parse(readFileSync(file, 'utf8')) as RunHistory;
}

/** Writes JSON atomically (temp file + rename) so an interrupted run never corrupts history. */
export function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temp, file);
}

/** Inserts or replaces a run (matched by `runId`) in the history file. */
export function upsertRun(file: string, run: RunRecord): void {
  const history = readRunHistory(file);
  const index = history.runs.findIndex((r) => r.runId === run.runId);
  if (index >= 0) {
    history.runs[index] = run;
  } else {
    history.runs.push(run);
  }
  writeJsonAtomic(file, history);
}

/** Sortable, filesystem-safe run id such as `20261119-053012`. */
export function newRunId(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

/** Rough token estimate used when the CLI does not report usage (≈4 chars per token). */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/**
 * Extracts usage numbers from the JSON written by `copilot --usage-output-file`.
 * The format is not a stable contract, so keys are matched loosely and summed across models / agents.
 */
export function parseUsageFile(text: string): UsageRecord | undefined {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  const totals: Required<UsageRecord> = {
    aiCredits: 0,
    premiumRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheTokens: 0,
    reasoningTokens: 0,
  };
  const keyMap: [RegExp, keyof UsageRecord][] = [
    [/^(ai_?credits?|aiCredits?|credits)$/i, 'aiCredits'],
    [/^premium_?requests?$/i, 'premiumRequests'],
    [/^input_?tokens?$/i, 'inputTokens'],
    [/^output_?tokens?$/i, 'outputTokens'],
    [/^cache(_?read|_?write|d)?_?tokens?$/i, 'cacheTokens'],
    [/^reasoning_?tokens?$/i, 'reasoningTokens'],
  ];
  const sum = (node: unknown, into: Required<UsageRecord>, depth = 0): boolean => {
    if (depth > 8 || node === null || typeof node !== 'object') return false;
    let found = false;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (typeof value === 'number') {
        const match = keyMap.find(([re]) => re.test(key));
        if (match) {
          into[match[1]] += value;
          found = true;
        }
      } else if (sum(value, into, depth + 1)) {
        found = true;
      }
    }
    return found;
  };
  // An explicit `total` / `totals` object wins over summing the per-model / per-agent breakdown.
  const findTotals = (node: unknown, depth = 0): unknown => {
    if (depth > 8 || node === null || typeof node !== 'object') return undefined;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (/^totals?$/i.test(key) && value && typeof value === 'object') return value;
    }
    for (const value of Object.values(node as Record<string, unknown>)) {
      const hit = findTotals(value, depth + 1);
      if (hit) return hit;
    }
    return undefined;
  };
  const explicit = findTotals(data);
  if (explicit && sum(explicit, totals)) {
    return totals;
  }
  return sum(data, totals) ? totals : undefined;
}
