import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mergePackageJson, planInstall, runInstall } from '../install.js';
import { HumanBaseline, calculateQcd, renderQcdMarkdown, selectRun } from '../qcd-calculator.js';
import { parseConfig } from '../lib/config.js';
import { RunRecord } from '../lib/telemetry.js';
import { REPO_ROOT, git, tempRepo, write } from './helpers.js';

const config = parseConfig(
  readFileSync(path.join(REPO_ROOT, '.ai-dlc/config/aidlc.config.yaml'), 'utf8'),
);
const human: HumanBaseline = {
  project: 'p',
  quality: {
    subsystemTestFirstPassRate: 0.5,
    subsystemTestFinalPassRate: 1,
    unitTestCoverage: { lines: 70 },
    staticAnalysisWarnings: 3,
    defectsFound: 4,
    sizeKloc: 2,
  },
  cost: { effortHours: { impl: 40, test: 20 }, hourlyRate: 10000, currency: 'JPY' },
  delivery: { leadTimeHours: 48, calendarDays: 6 },
};

const call = (id: string, credits: number) => ({
  id,
  skills: [],
  phase: 'implement' as const,
  startedAt: '',
  endedAt: '',
  durationMs: 0,
  dryRun: false,
  exitCode: 0,
  promptFile: '',
  promptChars: 400,
  estimatedInputTokens: 100,
  outputChars: 40,
  estimatedOutputTokens: 10,
  usage: { aiCredits: credits, inputTokens: 1000, outputTokens: 200 },
  changedFiles: [],
});

const run: RunRecord = {
  runId: 'r1',
  mode: 'full-loop',
  startedAt: '2026-11-01T00:00:00.000Z',
  endedAt: '2026-11-01T02:00:00.000Z',
  dryRun: false,
  maxIterations: 5,
  baseline: 'abc',
  result: 'passed',
  iterations: [
    {
      index: 1,
      startedAt: '',
      copilotCalls: [call('implement', 10)],
      passed: false,
      gates: [
        {
          gate: 'lint',
          status: 'pass',
          durationMs: 0,
          summary: '',
          failures: [],
          metrics: { warnings: 2 },
        },
        {
          gate: 'subsystem',
          status: 'fail',
          durationMs: 0,
          summary: '',
          failures: [],
          metrics: { cases: 8, passed: 6, passRate: 0.75 },
        },
      ],
    },
    {
      index: 2,
      startedAt: '',
      copilotCalls: [call('fix', 5)],
      passed: true,
      gates: [
        {
          gate: 'unit',
          status: 'pass',
          durationMs: 0,
          summary: '',
          failures: [],
          metrics: { coverageLines: 91.5, coverageStatements: 90 },
        },
        {
          gate: 'subsystem',
          status: 'pass',
          durationMs: 0,
          summary: '',
          failures: [],
          metrics: { cases: 8, passed: 8, passRate: 1 },
        },
      ],
    },
  ],
  postProcess: [],
  changeStats: {
    rebuildable: { files: 4, added: 500, deleted: 0 },
    immutable: { files: 0, added: 0, deleted: 0 },
  },
};

describe('calculateQcd', () => {
  it('compares quality, cost and delivery', () => {
    const r = calculateQcd(run, human, config);
    expect(r.quality.ai).toMatchObject({
      subsystemFirstPassRate: 0.75,
      subsystemFinalPassRate: 1,
      passRateByIteration: [0.75, 1],
      coverageLines: 91.5,
      lintWarnings: 2,
      defectsDetected: 2,
      changedKloc: 0.5,
      defectDensityPerKloc: 4,
    });
    expect(r.quality.human.defectDensityPerKloc).toBe(2);
    // AI: 15 credits * 6 + (4 + 4) h * 10000 (same rate as the human side); human: 60 h * 10000
    expect(r.cost.ai).toMatchObject({
      copilotCalls: 2,
      aiCredits: 15,
      aiCost: 90,
      humanHours: 8,
      humanCost: 80000,
      totalCost: 80090,
      tokensAreEstimated: false,
      creditsAreIncomplete: false,
    });
    expect(r.cost.human.totalCost).toBe(600000);
    expect(r.cost.reductionRate).toBeCloseTo((600000 - 80090) / 600000);
    expect(r.delivery.ai).toMatchObject({ leadTimeHours: 2, iterations: 2, maxIterations: 5 });
    expect(r.delivery.reductionRate).toBeCloseTo(46 / 48);
  });

  it('does not report reductions for dry-runs or runs that did not pass', () => {
    for (const r of [
      calculateQcd({ ...run, dryRun: true }, human, config),
      calculateQcd({ ...run, result: 'exhausted' }, human, config),
    ]) {
      expect(r.comparable).toBe(false);
      expect(r.cost.reductionRate).toBeNull();
      expect(r.delivery.reductionRate).toBeNull();
      expect(renderQcdMarkdown(r, 'ja')).toContain('削減率は算出していません');
    }
  });

  it('withholds the cost reduction when a real call has no usage data (issue #23)', () => {
    const { usage: _missing, ...crashed } = call('fix', 0);
    const partial: RunRecord = {
      ...run,
      iterations: [run.iterations[0]!, { ...run.iterations[1]!, copilotCalls: [crashed] }],
    };
    const r = calculateQcd(partial, human, config);
    expect(r.comparable).toBe(true);
    expect(r.cost.ai.creditsAreIncomplete).toBe(true);
    expect(r.cost.reductionRate).toBeNull();
    expect(r.delivery.reductionRate).not.toBeNull();
    expect(renderQcdMarkdown(r, 'en')).toContain('AI credits are incomplete');
  });

  it('renders Japanese and English reports', () => {
    const r = calculateQcd(run, human, config);
    const ja = renderQcdMarkdown(r, 'ja');
    expect(ja).toContain('QCD 比較レポート');
    expect(ja).toContain('#1 75.0% → #2 100.0%');
    expect(renderQcdMarkdown({ ...r, dryRun: true }, 'en')).toContain('Dry-run result');
  });

  it('selects the latest full-loop run', () => {
    expect(selectRun([run, { ...run, runId: 'r2', mode: 'reverse-doc' }])?.runId).toBe('r1');
    expect(selectRun([run], 'missing')).toBeUndefined();
  });
});

