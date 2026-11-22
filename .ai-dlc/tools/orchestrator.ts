/**
 * AI-DLC orchestrator: drives GitHub Copilot CLI through a bounded self-healing loop.
 *
 *   npm run aidlc:init-check                                   # --mode validate-env
 *   npm run aidlc:run -- --max-iterations 5                    # --mode full-loop
 *   npm run aidlc:run -- --max-iterations 3 --dry-run          # no Copilot call, no gate commands
 *   npm run aidlc:reverse-doc                                  # --mode reverse-doc
 *
 * Options
 *   --max-iterations <N>   override loop.maxIterations
 *   --dry-run              do not call Copilot CLI; gates 2-4 are reported as skipped
 *   --skip-post            do not generate reverse docs / QCD report
 *   --allow-dirty          start even when the working tree has uncommitted changes
 *   --no-revert            report boundary violations without reverting them
 *   --simulate-pass-at <k> (dry-run only) treat iteration k as passing, to exercise early exit
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { recordBaseline } from './boundary-guard.js';
import { callCopilot, probeCopilot } from './copilot-cli-adapter.js';
import { convertWorkbooks, findWorkbooks } from './excel-to-test-ast.js';
import { allGatesPassed, runGates } from './gate-runner.js';
import { inputsGate, renderBindingMatrix, validateInputs } from './validate-inputs.js';
import { writeQcdReport } from './qcd-calculator.js';
import { BoundaryClassifier, evaluateChanges, loadBoundaryPolicy } from './lib/boundary.js';
import { AidlcConfig, AidlcPaths, findRepoRoot, loadConfig, resolvePaths } from './lib/config.js';
import { exec } from './lib/exec.js';
import {
  SandboxProbe,
  detectSandbox,
  enforceSandbox,
  sandboxPolicy,
  sandboxViolations,
} from './lib/sandbox.js';
import { DependencyGuard } from './lib/dependency-guard.js';
import { Git } from './lib/git.js';
import { RepositoryGuard } from './lib/repository-guard.js';
import { PostProcessGuard, PostProcessScope } from './lib/post-process-guard.js';
import { isMain, log, rel, runCli } from './lib/cli.js';
import {
  SKILLS,
  buildFixPrompt,
  buildImplementPrompt,
  buildQcdPrompt,
  buildReverseDocPrompt,
} from './lib/prompts.js';
import { collectFacts } from './lib/reverse-doc-facts.js';
import { renderReverseDocs } from './lib/reverse-doc-render.js';
import {
  CopilotCallRecord,
  GateResult,
  IterationRecord,
  RunRecord,
  newRunId,
  upsertRun,
  writeJsonAtomic,
} from './lib/telemetry.js';

export type Mode = 'validate-env' | 'full-loop' | 'reverse-doc';

export interface OrchestratorOptions {
  mode: Mode;
  maxIterations?: number;
  dryRun: boolean;
  skipPost: boolean;
  allowDirty: boolean;
  revert: boolean;
  simulatePassAt?: number;
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** Required checks fail validate-env; optional ones only warn. */
  required: boolean;
}

/** Sandbox status as environment checks (required only where `sandbox.enforce` blocks the run). */
export async function sandboxChecks(
  config: AidlcConfig,
  dryRun: boolean,
  probe?: SandboxProbe,
): Promise<Check[]> {
  const policy = sandboxPolicy(config);
  const status = await detectSandbox(
    { kind: config.sandbox.kind, egressProbeHost: config.sandbox.egressProbeHost },
    probe,
  );
  const blocking = new Set(sandboxViolations(status, policy, dryRun ? 'tool' : 'agent'));
  const required = (problem: string | undefined) => problem !== undefined && blocking.has(problem);
  const declaredProblem = status.problems.find((p) => p.includes('AIDLC_SANDBOX'));
  const containerProblem = status.problems.find((p) => p.includes('container runtime'));
  const firewallProblem = [...blocking].find((p) => p.startsWith('egress'));
  return [
    {
      name: `Sandbox (enforce: ${policy.enforce})`,
      ok: !declaredProblem,
      detail: declaredProblem ?? `AIDLC_SANDBOX=${status.declared}`,
      required: required(declaredProblem),
    },
    {
      name: 'Sandbox container runtime',
      ok: status.container,
      detail: containerProblem ?? 'container marker found',
      required: required(containerProblem),
    },
    {
      name: 'Sandbox egress firewall',
      ok: status.firewall === 'enforced' && status.egress !== 'open',
      detail: `marker: ${status.firewall}, probe ${config.sandbox.egressProbeHost || '(none)'}: ${status.egress}`,
      required: required(firewallProblem),
    },
    {
      name: 'Sandbox host credential bridges',
      ok: status.credentialBridges.length === 0,
      detail: status.credentialBridges.join('; ') || 'none',
      required: status.credentialBridges.some((b) => blocking.has(b)),
    },
  ];
}

