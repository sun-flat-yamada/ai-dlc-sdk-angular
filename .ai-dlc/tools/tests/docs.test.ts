import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from './helpers.js';

const read = (file: string) => readFileSync(path.join(REPO_ROOT, file), 'utf8');
const headings = (md: string) => md.split(/\r?\n/).filter((l) => /^## /.test(l));

describe('README.md and README.ja.md (issue #24)', () => {
  it('have the same sections in the same order', () => {
    expect(headings(read('README.ja.md'))).toHaveLength(headings(read('README.md')).length);
  });

  it('link the same documents', () => {
    const links = (md: string) =>
      [...new Set([...md.matchAll(/\]\(((?:docs|specs)\/[^)#]+)\)/g)].map((m) => m[1]!))].sort();
    expect(links(read('README.ja.md'))).toEqual(links(read('README.md')));
  });

  it('list every script and document in the repository layout', () => {
    for (const md of [read('README.md'), read('README.ja.md')]) {
      for (const script of ['sandbox.ts', 'pr-autopilot.ts', 'scan-secrets.ts'])
        expect(md).toContain(script);
      expect(md).toContain('pr-auto-merge');
    }
    for (const doc of ['sandbox.md', 'pr-auto-merge.md', 'architecture.md', 'adoption-guide.md'])
      expect(existsSync(path.join(REPO_ROOT, 'docs', doc))).toBe(true);
  });
});
