import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { freePort, mutationSurvivors, unverified } from '../gate-runner.js';
import { EVALUATED_ANNOTATION, KILLED_ANNOTATION, MUTANTS } from '../lib/mutants.js';
import { analyzeGeneratedTests, analyzeTestFile } from '../lib/test-structure.js';
import {
  PlaywrightTestResult,
  parseBuildErrors,
  parsePlaywrightReport,
} from '../lib/output-parsers.js';
import { orphansSince } from '../lib/processes.js';
import { SubsystemCase, VERIFIED_ANNOTATION } from '../lib/subsystem-cases.js';
import { expectNoRequest, type DeviceApiRecorder } from '../subsystem-kit.js';

const CASE: SubsystemCase = {
  id: 'ST-1',
  sheet: 's',
  row: 2,
  category: '',
  title: 't',
  priority: '',
  requirements: [],
  preconditions: [],
  initialDeviceState: {},
  mockApi: [],
  steps: [],
  expectedUi: ['@status shows 保存しました', '@save is disabled'],
  expectedCss: [{ property: 'color', value: 'red', raw: '{ color: red }', selector: '@status' }],
  expectedApi: [{ method: 'PUT', path: '/api/v1/x', raw: 'PUT /api/v1/x' }],
  uiRefs: [],
  notes: '',
};