export async function validateEnvironment(
  paths: AidlcPaths,
  config: AidlcConfig,
  dryRun: boolean,
  probe?: SandboxProbe,
): Promise<Check[]> {
  const checks: Check[] = await sandboxChecks(config, dryRun, probe);
  const add = (name: string, ok: boolean, detail: string, required = true) =>
    checks.push({ name, ok, detail, required });
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  add(
    'Node.js',
    major >= 26 || (major === 24 && minor >= 15) || (major === 22 && minor >= 22),
    process.versions.node,
  );
  const git = new Git(paths.root);
  const isRepo = await git.isRepository();
  add('Git repository', isRepo, paths.root);
  let head = '';
  try {
    head = isRepo ? await git.head() : '';
  } catch {
    head = '';
  }
  add(
    'Git baseline commit',
    head !== '',
    head ? head.slice(0, 12) : 'no commit yet — commit the repository first',
  );
  try {
    loadBoundaryPolicy(paths.boundaryPolicy);
    add('boundary-policy.yaml', true, rel(paths.root, paths.boundaryPolicy));
  } catch (e) {
    add('boundary-policy.yaml', false, (e as Error).message);
  }
  for (const skill of Object.values(SKILLS)) {
    const file = path.join(paths.skills, skill, 'SKILL.md');
    add(`Skill ${skill}`, existsSync(file), rel(paths.root, file));
  }
  const workbooks = findWorkbooks(paths.inputs.subsystemTests);
  add(
    'Subsystem test workbooks',
    workbooks.length > 0,
    workbooks.map((w) => rel(paths.root, w)).join(', ') || 'no *.xlsx in inputs/subsystem-tests',
  );
  add(
    'Human baseline',
    existsSync(path.join(paths.inputs.humanBaseline, 'human-qcd.json')),
    'inputs/human-baseline/human-qcd.json',
    false,
  );
  for (const [name, dir] of Object.entries({
    requirements: paths.inputs.requirements,
    'ui-design': paths.inputs.uiDesign,
    'api-specs': paths.inputs.apiSpecs,
    'ui-bindings': paths.inputs.uiBindings,
  })) {
    add(`Inputs: ${name}`, existsSync(dir), rel(paths.root, dir));
  }
  const copilot = await probeCopilot(paths, config);
  add(
    'GitHub Copilot CLI',
    copilot.ok,
    copilot.ok
      ? copilot.version
      : `"${config.copilot.command}" not found — npm install -g @github/copilot`,
    !dryRun,
  );
  const ng = await exec(['npx', '--no-install', 'ng', 'version'], {
    cwd: paths.root,
    timeoutMs: 120_000,
  });
  add(
    'Angular CLI',
    ng.exitCode === 0,
    ng.exitCode === 0
      ? (/Angular CLI\s*:\s*(\S+)/.exec(ng.output)?.[1] ?? 'installed')
      : 'run npm install',
    !dryRun,
  );
  const pw = await exec(['npx', '--no-install', 'playwright', '--version'], {
    cwd: paths.root,
    timeoutMs: 120_000,
  });
  add('Playwright', pw.exitCode === 0, pw.output.trim().split(/\r?\n/)[0] ?? '', !dryRun);
  return checks;
}

function printChecks(checks: Check[]): boolean {
  for (const c of checks) {
    const mark = c.ok ? 'OK  ' : c.required ? 'FAIL' : 'WARN';
    log.info(`[${mark}] ${c.name.padEnd(36)} ${c.detail}`);
  }
  return checks.every((c) => c.ok || !c.required);
}

function simulatedPass(gates: GateResult[]): GateResult[] {
  return gates.map((g) =>
    g.status === 'skipped' ? { ...g, status: 'pass', summary: 'Simulated pass (dry-run)' } : g,
  );
}

