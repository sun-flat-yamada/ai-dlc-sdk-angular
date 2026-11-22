import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

/** A command line as an argument vector. The first element is the executable. */
const commandSchema = z.array(z.string().min(1)).min(1);

const gateSchema = z.object({
  enabled: z.boolean().default(true),
  command: commandSchema,
  timeoutMinutes: z.number().positive().default(20),
});

const sandboxDefaults = {
  enforce: 'strict' as const,
  kind: 'devcontainer',
  requireEgressFirewall: true,
  forbidHostCredentialBridges: true,
  egressProbeHost: 'example.com',
};

const coverageSchema = z.object({
  summaryFile: z.string(),
  thresholds: z
    .object({
      statements: z.number().min(0).max(100).default(0),
      branches: z.number().min(0).max(100).default(0),
      functions: z.number().min(0).max(100).default(0),
      lines: z.number().min(0).max(100).default(0),
    })
    .default({ statements: 0, branches: 0, functions: 0, lines: 0 }),
});

export const configSchema = z.object({
  version: z.literal(1),
  project: z.object({
    name: z.string(),
    angularProject: z.string(),
    /** Base branch / ref used as the boundary baseline when no snapshot exists. */
    baseRef: z.string().default('HEAD'),
  }),
  output: z
    .object({
      /** Language of generated human-facing documents (reverse docs, reports). */
      language: z.enum(['ja', 'en']).default('ja'),
    })
    .default({ language: 'ja' }),
  /** Isolated execution environment that every aidlc:* command must run in (see docs/sandbox.md). */
  sandbox: z
    .object({
      /** strict: every aidlc:* command; agent: only Copilot CLI / gate execution; off: no check. */
      enforce: z.enum(['strict', 'agent', 'off']).default(sandboxDefaults.enforce),
      /** Expected value of AIDLC_SANDBOX (set by .devcontainer/devcontainer.json). */
      kind: z.string().min(1).default(sandboxDefaults.kind),
      /** Require the default-deny egress firewall of the sandbox to be active. */
      requireEgressFirewall: z.boolean().default(sandboxDefaults.requireEgressFirewall),
      /** Refuse to run while host credentials (SSH agent, VS Code git helper) are forwarded. */
      forbidHostCredentialBridges: z.boolean().default(sandboxDefaults.forbidHostCredentialBridges),
      /** Host outside the allow-list; a TCP connection to it must be refused. Empty = no probe. */
      egressProbeHost: z.string().default(sandboxDefaults.egressProbeHost),
    })
    .default(sandboxDefaults),
  loop: z.object({
    maxIterations: z.number().int().min(1).max(50),
    autoRevertBoundaryViolations: z.boolean().default(true),
    /** Require a clean git working tree before a full loop starts. */
    requireCleanWorkingTree: z.boolean().default(true),
    /**
     * Git-ignored directories the boundary guard cannot see (lib/dependency-guard.ts). They are
     * fingerprinted before the first agent call; any change fails Gate 1 and is rebuilt.
     */
    dependencyGuard: z
      .object({
        enabled: z.boolean().default(true),
        paths: z.array(z.string().min(1)).default(['node_modules']),
        /** Rebuilds the guarded directories from the lockfile after a violation. Empty = report only. */
        restoreCommand: z
          .array(z.string().min(1))
          .default(['npm', 'ci', '--no-audit', '--no-fund']),
        restoreTimeoutMinutes: z.number().positive().default(20),
        /** Build caches deleted before the gates run. */
        clearBeforeGates: z.array(z.string().min(1)).default(['.angular/cache']),
      })
      .prefault({}),
  }),
  copilot: z.object({
    command: z.string().min(1),
    /** Argument template. Placeholders: {prompt} {promptFile} {model} {usageFile} {transcriptFile} {logDir}. */
    args: z.array(z.string()),
    model: z.string().default('auto'),
    timeoutMinutes: z.number().positive().default(60),
    /** Short instruction passed with -p; the full context lives in {promptFile}. */
    promptTemplate: z.string(),
  }),
  gates: z.object({
    build: gateSchema,
    lint: gateSchema,
    unit: gateSchema.extend({ coverage: coverageSchema.optional() }),
    subsystem: gateSchema.extend({
      /** Playwright JSON reporter output. */
      reportFile: z.string(),
      /** Every Excel case must be covered by exactly-titled tests (`[<caseId>]`). */
      requireAllCasesCovered: z.boolean().default(true),
      /** Required ratio of passed cases (0..1). */
      minPassRate: z.number().min(0).max(1).default(1),
      /**
       * Every expectation of every case (expectedApi, expectedCss, expectedUi) must have been verified
       * through the subsystem kit (expectApiRequests, expectCss, expectUi) in a passing test.
       */
      requireVerifiedExpectations: z.boolean().default(true),
    }),
  }),
  excel: z
    .object({
      /** Sheets to read. Empty = every sheet that has a recognizable header row. */
      sheets: z.array(z.string()).default([]),
      /** Extra header aliases per field (merged with the built-in English / Japanese aliases). */
      headerAliases: z.record(z.string(), z.array(z.string())).default({}),
    })
    .default({ sheets: [], headerAliases: {} }),
  qcd: z.object({
    currency: z.string().default('JPY'),
    /** Hourly cost of an engineer, used for both the human baseline and AI-DLC human effort. */
    humanHourlyRate: z.number().nonnegative(),
    /** Cost of one Copilot AI credit in `currency` (set from your billing contract). */
    aiCreditUnitCost: z.number().nonnegative(),
    /** Cost of one premium request in `currency` when AI credits are not reported. */
    premiumRequestUnitCost: z.number().nonnegative().default(0),
    /** Human effort spent on the AI-DLC run (placing inputs, reviewing outputs), in hours. */
    aiDlcHumanHours: z
      .object({
        inputPreparation: z.number().nonnegative().default(0),
        review: z.number().nonnegative().default(0),
        other: z.number().nonnegative().default(0),
      })
      .default({ inputPreparation: 0, review: 0, other: 0 }),
  }),
});

