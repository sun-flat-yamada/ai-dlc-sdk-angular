import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runReverseDoc } from '../orchestrator.js';
import { AidlcConfig, loadConfig, resolvePaths } from '../lib/config.js';
import { PostProcessGuard } from '../lib/post-process-guard.js';
import { commitAll, copyHarness, git, tempRepo, write } from './helpers.js';

const ROUTES = 'src/app/app.routes.ts';
const ROUTES_SOURCE =
  "export const routes = [\n  { path: '', loadComponent: () => import('./features/home/home-page') },\n];\n";
const GATE_REPORT = '.ai-dlc/outputs/reports/final-quality-gate.md';

function prepare() {
  const repo = tempRepo();
  copyHarness(repo.dir);
  write(repo.dir, ROUTES, ROUTES_SOURCE);
  write(repo.dir, 'src/app/core/http/api-client.ts', '@Injectable()\nexport class ApiClient {}\n');
  commitAll(repo.dir);
  // State left by the loop: a gated implementation change and the final gate report.
  write(repo.dir, 'src/app/features/network-settings/page.ts', 'export const gated = true;\n');
  write(repo.dir, GATE_REPORT, '# Final quality gate report\n\n- Result: **EXHAUSTED**\n');
  const paths = resolvePaths(repo.dir);
  return { ...repo, paths, config: loadConfig(paths.config) };
}

/** Replaces Copilot CLI with a Node.js script that behaves like a misbehaving agent. */
function stubCopilot(config: AidlcConfig, script: string): AidlcConfig {
  return {
    ...config,
    copilot: { ...config.copilot, command: process.execPath, args: ['-e', script] },
  };
}

describe('post-process boundary guard', () => {
  let cleanup = () => {};
  afterEach(() => cleanup());

  it('restores and reports changes a reverse-doc call makes outside its output directory', async () => {
    const env = prepare();
    cleanup = env.cleanup;
    const config = stubCopilot(
      env.config,
      [
        "const fs = require('fs');",
        "fs.writeFileSync('.ai-dlc/outputs/reverse-docs/extra.md', '# allowed\\n');",
        `fs.appendFileSync('${ROUTES}', '// changed after the gate\\n');`,
        "fs.writeFileSync('src/app/core/evil.ts', 'export {};\\n');",
        "fs.writeFileSync('src/app/features/network-settings/page.ts', 'export const gated = false;\\n');",
        `fs.writeFileSync('${GATE_REPORT}', '# Final quality gate report\\n\\n- Result: **PASSED**\\n');`,
      ].join('\n'),
    );
    const run = await runReverseDoc(env.paths, config, {
      mode: 'reverse-doc',
      dryRun: false,
      skipPost: false,
      allowDirty: false,
      revert: true,
    });
    const call = run.postProcess.find((c) => c.id === 'post-reverse-doc');
    expect(call?.violations?.map((v) => v.where).sort()).toEqual([
      GATE_REPORT,
      ROUTES,
      'src/app/core/evil.ts',
      'src/app/features/network-settings/page.ts',
    ]);
    expect(call?.violations?.every((v) => v.message.endsWith('(restored)'))).toBe(true);
    expect(readFileSync(path.join(env.dir, ROUTES), 'utf8')).toBe(ROUTES_SOURCE);
    expect(existsSync(path.join(env.dir, 'src/app/core/evil.ts'))).toBe(false);
    // Restored to the state before the call, not to the baseline: the gated change stays.
    expect(
      readFileSync(path.join(env.dir, 'src/app/features/network-settings/page.ts'), 'utf8'),
    ).toBe('export const gated = true;\n');
    expect(readFileSync(path.join(env.dir, GATE_REPORT), 'utf8')).toContain('EXHAUSTED');
    expect(readFileSync(path.join(env.dir, '.ai-dlc/outputs/reverse-docs/extra.md'), 'utf8')).toBe(
      '# allowed\n',
    );
  });

  it('reports without restoring when revert is off, and records a moved HEAD', async () => {
    const env = prepare();
    cleanup = env.cleanup;
    const head = git(env.dir, 'rev-parse', 'HEAD').trim();
    const config = stubCopilot(
      env.config,
      [
        "const { execFileSync } = require('child_process');",
        "execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'sneaky']);",
        `require('fs').appendFileSync('${ROUTES}', '// x\\n');`,
      ].join('\n'),
    );
    const run = await runReverseDoc(env.paths, config, {
      mode: 'reverse-doc',
      dryRun: false,
      skipPost: false,
      allowDirty: false,
      revert: false,
    });
    const where = run.postProcess[0]?.violations?.map((v) => v.where);
    expect(where).toEqual(['HEAD', 'refs/heads/main', ROUTES]);
    expect(readFileSync(path.join(env.dir, ROUTES), 'utf8')).toContain('// x');
    expect(git(env.dir, 'rev-parse', 'HEAD').trim()).not.toBe(head);
  });

  it('records no violation for a well-behaved call', async () => {
    const env = prepare();
    cleanup = env.cleanup;
    const config = stubCopilot(
      env.config,
      "require('fs').writeFileSync('.ai-dlc/outputs/reverse-docs/ok.md', 'ok\\n');",
    );
    const run = await runReverseDoc(env.paths, config, {
      mode: 'reverse-doc',
      dryRun: false,
      skipPost: false,
      allowDirty: false,
      revert: true,
    });
    expect(run.postProcess[0]?.violations).toBeUndefined();
  });

  it('allows appending to the QCD report but not changing its numbers or the JSON', async () => {
    const env = prepare();
    cleanup = env.cleanup;
    const md = '.ai-dlc/outputs/reports/qcd-comparison-report.md';
    const json = '.ai-dlc/outputs/reports/qcd-comparison-report.json';
    const report = '# QCD\n\n| Metric | AI | Human |\n| --- | --- | --- |\n| Hours | 2 | 40 |\n';
    write(env.dir, md, report);
    write(env.dir, json, '{"hours":2}\n');
    const guard = new PostProcessGuard(env.paths, { allowed: [md], appendOnly: [md] });

    await guard.capture();
    write(env.dir, md, `${report}\n## Interpretation\n\nFaster.\n`);
    expect(await guard.verify(true)).toEqual([]);

    await guard.capture();
    const appended = readFileSync(path.join(env.dir, md), 'utf8');
    write(env.dir, md, appended.replace('| 2 |', '| 1 |'));
    write(env.dir, json, '{"hours":1}\n');
    const failures = await guard.verify(true);
    expect(failures.map((f) => f.where).sort()).toEqual([json, md]);
    expect(readFileSync(path.join(env.dir, md), 'utf8')).toBe(appended);
    expect(readFileSync(path.join(env.dir, json), 'utf8')).toBe('{"hours":2}\n');
  });
});