function renderFailures(iteration: IterationRecord): string {
  const lines = [`# Iteration ${iteration.index} — gate results`, ''];
  for (const g of iteration.gates) {
    lines.push(`## ${g.gate}: ${g.status.toUpperCase()} — ${g.summary}`, '');
    for (const f of g.failures) lines.push(`- \`${f.where}\` — ${f.message.replace(/\n/g, ' ')}`);
    lines.push('');
  }
  return lines.join('\n');
}

export function renderFinalGateReport(run: RunRecord): string {
  const gateNames = ['inputs', 'boundary', 'build', 'lint', 'unit', 'subsystem'] as const;
  const lines = [
    '# Final quality gate report',
    '',
    `- Run: \`${run.runId}\`${run.dryRun ? ' (dry-run)' : ''}`,
    `- Result: **${run.result.toUpperCase()}** after ${run.iterations.length} / ${run.maxIterations} iteration(s)`,
    `- Baseline: \`${run.baseline ?? 'n/a'}\``,
    '',
    `| Iteration | ${gateNames.join(' | ')} |`,
    `| --- | ${gateNames.map(() => '---').join(' | ')} |`,
  ];
  for (const it of run.iterations) {
    const cell = (name: (typeof gateNames)[number]) => {
      const g = it.gates.find((x) => x.gate === name);
      if (!g) return '—';
      const icon = g.status === 'pass' ? '✅' : g.status === 'fail' ? '❌' : '⏭';
      return `${icon} ${g.summary.replace(/\|/g, '\\|')}`;
    };
    lines.push(`| ${it.index} | ${gateNames.map(cell).join(' | ')} |`);
  }
  return `${lines.join('\n')}\n`;
}

function renderUnresolved(run: RunRecord): string {
  const last = run.iterations[run.iterations.length - 1];
  const lines = [
    '# Unresolved issues',
    '',
    `The loop stopped after reaching the iteration limit (${run.maxIterations}) without passing every gate.`,
    'A human should review the items below. Re-run with a higher `--max-iterations` only after the root cause is understood.',
    '',
  ];
  for (const g of last?.gates ?? []) {
    if (g.status === 'pass') continue;
    lines.push(`## ${g.gate}: ${g.status.toUpperCase()} — ${g.summary}`, '');
    for (const f of g.failures)
      lines.push(`- [ ] \`${f.where}\` — ${f.message.replace(/\n/g, ' ')}`);
    lines.push('');
  }
  return lines.join('\n');
}

export interface PostProcessOptions {
  dryRun: boolean;
  /** Restore changes made outside the allowed paths (off with --no-revert or in a dry-run). */
  revert: boolean;
  dependencies?: DependencyGuard;
}

/**
 * Runs one post-process Copilot call under the post-process guard: anything written outside `scope`
 * is restored and recorded as a violation on the call record.
 */
async function guardedCall(
  paths: AidlcPaths,
  config: AidlcConfig,
  request: Parameters<typeof callCopilot>[2],
  scope: PostProcessScope,
  options: PostProcessOptions,
): Promise<CopilotCallRecord> {
  const workDir = rel(paths.root, request.workDir);
  const guard = new PostProcessGuard(
    paths,
    { ...scope, allowed: [...scope.allowed, workDir] },
    options.dependencies,
  );
  await guard.capture();
  const record = await callCopilot(paths, config, request);
  const violations = await guard.verify(options.revert);
  if (violations.length) {
    record.violations = violations;
    log.warn(
      `Post-process ${request.id}: ${violations.length} boundary violation(s)${options.revert ? ' — restored' : ''}`,
    );
    for (const v of violations) log.warn(`  ${v.where}: ${v.message}`);
  }
  return record;
}

