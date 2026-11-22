/**
 * Helpers for Excel-derived subsystem tests (Playwright). Generated tests MUST use them so that
 * expected values always come from `subsystem-cases.json` (never copied into test code).
 *
 *   import { test, expect, loadCase, ui, mockDeviceApi, expectApiRequests, expectCss, expectUi } from '../../../tools/subsystem-kit';
 *
 *   const c = loadCase('ST-NET-003');
 *   test(`[${c.id}] ${c.title}`, async ({ page }) => {
 *     const api = await mockDeviceApi(page, c);
 *     await page.goto('/settings/network');
 *     await ui(page, 'save-button').click();
 *     await expectUi(c, 0, () => expect(ui(page, 'status-message')).toHaveText('保存しました'));
 *     await expectApiRequests(api, c);
 *   });
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page, type Request } from '@playwright/test';
import {
  VERIFIED_ANNOTATION,
  verifiedKey,
  type ExpectationKind,
  type SubsystemCase,
  type SubsystemCaseFile,
} from './lib/subsystem-cases.js';

export { expect, test } from '@playwright/test';

/**
 * Records that an expectation of the case was verified. Gate 4 requires a record for every
 * expectedApi / expectedCss / expectedUi entry of every case (issue #18). Generated tests must not
 * write these annotations themselves (Gate 4 rejects test files that mention them).
 */
function recordVerified(testCase: SubsystemCase, kind: ExpectationKind, index: number): void {
  try {
    test
      .info()
      .annotations.push({
        type: VERIFIED_ANNOTATION,
        description: verifiedKey(testCase.id, kind, index),
      });
  } catch {
    // Called outside a running Playwright test (unit tests of the kit): nothing to record.
  }
}

const casesFile = fileURLToPath(
  new URL('../outputs/generated-tests/subsystem-cases.json', import.meta.url),
);
let cache: SubsystemCaseFile | undefined;

/** Loads one case by ID from `subsystem-cases.json`. Throws when the ID does not exist. */
export function loadCase(id: string): SubsystemCase {
  cache ??= JSON.parse(readFileSync(casesFile, 'utf8')) as SubsystemCaseFile;
  const found = cache.cases.find((c) => c.id === id);
  if (!found) throw new Error(`Subsystem case ${id} not found in subsystem-cases.json`);
  return found;
}

/** Locator of an element by its design ID (`data-ui-id`). */
export function ui(page: Page, uiId: string): Locator {
  return page.locator(`[data-ui-id="${uiId}"]`);
}

export interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}

export interface DeviceApiRecorder {
  requests: RecordedRequest[];
}

const pathOf = (url: string) => new URL(url).pathname;

/** Matches `/api/v1/items/{id}` style templates against a concrete path. */
export function pathMatches(template: string, actual: string): boolean {
  const re = new RegExp(
    `^${template.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\?\{[^}]+\\?\}/g, '[^/]+')}$`,
  );
  return re.test(actual);
}

function bodyOf(request: Request): unknown {
  const raw = request.postData();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Serves the case's "API responses" column (`GET /api/v1/x -> 200 {...}`) for every `/api/**` call
 * and records the requests. Unmocked calls answer 404 so that missing mocks surface as failures.
 * Later lines for the same endpoint are served in order (the last one repeats).
 */
export async function mockDeviceApi(
  page: Page,
  testCase: SubsystemCase,
  extra: SubsystemCase['mockApi'] = [],
): Promise<DeviceApiRecorder> {
  const recorder: DeviceApiRecorder = { requests: [] };
  const mocks = [...testCase.mockApi, ...extra];
  const served = new Map<string, number>();
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = pathOf(request.url());
    const method = request.method().toUpperCase();
    recorder.requests.push({ method, path, body: bodyOf(request) });
    const candidates = mocks.filter((m) => m.method === method && pathMatches(m.path, path));
    if (candidates.length === 0) {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ message: `no mock for ${method} ${path}` }),
      });
      return;
    }
    const key = `${method} ${candidates[0]!.path}`;
    const index = Math.min(served.get(key) ?? 0, candidates.length - 1);
    served.set(key, index + 1);
    const mock = candidates[index]!;
    await route.fulfill({
      status: mock.status,
      contentType: 'application/json',
      body:
        mock.body === undefined
          ? ''
          : typeof mock.body === 'string'
            ? mock.body
            : JSON.stringify(mock.body),
    });
  });
  return recorder;
}