describe('install', () => {
  let cleanup = () => {};
  afterEach(() => cleanup());

  it('merges scripts and harness devDependencies without overriding existing entries', () => {
    const merged = mergePackageJson(
      {
        name: 'x',
        scripts: { build: 'ng build', 'aidlc:run': 'custom' },
        devDependencies: { tsx: '^1.0.0' },
      },
      JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')),
    );
    const scripts = merged['scripts'] as Record<string, string>;
    expect(scripts['aidlc:run']).toBe('custom');
    expect(scripts['aidlc:gate']).toContain('gate-runner.ts');
    expect(scripts['aidlc:install']).toBeUndefined();
    expect(scripts['sandbox']).toBe('node scripts/sandbox.ts');
    expect(scripts['aidlc:sandbox-check']).toContain('sandbox-check.ts');
    const dev = merged['devDependencies'] as Record<string, string>;
    expect(dev['tsx']).toBe('^1.0.0');
    expect(dev['exceljs']).toBeDefined();
  });

  it('installs into an Angular workspace and keeps existing files', () => {
    const repo = tempRepo();
    cleanup = repo.cleanup;
    write(repo.dir, 'angular.json', JSON.stringify({ projects: { 'my-panel': {} } }));
    write(repo.dir, 'package.json', JSON.stringify({ name: 'my-panel', scripts: {} }));
    write(repo.dir, '.github/skills/02-angular-panel-impl/SKILL.md', 'customized');

    const plan = planInstall(REPO_ROOT, repo.dir, { withSample: false, force: false });
    expect(
      plan.find((a) => a.target === '.github/skills/02-angular-panel-impl/SKILL.md')?.kind,
    ).toBe('skip');
    expect(plan.some((a) => a.target.startsWith('.ai-dlc/tools/tests/'))).toBe(false);
    expect(plan.some((a) => a.target.includes('ui-bindings.yaml'))).toBe(false);
    expect(plan.find((a) => a.target === '.devcontainer/devcontainer.json')?.kind).toBe('copy');
    expect(plan.find((a) => a.target === 'scripts/sandbox.ts')?.kind).toBe('copy');
    expect(
      plan.some(
        (a) => a.target.startsWith('.devcontainer/certs/') && !a.target.endsWith('README.md'),
      ),
    ).toBe(false);

    runInstall(REPO_ROOT, repo.dir, { withSample: false, force: false, dryRun: false });
    expect(
      readFileSync(path.join(repo.dir, '.github/skills/02-angular-panel-impl/SKILL.md'), 'utf8'),
    ).toBe('customized');
    expect(existsSync(path.join(repo.dir, '.ai-dlc/tools/orchestrator.ts'))).toBe(true);
    expect(existsSync(path.join(repo.dir, '.ai-dlc/inputs/ui-bindings'))).toBe(true);
    expect(readFileSync(path.join(repo.dir, '.ai-dlc/config/aidlc.config.yaml'), 'utf8')).toMatch(
      /angularProject: my-panel/,
    );
    expect(readFileSync(path.join(repo.dir, '.gitignore'), 'utf8')).toContain(
      '/.ai-dlc/outputs/**',
    );
    // The Vitest cache of the harness tests must never be committed (issue #7).
    write(repo.dir, '.ai-dlc/tools/node_modules/.vite/vitest/results.json', '{}');
    expect(
      git(repo.dir, 'check-ignore', '.ai-dlc/tools/node_modules/.vite/vitest/results.json'),
    ).toBe('.ai-dlc/tools/node_modules/.vite/vitest/results.json\n');
    expect(existsSync(path.join(repo.dir, '.devcontainer/init-firewall.sh'))).toBe(true);
  });

  it('ignores the Vitest cache of the harness tests in this repository', () => {
    const file = '.ai-dlc/tools/node_modules/.vite/vitest/results.json';
    expect(git(REPO_ROOT, 'check-ignore', '--no-index', file)).toBe(`${file}\n`);
    expect(git(REPO_ROOT, 'ls-files', '.ai-dlc/tools/node_modules')).toBe('');
  });

  it('refuses a target without angular.json', () => {
    const repo = tempRepo();
    cleanup = repo.cleanup;
    expect(() =>
      runInstall(REPO_ROOT, repo.dir, { withSample: false, force: false, dryRun: true }),
    ).toThrow(/angular.json/);
  });
});