export type AidlcConfig = z.infer<typeof configSchema>;
export type GateConfig = z.infer<typeof gateSchema>;

/** Repository-relative locations of the harness. */
export interface AidlcPaths {
  root: string;
  aidlc: string;
  config: string;
  boundaryPolicy: string;
  inputs: {
    requirements: string;
    uiDesign: string;
    apiSpecs: string;
    subsystemTests: string;
    humanBaseline: string;
    uiBindings: string;
  };
  references: string;
  skills: string;
  outputs: {
    root: string;
    generatedTests: string;
    reverseDocs: string;
    telemetry: string;
    reports: string;
  };
  runHistory: string;
  subsystemCases: string;
}

export function resolvePaths(root: string): AidlcPaths {
  const aidlc = path.join(root, '.ai-dlc');
  const outputs = path.join(aidlc, 'outputs');
  const inputs = path.join(aidlc, 'inputs');
  return {
    root,
    aidlc,
    config: path.join(aidlc, 'config', 'aidlc.config.yaml'),
    boundaryPolicy: path.join(aidlc, 'config', 'boundary-policy.yaml'),
    inputs: {
      requirements: path.join(inputs, 'requirements'),
      uiDesign: path.join(inputs, 'ui-design'),
      apiSpecs: path.join(inputs, 'api-specs'),
      subsystemTests: path.join(inputs, 'subsystem-tests'),
      humanBaseline: path.join(inputs, 'human-baseline'),
      uiBindings: path.join(inputs, 'ui-bindings'),
    },
    references: path.join(aidlc, 'references'),
    skills: path.join(root, '.github', 'skills'),
    outputs: {
      root: outputs,
      generatedTests: path.join(outputs, 'generated-tests'),
      reverseDocs: path.join(outputs, 'reverse-docs'),
      telemetry: path.join(outputs, 'telemetry'),
      reports: path.join(outputs, 'reports'),
    },
    runHistory: path.join(outputs, 'telemetry', 'run-history.json'),
    subsystemCases: path.join(outputs, 'generated-tests', 'subsystem-cases.json'),
  };
}

/** Finds the repository root: the nearest ancestor that contains `.ai-dlc/config`. */
export function findRepoRoot(start: string = process.cwd()): string {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, '.ai-dlc', 'config'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        `.ai-dlc/config not found above ${start}. Run the tools from the repository.`,
      );
    }
    dir = parent;
  }
}

export function parseConfig(text: string, source = 'aidlc.config.yaml'): AidlcConfig {
  const result = configSchema.safeParse(parse(text));
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid ${source}:\n${issues}`);
  }
  return result.data;
}

export function loadConfig(file: string): AidlcConfig {
  return parseConfig(readFileSync(file, 'utf8'), file);
}
