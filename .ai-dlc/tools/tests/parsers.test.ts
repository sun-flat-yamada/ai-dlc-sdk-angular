import { describe, expect, it } from 'vitest';
import { renderArgs } from '../copilot-cli-adapter.js';
import { parseConfig } from '../lib/config.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  caseIdsInTitle,
  parseBuildErrors,
  parseCoverageSummary,
  parseLintErrors,
  parsePlaywrightReport,
  parseVitestFailures,
} from '../lib/output-parsers.js';
import { parseUsageFile } from '../lib/telemetry.js';
import { isSubset, pathMatches } from '../subsystem-kit.js';
import { REPO_ROOT } from './helpers.js';

describe('config', () => {
  it('parses the repository configuration', () => {
    const config = parseConfig(readFileSync(path.join(REPO_ROOT, '.ai-dlc/config/aidlc.config.yaml'), 'utf8'));
    expect(config.loop.maxIterations).toBeGreaterThan(0);
    expect(config.copilot.args).toContain('--usage-output-file');
    expect(config.gates.unit.coverage?.thresholds.lines).toBe(80);
  });

  it('reports invalid fields with their path', () => {
    expect(() => parseConfig('version: 1\nloop: { maxIterations: 0 }')).toThrow(/loop\.maxIterations/);
  });
});

describe('renderArgs', () => {
  it('fills placeholders and keeps unknown ones', () => {
    expect(renderArgs(['-p', '{prompt}', '--x={model}', '{unknown}'], { prompt: 'do it', model: 'auto' })).toEqual(['-p', 'do it', '--x=auto', '{unknown}']);
  });
});

describe('output parsers', () => {
  it('parses Angular build errors', () => {
    const out = [
      '✘ [ERROR] TS2322: Type \'string\' is not assignable to type \'number\'. [plugin angular-compiler]',
      '',
      '    src/app/a.ts:12:4:',
      '      12 │     x = "a";',
      'src/app/b.ts(3,5): error TS2304: Cannot find name \'y\'.',
    ].join('\n');
    expect(parseBuildErrors(out)).toEqual([
      { where: 'src/app/a.ts:12:4', message: "TS2322: Type 'string' is not assignable to type 'number'." },
      { where: 'src/app/b.ts:3:5', message: "TS2304: Cannot find name 'y'." },
    ]);
  });

  it('parses ESLint stylish output', () => {
    const out = ['', 'V:\\repo\\src\\app\\a.ts', '  3:7  error    Unexpected any  @typescript-eslint/no-explicit-any', '  4:1  warning  Unused  no-unused-vars', '', '✖ 2 problems (1 error, 1 warning)'].join('\n');
    const r = parseLintErrors(out);
    expect(r).toMatchObject({ errors: 1, warnings: 1 });
    expect(r.failures[0]).toEqual({ where: 'V:\\repo\\src\\app\\a.ts:3:7', message: 'Unexpected any (@typescript-eslint/no-explicit-any)' });
  });

  it('parses Vitest failures', () => {
    const out = ' FAIL  src/app/a.spec.ts > A > works\nAssertionError: expected 1 to be 2\n FAIL  src/app/b.spec.ts > B\nTypeError: x is undefined';
    expect(parseVitestFailures(out)).toEqual([
      { where: 'src/app/a.spec.ts > A > works', message: 'AssertionError: expected 1 to be 2' },
      { where: 'src/app/b.spec.ts > B', message: 'TypeError: x is undefined' },
    ]);
  });

  it('parses coverage summaries', () => {
    const json = JSON.stringify({ total: { statements: { pct: 90 }, branches: { pct: 'Unknown' }, functions: { pct: 80 }, lines: { pct: 88.5 } } });
    expect(parseCoverageSummary(json)).toEqual({ statements: 90, branches: 100, functions: 80, lines: 88.5 });
  });

  it('flattens the Playwright JSON report', () => {
    const report = {
      suites: [
        {
          title: 'net.spec.ts',
          file: 'net.spec.ts',
          suites: [
            {
              title: 'ネットワーク設定',
              specs: [
                { title: '[ST-1] ok', tests: [{ status: 'expected', results: [{ status: 'passed' }] }] },
                { title: '[ST-2] ng', tests: [{ status: 'unexpected', results: [{ status: 'failed', error: { message: 'Expected "a"' } }] }] },
                { title: '[ST-3] skip', tests: [{ status: 'skipped', results: [{ status: 'skipped' }] }] },
              ],
            },
          ],
        },
      ],
    };
    const r = parsePlaywrightReport(JSON.stringify(report));
    expect(r.map((t) => [t.title, t.status])).toEqual([
      ['ネットワーク設定 > [ST-1] ok', 'passed'],
      ['ネットワーク設定 > [ST-2] ng', 'failed'],
      ['ネットワーク設定 > [ST-3] skip', 'skipped'],
    ]);
    expect(r[1]!.error).toBe('Expected "a"');
    expect(caseIdsInTitle('x > [ST-NET-001] [ST-NET-002] title')).toEqual(['ST-NET-001', 'ST-NET-002']);
  });
});

describe('parseUsageFile', () => {
  it('prefers explicit totals', () => {
    expect(parseUsageFile(JSON.stringify({ total: { aiCredits: 3, inputTokens: 100, outputTokens: 20 }, models: { a: { inputTokens: 999 } } }))).toMatchObject({
      aiCredits: 3,
      inputTokens: 100,
      outputTokens: 20,
    });
  });

  it('sums per-model breakdowns and accepts snake_case', () => {
    expect(parseUsageFile(JSON.stringify({ models: [{ input_tokens: 10, premium_requests: 1 }, { input_tokens: 5, premium_requests: 2 }] }))).toMatchObject({
      inputTokens: 15,
      premiumRequests: 3,
    });
  });

  it('returns undefined for unknown content', () => {
    expect(parseUsageFile('not json')).toBeUndefined();
    expect(parseUsageFile('{"foo":1}')).toBeUndefined();
  });
});

describe('subsystem kit helpers', () => {
  it('matches path templates', () => {
    expect(pathMatches('/api/v1/items/{id}', '/api/v1/items/42')).toBe(true);
    expect(pathMatches('/api/v1/items/{id}', '/api/v1/items/42/x')).toBe(false);
    expect(pathMatches('/api/v1/network/ipv4', '/api/v1/network/ipv4')).toBe(true);
  });

  it('checks deep subsets', () => {
    expect(isSubset({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 2, d: 3 }, e: 4 })).toBe(true);
    expect(isSubset({ a: 1 }, { a: 2 })).toBe(false);
    expect(isSubset([1, 2], [1, 2])).toBe(true);
    expect(isSubset([1], [1, 2])).toBe(false);
  });
});
