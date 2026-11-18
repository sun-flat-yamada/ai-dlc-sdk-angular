import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { convertWorkbooks } from '../excel-to-test-ast.js';
import { parseOptions, runFullLoop, runReverseDoc } from '../orchestrator.js';
import { loadConfig, resolvePaths } from '../lib/config.js';
import { readRunHistory } from '../lib/telemetry.js';
import { buildSampleWorkbook } from '../samples/generate-sample-excel.js';
import { commitAll, copyHarness, git, tempRepo, write } from './helpers.js';

async function prepare() {
  const repo = tempRepo();
  copyHarness(repo.dir);
  const paths = resolvePaths(repo.dir);
  await (
    await buildSampleWorkbook()
  ).xlsx.writeFile(path.join(paths.inputs.subsystemTests, 'ST-NET-network-settings.xlsx'));
  write(
    repo.dir,
    'src/app/app.routes.ts',
    "export const routes = [\n  { path: '', loadComponent: () => import('./features/home/home-page') },\n];\n",
  );
  write(repo.dir, 'src/app/core/http/api-client.ts', '@Injectable()\nexport class ApiClient {}\n');
  commitAll(repo.dir);
  return { ...repo, paths, config: loadConfig(paths.config) };
}

describe('parseOptions', () => {
  it('parses modes and limits', () => {
    expect(
      parseOptions(['--mode', 'full-loop', '--max-iterations', '3', '--dry-run']),
    ).toMatchObject({ mode: 'full-loop', maxIterations: 3, dryRun: true, revert: true });
    expect(() => parseOptions(['--mode', 'nope'])).toThrow(/Unknown --mode/);
    expect(() => parseOptions(['--max-iterations', '0'])).toThrow(/between 1 and 50/);
    expect(() => parseOptions(['--simulate-pass-at', '2'])).toThrow(/requires --dry-run/);
  });
});