describe('Gate 4: verified expectations (issue #18)', () => {
  it('reads the verification records from the Playwright report', () => {
    const report = {
      suites: [
        {
          title: 'a.spec.ts',
          specs: [
            {
              title: '[ST-1] t',
              tests: [
                {
                  status: 'expected',
                  results: [
                    {
                      status: 'passed',
                      annotations: [
                        { type: VERIFIED_ANNOTATION, description: 'ST-1:api:0' },
                        { type: 'other', description: 'x' },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const [t] = parsePlaywrightReport(JSON.stringify(report));
    expect(t?.verified).toEqual(['ST-1:api:0']);
  });

  it('lists every expectation that no passing test verified', () => {
    expect(unverified(CASE, [{ status: 'passed' }])).toHaveLength(4);
    expect(
      unverified(CASE, [
        { status: 'passed', verified: ['ST-1:api:0', 'ST-1:css:0', 'ST-1:ui:0'] },
        { status: 'failed', verified: ['ST-1:ui:1'] },
      ]),
    ).toEqual(['expectedUi[1] @save is disabled (expectUi(c, 1, …))']);
    expect(
      unverified(CASE, [
        { status: 'passed', verified: ['ST-1:api:0', 'ST-1:css:0', 'ST-1:ui:0', 'ST-1:ui:1'] },
      ]),
    ).toEqual([]);
  });

  describe('structural check (AST)', () => {
    const KIT =
      "import { expect, expectApiRequests, expectCss, expectNoRequest, expectUi, loadCase, test, ui } from '../../../tools/subsystem-kit';";
    const check = (body: string) =>
      analyzeTestFile(
        'a.spec.ts',
        [KIT, "const c = loadCase('ST-1');", body].join('\n'),
        CASES,
        new Map(),
        new Set(),
      ).map((p) => `${p.where.split(':').pop()} ${p.message}`);
    const CASES = new Map([[CASE.id, CASE]]);
    const GOOD = [
      'test(`[${c.id}] t`, async ({ page }) => {',
      '  const api = { requests: [] };',
      "  await expectUi(c, 0, () => expect(ui(page, 'status')).toHaveText('保存しました'));",
      '  await test.step("x", async () => {',
      "    await expectUi(c, 1, async () => { await expect(ui(page, 'save')).not.toBeEnabled(); });",
      '  });',
      '  await expectCss(page, c);',
      '  await expectApiRequests(api, c);',
      '});',
    ].join('\n');

    it('accepts a test that asserts every expectation unconditionally', () => {
      expect(check(GOOD)).toEqual([]);
      const report = analyzeGeneratedTests('/', [], [CASE]);
      expect(report.problems).toEqual([]);
    });

    it('rejects dead, conditional, empty and forged assertions', () => {
      const problems = check(
        [
          'test(`[${c.id}] t`, async ({ page }) => {',
          "  test.info().annotations.push({ type: 'aidlc-verified', description: 'ST-1:api:0' });",
          '  expectApiRequests(api, c);',
          '  if (process.env.X) await expectCss(page, c);',
          '  await expectUi(c, 0, () => page.goto("/"));',
          '  await expectUi(c, 7, () => expect(page).toHaveURL("/"));',
          "  await ui(page, 'save').click({ force: true });",
          '  const helper = async () => { await expectUi(c, 1, () => expect(page).toHaveURL("/")); };',
          '});',
          'test.skip(`[${c.id}] later`, async () => {});',
        ].join('\n'),
      );
      expect(problems).toEqual([
        expect.stringMatching(/^4 Generated tests must not touch test annotations/),
        expect.stringMatching(/^4 Generated tests must not write the verification records/),
        expect.stringMatching(/^5 `expectApiRequests\(…\)` must be awaited/),
        expect.stringMatching(/^6 `expectCss\(…\)` must run unconditionally .* inside an `if`/),
        expect.stringMatching(/^7 expectUi\(c, 0, …\) must contain an assertion/),
        expect.stringMatching(/^8 ST-1 has no expectedUi\[7\]/),
        expect.stringMatching(/^9 `force: true` is not allowed/),
        expect.stringMatching(/^10 `expectUi\(…\)` must run unconditionally .* helper function/),
        expect.stringMatching(/^12 `test.skip` is not allowed/),
      ]);
    });

    it('reports every expectation of a case that no test asserts', () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'aidlc-specs-'));
      try {
        writeFileSync(
          path.join(dir, 'a.spec.ts'),
          [
            KIT,
            "const c = loadCase('ST-1');",
            'test(`[${c.id}] t`, async ({ page }) => {',
            "  await expectUi(c, 0, () => expect(ui(page, 's')).toBeVisible());",
            '});',
          ].join('\n'),
        );
        const r = analyzeGeneratedTests(dir, [path.join(dir, 'a.spec.ts')], [CASE]);
        expect(r.problems.map((p) => p.message)).toEqual([
          expect.stringMatching(/expectApiRequests/),
          expect.stringMatching(/expectCss/),
          expect.stringMatching(/expectedUi\[1\]/),
        ]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('requires test and the helpers from the subsystem kit', () => {
      const problems = analyzeTestFile(
        'b.spec.ts',
        "import { test, expect } from '@playwright/test';\n",
        CASES,
        new Map(),
        new Set(),
      );
      expect(problems[0]?.message).toMatch(/Import `test` from the subsystem kit/);
    });
  });
});

describe('mutation check (issue #18)', () => {
  const result = (
    title: string,
    status: 'passed' | 'failed',
    notes: [string, string][],
  ): PlaywrightTestResult => ({
    title,
    file: '',
    status,
    annotations: notes.map(([type, description]) => ({ type, description })),
  });

  it('reports expectedUi lines that no mutant made fail', () => {
    const r = mutationSurvivors(
      [CASE],
      [
        result('[ST-1] t', 'passed', [
          [EVALUATED_ANNOTATION, 'ST-1:ui:0'],
          [KILLED_ANNOTATION, 'ST-1:ui:0'],
          [EVALUATED_ANNOTATION, 'ST-1:ui:1'],
        ]),
      ],
    );
    expect(r).toEqual({
      lines: 2,
      survivors: [{ id: 'ST-1', index: 1, line: '@save is disabled' }],
    });
  });

  it('counts lines a failed test never reached as detected', () => {
    const r = mutationSurvivors(
      [CASE],
      [result('[ST-1] t', 'failed', [[EVALUATED_ANNOTATION, 'ST-1:ui:0']])],
    );
    expect(r.survivors.map((s) => s.index)).toEqual([0]);
  });

  it('lists the mutants in the configuration', () => {
    expect([...MUTANTS]).toEqual(['text', 'value', 'disabled', 'checked', 'navigation', 'request']);
  });
});

describe('expectNoRequest (issue #19)', () => {
  it('fails when the request arrives shortly after the call', async () => {
    const recorder: DeviceApiRecorder = { requests: [] };
    setTimeout(() => recorder.requests.push({ method: 'PUT', path: '/api/v1/x', body: {} }), 150);
    await expect(expectNoRequest(recorder, 'put', '/api/v1/x', 600)).rejects.toThrow(
      /unexpected request/,
    );
  });

  it('passes when nothing is sent', async () => {
    const recorder: DeviceApiRecorder = { requests: [] };
    await expect(expectNoRequest(recorder, 'PUT', '/api/v1/x', 100)).resolves.toBeUndefined();
  });
});

describe('Gate 4 server and leftover processes (issue #17)', () => {
  it('picks a port nothing listens on', async () => {
    const port = await freePort();
    await new Promise<void>((resolve, reject) => {
      const server = createServer().listen(port, '127.0.0.1', () => server.close(() => resolve()));
      server.on('error', reject);
    });
  });

  it('finds orphans started during the call and their children', () => {
    const before = new Set([1, 10, 20]);
    const now = [
      { pid: 1, ppid: 0, uid: 1000, command: 'tini' },
      { pid: 10, ppid: 1, uid: 1000, command: 'sleep infinity' }, // existed before
      { pid: 20, ppid: 0, uid: 1000, command: 'bash' },
      { pid: 30, ppid: 1, uid: 1000, command: 'node fake-server.js' },
      { pid: 31, ppid: 30, uid: 1000, command: 'node worker.js' },
      { pid: 40, ppid: 20, uid: 1000, command: 'bash child of an exec session' },
      { pid: 50, ppid: 1, uid: 0, command: 'other user' },
      { pid: 99, ppid: 1, uid: 1000, command: 'harness itself' },
    ];
    expect(orphansSince(before, now, { pid: 99, uid: 1000 }).map((p) => p.pid)).toEqual([30, 31]);
  });
});

describe('Gate 2 budgets (issue #21)', () => {
  it('reports a budget error as a structured failure', () => {
    const output = [
      '✘ [ERROR] bundle initial exceeded maximum budget. Budget 600.00 kB was not met by 12.00 kB with a total of 612.00 kB.',
      '',
    ].join('\n');
    expect(parseBuildErrors(output)).toEqual([
      {
        where: 'angular.json budgets',
        message:
          'bundle initial exceeded maximum budget. Budget 600.00 kB was not met by 12.00 kB with a total of 612.00 kB.',
      },
    ]);
  });
});