async function postProcess(
  paths: AidlcPaths,
  config: AidlcConfig,
  run: RunRecord,
  workDir: string,
  options: PostProcessOptions,
): Promise<void> {
  const { dryRun } = options;
  const git = new Git(paths.root);
  const policy = loadBoundaryPolicy(paths.boundaryPolicy);
  const changes = run.baseline ? await git.changesSince(run.baseline) : [];
  const facts = collectFacts(paths, policy, run.baseline, changes);
  const factsFile = path.join(paths.outputs.reverseDocs, 'reverse-doc-facts.json');
  writeJsonAtomic(factsFile, facts);
  const gateStatus =
    run.mode === 'reverse-doc'
      ? 'n/a (reverse-doc mode)'
      : `${run.result} (${run.iterations.length}/${run.maxIterations} iterations)`;
  const input = validateInputs(paths);
  const bindingMatrix = input.bindings
    ? renderBindingMatrix(input.bindings, input.operations).replace(/^# .*\n/, '')
    : '_(ui-bindings.yaml not available)_';
  const docs = renderReverseDocs(
    path.join(paths.skills, SKILLS.reverseDoc, 'templates'),
    paths.outputs.reverseDocs,
    facts,
    gateStatus,
    {
      bindingMatrix,
    },
  );
  log.info(`Reverse docs (facts pre-filled): ${docs.map((d) => rel(paths.root, d)).join(', ')}`);
  run.postProcess.push(
    await guardedCall(
      paths,
      config,
      {
        id: 'post-reverse-doc',
        phase: 'reverse-doc',
        skills: [SKILLS.reverseDoc],
        prompt: buildReverseDocPrompt(paths, config, factsFile),
        workDir,
        dryRun,
      },
      { allowed: [rel(paths.root, paths.outputs.reverseDocs)] },
      options,
    ),
  );
  upsertRun(paths.runHistory, run);
  if (run.mode !== 'full-loop') return;
  if (!existsSync(path.join(paths.inputs.humanBaseline, 'human-qcd.json'))) {
    log.warn('human-qcd.json not found — QCD report skipped');
    return;
  }
  // Close the run before measuring lead time so the report includes the reverse-doc phase.
  run.endedAt = new Date().toISOString();
  upsertRun(paths.runHistory, run);
  const { md } = writeQcdReport(paths, config, run.runId);
  log.info(`QCD report: ${rel(paths.root, md)}`);
  // The report may only grow (the Interpretation section); qcd-comparison-report.json stays read-only.
  const mdPath = rel(paths.root, md);
  run.postProcess.push(
    await guardedCall(
      paths,
      config,
      {
        id: 'post-qcd',
        phase: 'qcd',
        skills: [SKILLS.qcd],
        prompt: buildQcdPrompt(paths, config, md),
        workDir,
        dryRun,
      },
      { allowed: [mdPath], appendOnly: [mdPath] },
      options,
    ),
  );
}

export async function runFullLoop(
  paths: AidlcPaths,
  config: AidlcConfig,
  options: OrchestratorOptions,
): Promise<RunRecord> {
  const maxIterations = options.maxIterations ?? config.loop.maxIterations;
  const git = new Git(paths.root);
  if (!(await git.isRepository()))
    throw new Error('Not a git repository: the boundary guard needs git.');
  try {
    await git.head();
  } catch {
    throw new Error(
      'The repository has no commit yet. Commit it first: the boundary guard compares against HEAD.',
    );
  }
  const dirty = await git.statusLines();
  if (
    dirty.length &&
    config.loop.requireCleanWorkingTree &&
    !options.allowDirty &&
    !options.dryRun
  ) {
    throw new Error(
      `Working tree has ${dirty.length} uncommitted change(s). Commit or stash them, or pass --allow-dirty.`,
    );
  }
  const policy = loadBoundaryPolicy(paths.boundaryPolicy);
  const runId = newRunId();
  const workDir = path.join(paths.outputs.telemetry, runId);
  mkdirSync(workDir, { recursive: true });

  log.step('Prepare: parse Excel subsystem tests and snapshot the baseline');
  const cases = await convertWorkbooks(paths, config);
  log.info(`${cases.cases.length} subsystem case(s), ${cases.warnings.length} warning(s)`);
  const inputs = inputsGate(paths);
  for (const f of inputs.failures) log.warn(`${f.where}: ${f.message}`);
  log.info(`Gate 0 (inputs): ${inputs.summary}`);
  if (inputs.status === 'fail') {
    throw new Error(
      'Inputs are inconsistent (Gate 0). Fix ui-bindings.yaml / design HTML / OpenAPI / Excel before running the AI loop.',
    );
  }
  const baseline = await recordBaseline(paths, 'HEAD', cases.casesSha256);
  // git cannot see node_modules: fingerprint it now, in memory, before the agent can touch it.
  const dependencies = DependencyGuard.fromConfig(paths.root, config);
  dependencies?.capture();
  // The agent can write .git/ through node/npm/npx: capture its metadata and refs the same way.
  const repository = new RepositoryGuard(paths.root);
  await repository.capture();
  log.info(
    `Baseline ${baseline.sha.slice(0, 12)} (${dirty.length ? `${dirty.length} pre-existing uncommitted change(s) count as changes` : 'clean tree'})`,
  );

  const run: RunRecord = {
    runId,
    mode: 'full-loop',
    startedAt: new Date().toISOString(),
    dryRun: options.dryRun,
    maxIterations,
    baseline: baseline.sha,
    result: 'running',
    iterations: [],
    postProcess: [],
  };
  upsertRun(paths.runHistory, run);

  // The mutation check runs once: when Gate 4 first passes with the tests written for this run.
  let mutationVerified = false;
  try {
    let previous: GateResult[] = [];
    for (let i = 1; i <= maxIterations; i++) {
      log.step(`Iteration ${i} / ${maxIterations}`);
      const iteration: IterationRecord = {
        index: i,
        startedAt: new Date().toISOString(),
        copilotCalls: [],
        gates: [],
        passed: false,
      };
      run.iterations.push(iteration);
      const ctx = {
        paths,
        config,
        policy,
        iteration: i,
        maxIterations,
        caseCount: cases.cases.length,
      };
      const iterDir = path.join(workDir, `iter-${i}`);
      iteration.copilotCalls.push(
        await callCopilot(paths, config, {
          id: i === 1 ? 'implement' : 'fix',
          phase: i === 1 ? 'implement' : 'fix',
          skills: i === 1 ? [SKILLS.context, SKILLS.gate, SKILLS.implement] : [SKILLS.fix],
          prompt: i === 1 ? buildImplementPrompt(ctx) : buildFixPrompt(ctx, previous),
          workDir: iterDir,
          dryRun: options.dryRun,
        }),
      );
      let gates = await runGates(paths, config, {
        dryRun: options.dryRun,
        // A dry-run calls no agent, so every change belongs to the developer: report, never revert.
        revertViolations:
          options.revert && config.loop.autoRevertBoundaryViolations && !options.dryRun,
        baseline: baseline.sha,
        // Gate 4 trusts this in-memory hash, never files the agent can rewrite.
        expectedCasesSha256: cases.casesSha256,
        ...(dependencies ? { dependencies } : {}),
        repository,
        mutationCheck: !mutationVerified,
        echo: false,
      });
      if (options.dryRun && options.simulatePassAt === i) gates = simulatedPass(gates);
      iteration.gates = gates;
      if (gates.some((g) => g.gate === 'subsystem' && g.status === 'pass')) mutationVerified = true;
      iteration.passed = allGatesPassed(gates);
      iteration.endedAt = new Date().toISOString();
      writeFileSync(path.join(iterDir, 'gate-results.md'), renderFailures(iteration), 'utf8');
      upsertRun(paths.runHistory, run);
      previous = gates;
      if (iteration.passed) {
        log.info(`All gates passed at iteration ${i}.`);
        break;
      }
    }
    run.result = run.iterations[run.iterations.length - 1]?.passed ? 'passed' : 'exhausted';
    const report = evaluateChanges(
      new BoundaryClassifier(policy),
      baseline.sha,
      await git.changesSince(baseline.sha),
    );
    run.changeStats = report.stats;
    mkdirSync(paths.outputs.reports, { recursive: true });
    writeFileSync(
      path.join(paths.outputs.reports, 'final-quality-gate.md'),
      renderFinalGateReport(run),
      'utf8',
    );
    if (run.result === 'exhausted') {
      const file = path.join(paths.outputs.reports, 'unresolved-issues.md');
      writeFileSync(file, renderUnresolved(run), 'utf8');
      log.warn(`Iteration limit reached. Unresolved issues: ${rel(paths.root, file)}`);
    }
    upsertRun(paths.runHistory, run);
    if (!options.skipPost) {
      log.step('Post-process: reverse design documents and QCD report');
      await postProcess(paths, config, run, path.join(workDir, 'post'), {
        dryRun: options.dryRun,
        revert: options.revert && config.loop.autoRevertBoundaryViolations && !options.dryRun,
        ...(dependencies ? { dependencies } : {}),
      });
    }
  } catch (error) {
    run.result = 'error';
    run.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    run.endedAt ??= new Date().toISOString();
    upsertRun(paths.runHistory, run);
  }
  return run;
}

export async function runReverseDoc(
  paths: AidlcPaths,
  config: AidlcConfig,
  options: OrchestratorOptions,
): Promise<RunRecord> {
  const runId = newRunId();
  const git = new Git(paths.root);
  let baseline: string | null = null;
  try {
    baseline = await git.resolve(config.project.baseRef);
  } catch {
    baseline = null;
  }
  const run: RunRecord = {
    runId,
    mode: 'reverse-doc',
    startedAt: new Date().toISOString(),
    dryRun: options.dryRun,
    maxIterations: 0,
    baseline,
    result: 'running',
    iterations: [],
    postProcess: [],
  };
  try {
    const dependencies = DependencyGuard.fromConfig(paths.root, config);
    await postProcess(paths, config, run, path.join(paths.outputs.telemetry, runId, 'post'), {
      dryRun: options.dryRun,
      revert: options.revert && config.loop.autoRevertBoundaryViolations && !options.dryRun,
      ...(dependencies ? { dependencies } : {}),
    });
    run.result = 'passed';
  } catch (error) {
    run.result = 'error';
    run.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    run.endedAt = new Date().toISOString();
    upsertRun(paths.runHistory, run);
  }
  return run;
}

export function parseOptions(argv: string[]): OrchestratorOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      mode: { type: 'string', default: 'full-loop' },
      'max-iterations': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'skip-post': { type: 'boolean', default: false },
      'allow-dirty': { type: 'boolean', default: false },
      'no-revert': { type: 'boolean', default: false },
      'simulate-pass-at': { type: 'string' },
    },
  });
  const mode = values.mode as Mode;
  if (!['validate-env', 'full-loop', 'reverse-doc'].includes(mode)) {
    throw new Error(`Unknown --mode "${values.mode}". Use validate-env, full-loop or reverse-doc.`);
  }
  const toInt = (name: string, v: string | undefined) => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 50)
      throw new Error(`--${name} must be an integer between 1 and 50`);
    return n;
  };
  const maxIterations = toInt('max-iterations', values['max-iterations']);
  const simulatePassAt = toInt('simulate-pass-at', values['simulate-pass-at']);
  if (simulatePassAt !== undefined && !values['dry-run'])
    throw new Error('--simulate-pass-at requires --dry-run');
  return {
    mode,
    dryRun: values['dry-run'],
    skipPost: values['skip-post'],
    allowDirty: values['allow-dirty'],
    revert: !values['no-revert'],
    ...(maxIterations !== undefined ? { maxIterations } : {}),
    ...(simulatePassAt !== undefined ? { simulatePassAt } : {}),
  };
}