describe('runFullLoop (dry-run)', () => {
  let cleanup = () => {};
  afterEach(() => cleanup());

  it('runs N iterations, writes reports and telemetry when no gate can pass', async () => {
    const env = await prepare();
    cleanup = env.cleanup;
    const run = await runFullLoop(env.paths, env.config, {
      mode: 'full-loop',
      maxIterations: 3,
      dryRun: true,
      skipPost: false,
      allowDirty: false,
      revert: true,
    });

    expect(run.result).toBe('exhausted');
    expect(run.iterations).toHaveLength(3);
    expect(run.iterations[0]!.copilotCalls[0]).toMatchObject({
      id: 'implement',
      dryRun: true,
      skills: ['01-context-and-boundary', '02-angular-panel-impl', '03-excel-subsystem-gate'],
    });
    expect(run.iterations[1]!.copilotCalls[0]).toMatchObject({
      id: 'fix',
      skills: ['04-self-healing-fix'],
    });
    expect(run.iterations[0]!.gates.map((g) => `${g.gate}:${g.status}`)).toEqual([
      'inputs:pass',
      'boundary:pass',
      'build:skipped',
      'lint:skipped',
      'unit:skipped',
      'subsystem:skipped',
    ]);
    const reports = env.paths.outputs.reports;
    for (const f of [
      'final-quality-gate.md',
      'unresolved-issues.md',
      'qcd-comparison-report.md',
      'qcd-comparison-report.json',
      'binding-matrix.md',
    ]) {
      expect(existsSync(path.join(reports, f)), f).toBe(true);
    }
    expect(readdirSync(env.paths.outputs.reverseDocs).sort()).toEqual(
      [
        '.gitkeep',
        '01-reuse-and-delta-architecture.md',
        '02-panel-screen-and-state-spec.md',
        '03-rest-api-sequence-spec.md',
        '04-requirement-test-traceability.md',
        'reverse-doc-facts.json',
      ].filter(
        (f) => f !== '.gitkeep' || existsSync(path.join(env.paths.outputs.reverseDocs, '.gitkeep')),
      ),
    );
    const trace = readFileSync(
      path.join(env.paths.outputs.reverseDocs, '04-requirement-test-traceability.md'),
      'utf8',
    );
    expect(trace).toContain('`ST-NET-003`');
    expect(trace).toContain('`REQ-NET-006`');
    expect(trace).not.toContain('{{traceabilityTable}}');
    expect(readFileSync(path.join(reports, 'qcd-comparison-report.md'), 'utf8')).toContain(
      'dry-run',
    );
    const prompt = readFileSync(
      path.join(env.dir, run.iterations[1]!.copilotCalls[0]!.promptFile),
      'utf8',
    );
    expect(prompt).toContain('iteration 2 of 3: fix');
    expect(prompt).toContain('Gate `build`'.replace('Gate `build`', 'Gates not reached yet'));
    const history = readRunHistory(env.paths.runHistory);
    expect(history.runs.at(-1)).toMatchObject({ runId: run.runId, result: 'exhausted' });
    expect(history.runs.at(-1)!.postProcess.map((c) => c.id)).toEqual([
      'post-reverse-doc',
      'post-qcd',
    ]);
  });

  it('stops early when the gates pass (simulated)', async () => {
    const env = await prepare();
    cleanup = env.cleanup;
    const run = await runFullLoop(env.paths, env.config, {
      mode: 'full-loop',
      maxIterations: 5,
      dryRun: true,
      skipPost: true,
      allowDirty: false,
      revert: true,
      simulatePassAt: 2,
    });
    expect(run.result).toBe('passed');
    expect(run.iterations).toHaveLength(2);
    expect(existsSync(path.join(env.paths.outputs.reports, 'unresolved-issues.md'))).toBe(false);
  });

  it('refuses a dirty working tree for real runs', async () => {
    const env = await prepare();
    cleanup = env.cleanup;
    write(env.dir, 'scratch.txt', 'x');
    await expect(
      runFullLoop(env.paths, env.config, {
        mode: 'full-loop',
        dryRun: false,
        skipPost: true,
        allowDirty: false,
        revert: true,
      }),
    ).rejects.toThrow(/uncommitted/);
  });

  it('aborts at Gate 0 when the inputs are inconsistent', async () => {
    const env = await prepare();
    cleanup = env.cleanup;
    const file = path.join(env.paths.inputs.uiBindings, 'ui-bindings.yaml');
    write(
      env.dir,
      path.relative(env.dir, file),
      readFileSync(file, 'utf8').replace('call: putIpv4Settings', 'call: nope'),
    );
    commitAll(env.dir, 'break inputs');
    await expect(
      runFullLoop(env.paths, env.config, {
        mode: 'full-loop',
        maxIterations: 1,
        dryRun: true,
        skipPost: true,
        allowDirty: false,
        revert: true,
      }),
    ).rejects.toThrow(/Gate 0/);
  });

  it('detects tampering with expected values', async () => {
    const env = await prepare();
    cleanup = env.cleanup;
    await convertWorkbooks(env.paths, env.config);
    const { runSubsystemGate } = await import('../gate-runner.js');
    const file = env.paths.subsystemCases;
    write(
      env.dir,
      path.relative(env.dir, file),
      readFileSync(file, 'utf8').replace('保存しました', '保存'),
    );
    const gate = await runSubsystemGate(env.paths, env.config);
    expect(gate).toMatchObject({ status: 'fail', summary: 'Expected values were modified' });
    expect(git(env.dir, 'status', '--porcelain')).toBe('');
  });
});

describe('runReverseDoc (dry-run)', () => {
  let cleanup = () => {};
  afterEach(() => cleanup());

  it('renders the documents without a loop', async () => {
    const env = await prepare();
    cleanup = env.cleanup;
    const run = await runReverseDoc(env.paths, env.config, {
      mode: 'reverse-doc',
      dryRun: true,
      skipPost: false,
      allowDirty: false,
      revert: true,
    });
    expect(run).toMatchObject({ mode: 'reverse-doc', result: 'passed' });
    const doc = readFileSync(
      path.join(env.paths.outputs.reverseDocs, '02-panel-screen-and-state-spec.md'),
      'utf8',
    );
    expect(doc).toContain('`save-button`');
    expect(doc).not.toMatch(/\{\{\w+\}\}/);
  });
});
