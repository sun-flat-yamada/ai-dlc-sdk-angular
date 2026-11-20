import { existsSync, readFileSync, statSync, utimesSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recordBaseline, runBoundaryGuard } from '../boundary-guard.js';
import { DependencyGuard, diffFingerprints, packageOf } from '../lib/dependency-guard.js';
import { resolvePaths } from '../lib/config.js';
import { REPO_ROOT, commitAll, tempRepo, write } from './helpers.js';

const RUNNER = 'node_modules/vitest/dist/runner.js';

/** A repository with a git-ignored node_modules, as in a real project. */
function prepare(restoreCommand: string[] = []) {
  const repo = tempRepo();
  const { dir } = repo;
  write(
    dir,
    '.ai-dlc/config/boundary-policy.yaml',
    readFileSync(path.join(REPO_ROOT, '.ai-dlc/config/boundary-policy.yaml'), 'utf8'),
  );
  write(dir, '.gitignore', '/node_modules/\n/.angular/\n/.ai-dlc/outputs/\n');
  write(dir, 'src/main.ts', 'export {};\n');
  commitAll(dir);
  write(dir, RUNNER, 'export function run() { return runTests(); }\n');
  write(dir, 'node_modules/@angular/core/index.js', 'export const VERSION = "22";\n');
  write(dir, '.angular/cache/22/babel/entry.json', '{}\n');
  const guard = new DependencyGuard(dir, {
    enabled: true,
    paths: ['node_modules'],
    restoreCommand,
    restoreTimeoutMinutes: 1,
    clearBeforeGates: ['.angular/cache'],
  });
  guard.capture();
  return { ...repo, paths: resolvePaths(dir), guard };
}

describe('dependency guard helpers', () => {
  it('groups files by package', () => {
    const g = ['node_modules'];
    expect(packageOf('node_modules/vitest/dist/runner.js', g)).toBe('node_modules/vitest');
    expect(packageOf('node_modules/@angular/core/index.js', g)).toBe('node_modules/@angular/core');
    expect(packageOf('node_modules/.bin', g)).toBe('node_modules/.bin');
    expect(packageOf('node_modules', g)).toBe('node_modules');
  });

  it('diffs added, removed and changed entries', () => {
    const before = new Map([
      ['a', '1'],
      ['b', '1'],
    ]);
    const after = new Map([
      ['a', '2'],
      ['c', '1'],
    ]);
    expect(diffFingerprints(before, after)).toEqual(['a', 'b', 'c']);
  });
});

describe('runBoundaryGuard with the dependency guard', () => {
  let cleanup = () => {};
  afterEach(() => cleanup());

  it('passes when node_modules is untouched', async () => {
    const env = prepare();
    cleanup = env.cleanup;
    const baseline = await recordBaseline(env.paths);
    const r = await runBoundaryGuard(env.paths, {
      baseline: baseline.sha,
      revert: false,
      dependencies: env.guard,
    });
    expect(r.gate.status).toBe('pass');
    expect(r.gate.metrics).toMatchObject({ dependencyViolations: 0 });
  });

  it('detects a rewritten file even when its size and mtime are restored', async () => {
    const env = prepare();
    cleanup = env.cleanup;
    const baseline = await recordBaseline(env.paths);
    const file = path.join(env.dir, RUNNER);
    const before = statSync(file);
    // Same length, same mtime: only the ctime (which user space cannot set) reveals the write.
    write(env.dir, RUNNER, 'export function run() { return { ok: true }; }\n'.padEnd(before.size));
    utimesSync(file, before.atime, before.mtime);
    const plain = await runBoundaryGuard(env.paths, { baseline: baseline.sha, revert: false });
    expect(plain.gate.status).toBe('pass'); // git alone cannot see it (issue #5)
    const r = await runBoundaryGuard(env.paths, {
      baseline: baseline.sha,
      revert: false,
      dependencies: env.guard,
    });
    expect(r.gate.status).toBe('fail');
    expect(r.gate.failures).toEqual([
      expect.objectContaining({
        where: 'node_modules/vitest',
        message: expect.stringContaining('[ignored/dependency-changed]'),
      }),
    ]);
  });

  it('detects added and deleted packages', async () => {
    const env = prepare();
    cleanup = env.cleanup;
    const baseline = await recordBaseline(env.paths);
    write(env.dir, 'node_modules/evil/index.js', 'export {};\n');
    const { rmSync } = await import('node:fs');
    rmSync(path.join(env.dir, 'node_modules/@angular'), { recursive: true });
    const r = await runBoundaryGuard(env.paths, {
      baseline: baseline.sha,
      revert: false,
      dependencies: env.guard,
    });
    expect(r.gate.failures.map((f) => f.where).sort()).toEqual([
      'node_modules',
      'node_modules/@angular',
      'node_modules/@angular/core',
      'node_modules/evil',
    ]);
  });

  it('rebuilds the directory with restoreCommand and trusts the new state', async () => {
    const restore = [
      process.execPath,
      '-e',
      `require('fs').writeFileSync(${JSON.stringify(RUNNER)}, 'export function run() { return runTests(); }\\n')`,
    ];
    const env = prepare(restore);
    cleanup = env.cleanup;
    const baseline = await recordBaseline(env.paths);
    write(env.dir, RUNNER, 'export function run() { return { ok: true }; }\n');
    const r = await runBoundaryGuard(env.paths, {
      baseline: baseline.sha,
      revert: true,
      dependencies: env.guard,
    });
    expect(r.gate.status).toBe('fail');
    expect(r.gate.failures[0]?.message).toContain('rebuilt with');
    expect(readFileSync(path.join(env.dir, RUNNER), 'utf8')).toContain('runTests');
    const after = await runBoundaryGuard(env.paths, {
      baseline: baseline.sha,
      revert: false,
      dependencies: env.guard,
    });
    expect(after.gate.status).toBe('pass');
  });

  it('reports a failed restore', async () => {
    const env = prepare([process.execPath, '-e', 'process.exit(3)']);
    cleanup = env.cleanup;
    const baseline = await recordBaseline(env.paths);
    write(env.dir, RUNNER, 'tampered\n');
    const r = await runBoundaryGuard(env.paths, {
      baseline: baseline.sha,
      revert: true,
      dependencies: env.guard,
    });
    expect(r.gate.failures[0]?.message).toMatch(/NOT restored: .*exit 3/);
  });

  it('clears build caches before the gates', () => {
    const env = prepare();
    cleanup = env.cleanup;
    env.guard.clearCaches();
    expect(existsSync(path.join(env.dir, '.angular/cache'))).toBe(false);
  });
});
