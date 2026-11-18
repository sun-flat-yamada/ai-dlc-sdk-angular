import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recordBaseline, runBoundaryGuard } from '../boundary-guard.js';
import {
  BoundaryClassifier,
  describePolicy,
  evaluateChanges,
  loadBoundaryPolicy,
  parseBoundaryPolicy,
} from '../lib/boundary.js';
import { resolvePaths } from '../lib/config.js';
import { normalizeRenamePath } from '../lib/git.js';
import { REPO_ROOT, commitAll, tempRepo, write } from './helpers.js';

const POLICY = parseBoundaryPolicy(`
version: 1
unclassified: deny
zones:
  immutable: { paths: [src/app/core/**, .ai-dlc/inputs/**] }
  extensible: { paths: [src/app/app.routes.ts] }
  rebuildable: { paths: [src/app/features/new/**, .ai-dlc/outputs/**] }
  deletable: { paths: [src/app/features/legacy-*/**] }
  ignored: { paths: [docs/**, src/app/core/generated/**] }
`);

describe('BoundaryClassifier', () => {
  const c = new BoundaryClassifier(POLICY);

  it('classifies by zone with the most restrictive zone winning', () => {
    expect(c.classify('src/app/core/http/api-client.ts')).toBe('immutable');
    expect(c.classify('src/app/core/generated/x.ts')).toBe('immutable'); // immutable beats ignored
    expect(c.classify('src/app/app.routes.ts')).toBe('extensible');
    expect(c.classify('src/app/features/new/page.ts')).toBe('rebuildable');
    expect(c.classify('src/app/features/legacy-net/page.ts')).toBe('deletable');
    expect(c.classify('docs/a.md')).toBe('ignored');
    expect(c.classify('README.md')).toBe('unclassified');
    expect(c.classify('.\\src\\app\\core\\x.ts')).toBe('immutable');
  });

  it('loads the repository policy', () => {
    const policy = loadBoundaryPolicy(path.join(REPO_ROOT, '.ai-dlc/config/boundary-policy.yaml'));
    const repo = new BoundaryClassifier(policy);
    expect(repo.classify('src/app/core/http/api-client.ts')).toBe('immutable');
    expect(repo.classify('src/app/features/network-settings/network-settings-page.ts')).toBe(
      'rebuildable',
    );
    expect(repo.classify('src/app/features/legacy-network/legacy-network-page.ts')).toBe(
      'deletable',
    );
    expect(repo.classify('.ai-dlc/inputs/ui-bindings/ui-bindings.yaml')).toBe('immutable');
    expect(describePolicy(policy)).toContain('**immutable**');
  });

  it('rejects an invalid policy', () => {
    expect(() => parseBoundaryPolicy('version: 2\nzones: {}')).toThrow(/version/);
  });
});

describe('evaluateChanges', () => {
  const c = new BoundaryClassifier(POLICY);
  const rules = (changes: Parameters<typeof evaluateChanges>[2]) =>
    evaluateChanges(c, 'base', changes).violations.map((v) => `${v.path}:${v.rule}`);

  it('applies the zone rules', () => {
    expect(
      rules([
        { path: 'src/app/core/a.ts', status: 'modified', added: 1, deleted: 0 },
        { path: 'src/app/app.routes.ts', status: 'modified', added: 3, deleted: 0 },
        { path: 'src/app/features/new/p.ts', status: 'added' },
        { path: 'src/app/features/legacy-x/p.ts', status: 'deleted' },
        { path: 'docs/x.md', status: 'modified', added: 1, deleted: 1 },
        { path: 'README.md', status: 'added' },
      ]),
    ).toEqual([
      'src/app/core/a.ts:immutable-changed',
      'docs/x.md:out-of-scope',
      'README.md:unclassified',
    ]);
  });

  it('treats extensible files as append-only', () => {
    expect(
      rules([{ path: 'src/app/app.routes.ts', status: 'modified', added: 2, deleted: 1 }]),
    ).toEqual(['src/app/app.routes.ts:extensible-lines-removed']);
    expect(rules([{ path: 'src/app/app.routes.ts', status: 'deleted' }])).toEqual([
      'src/app/app.routes.ts:extensible-file-removed',
    ]);
  });

  it('detects moving a file out of the immutable zone', () => {
    expect(
      rules([{ path: 'src/app/features/new/a.ts', from: 'src/app/core/a.ts', status: 'renamed' }]),
    ).toEqual(['src/app/features/new/a.ts:immutable-changed']);
  });

  it('collects per-zone statistics', () => {
    const report = evaluateChanges(c, 'b', [
      { path: 'src/app/features/new/a.ts', status: 'added', added: 10, deleted: 0 },
      { path: 'src/app/features/new/b.ts', status: 'modified', added: 2, deleted: 1 },
    ]);
    expect(report.stats['rebuildable']).toEqual({ files: 2, added: 12, deleted: 1 });
  });
});

describe('normalizeRenamePath', () => {
  it('handles numstat rename notations', () => {
    expect(normalizeRenamePath('src/{a => b}/x.ts')).toBe('src/b/x.ts');
    expect(normalizeRenamePath('a.ts => b.ts')).toBe('b.ts');
    expect(normalizeRenamePath('plain.ts')).toBe('plain.ts');
  });
});

describe('runBoundaryGuard (git)', () => {
  let cleanup = () => {};
  afterEach(() => cleanup());

  it('reports and reverts violations against the baseline', async () => {
    const repo = tempRepo();
    cleanup = repo.cleanup;
    const { dir } = repo;
    write(
      dir,
      '.ai-dlc/config/boundary-policy.yaml',
      readFileSync(path.join(REPO_ROOT, '.ai-dlc/config/boundary-policy.yaml'), 'utf8'),
    );
    write(dir, 'src/app/core/http/api-client.ts', 'export const a = 1;\n');
    write(dir, 'src/app/app.routes.ts', 'export const routes = [\n  { path: "" },\n];\n');
    write(dir, '.gitignore', '/.ai-dlc/outputs/\n');
    commitAll(dir);
    const paths = resolvePaths(dir);
    const baseline = await recordBaseline(paths);

    write(dir, 'src/app/core/http/api-client.ts', 'export const a = 2;\n'); // immutable edit
    write(
      dir,
      'src/app/app.routes.ts',
      'export const routes = [\n  { path: "" },\n  { path: "new" },\n];\n',
    ); // append: ok
    write(dir, 'src/app/features/network-settings/p.ts', 'export {};\n'); // rebuildable: ok
    write(dir, 'src/app/core/new-file.ts', 'export {};\n'); // immutable add

    const first = await runBoundaryGuard(paths, { baseline: baseline.sha, revert: false });
    expect(first.gate.status).toBe('fail');
    expect(first.report.violations.map((v) => v.path).sort()).toEqual([
      'src/app/core/http/api-client.ts',
      'src/app/core/new-file.ts',
    ]);

    const reverted = await runBoundaryGuard(paths, { baseline: baseline.sha, revert: true });
    expect(reverted.reverted).toHaveLength(2);
    expect(readFileSync(path.join(dir, 'src/app/core/http/api-client.ts'), 'utf8')).toBe(
      'export const a = 1;\n',
    );
    expect(existsSync(path.join(dir, 'src/app/core/new-file.ts'))).toBe(false);

    const after = await runBoundaryGuard(paths, { baseline: baseline.sha, revert: false });
    expect(after.gate.status).toBe('pass');
    expect(after.report.changes.map((c) => c.path).sort()).toEqual([
      'src/app/app.routes.ts',
      'src/app/features/network-settings/p.ts',
    ]);
  });
});