/** True when `actual` contains every field of `expected` (deep subset). */
export function isSubset(expected: unknown, actual: unknown): boolean {
  if (expected === null || typeof expected !== 'object') return Object.is(expected, actual);
  if (actual === null || typeof actual !== 'object') return false;
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((e, i) => isSubset(e, actual[i]))
    );
  }
  return Object.entries(expected as Record<string, unknown>).every(([k, v]) =>
    isSubset(v, (actual as Record<string, unknown>)[k]),
  );
}

/** Asserts that every expected API request of the case was sent (method, path, body subset). */
export async function expectApiRequests(
  recorder: DeviceApiRecorder,
  testCase: SubsystemCase,
  timeout = 5000,
): Promise<void> {
  for (const [index, exp] of testCase.expectedApi.entries()) {
    await expect
      .poll(
        () =>
          recorder.requests.some(
            (r) =>
              r.method === exp.method &&
              pathMatches(exp.path, r.path) &&
              (exp.body === undefined || isSubset(exp.body, r.body)),
          ),
        {
          message: `[${testCase.id}] expected request: ${exp.raw}\nrecorded: ${JSON.stringify(recorder.requests)}`,
          timeout,
        },
      )
      .toBe(true);
    recordVerified(testCase, 'api', index);
  }
}

/**
 * Asserts that no request matching `METHOD /path` is sent (e.g. invalid input must not be saved).
 * A request reaches the recorder asynchronously, a little after the click that triggers it, so the
 * check keeps watching for `settleMs` before it passes (issue #19). Always `await` it.
 */
export async function expectNoRequest(
  recorder: DeviceApiRecorder,
  method: string,
  path: string,
  settleMs = 1000,
): Promise<void> {
  const find = () =>
    recorder.requests.find((r) => r.method === method.toUpperCase() && pathMatches(path, r.path));
  const deadline = Date.now() + settleMs;
  while (Date.now() < deadline && !find()) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(find(), `unexpected request ${method} ${path}`).toBeUndefined();
}

/**
 * Asserts the case's CSS expectations. A selector of the form `@ui-id` targets `[data-ui-id="ui-id"]`.
 * Expectations without a selector need `defaultUiId`.
 */
export async function expectCss(
  page: Page,
  testCase: SubsystemCase,
  defaultUiId?: string,
): Promise<void> {
  for (const [index, css] of testCase.expectedCss.entries()) {
    const selector = css.selector ?? (defaultUiId ? `@${defaultUiId}` : undefined);
    if (!selector) throw new Error(`[${testCase.id}] CSS expectation "${css.raw}" has no selector`);
    const locator = selector.startsWith('@') ? ui(page, selector.slice(1)) : page.locator(selector);
    await expect(locator, `[${testCase.id}] ${css.raw}`).toHaveCSS(css.property, css.value);
    recordVerified(testCase, 'css', index);
  }
}

/**
 * Verifies one `expectedUi` line of the case: `assertion` must contain the web-first assertion(s)
 * the line describes. Every line needs its own call; Gate 4 checks that none was left out.
 *
 *   await expectUi(c, 0, () => expect(ui(page, 'status-message')).toHaveText('保存しました'));
 */
export async function expectUi(
  testCase: SubsystemCase,
  index: number,
  assertion: () => unknown,
): Promise<void> {
  const line = testCase.expectedUi[index];
  if (line === undefined)
    throw new Error(
      `[${testCase.id}] has no expectedUi[${index}] (${testCase.expectedUi.length} line(s))`,
    );
  await test.step(`[${testCase.id}] expectedUi[${index}] ${line}`, async () => {
    await assertion();
  });
  recordVerified(testCase, 'ui', index);
}