async function main(): Promise<number> {
  const options = parseOptions(process.argv.slice(2));
  const root = findRepoRoot();
  const paths = resolvePaths(root);
  const config = loadConfig(paths.config);
  if (options.mode === 'validate-env') {
    return printChecks(await validateEnvironment(paths, config, options.dryRun)) ? 0 : 1;
  }
  await enforceSandbox(config, `aidlc --mode ${options.mode}`, options.dryRun ? 'tool' : 'agent');
  if (options.mode === 'reverse-doc') {
    await runReverseDoc(paths, config, options);
    log.info(`Reverse docs: ${rel(root, paths.outputs.reverseDocs)}/`);
    return 0;
  }
  const checks = await validateEnvironment(paths, config, options.dryRun);
  if (!printChecks(checks)) throw new Error('Environment check failed (see above).');
  const run = await runFullLoop(paths, config, options);
  log.step(
    `Result: ${run.result.toUpperCase()} (${run.iterations.length}/${run.maxIterations} iterations)${run.dryRun ? ' [dry-run]' : ''}`,
  );
  log.info(`Telemetry: ${rel(root, paths.runHistory)}`);
  log.info(`Reports:   ${rel(root, paths.outputs.reports)}/`);
  if (options.dryRun) return 0;
  return run.result === 'passed' ? 0 : 1;
}

if (isMain(import.meta.url)) {
  runCli(main);
}
