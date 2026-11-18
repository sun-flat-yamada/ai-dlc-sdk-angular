/**
 * Helpers for Excel-derived subsystem tests (Playwright). Generated tests MUST use them so that
 * expected values always come from `subsystem-cases.json` (never copied into test code).
 *
 *   import { test, expect, loadCase, ui, mockDeviceApi, expectApiRequests, expectCss } from '../../../tools/subsystem-kit';
 *
 *   const c = loadCase('ST-NET-003');
 *   test(`[${c.id}] ${c.title}`, async ({ page }) => {
 *     const api = await mockDeviceApi(page, c);
 *     await page.goto('/settings/network');
 *     await ui(page, 'save-button').click();
 *     await expectApiRequests(api, c);
 *   });
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, type Locator, type Page, type Request } from '@playwright/test';
import type { SubsystemCase, SubsystemCaseFile } from './lib/subsystem-cases.js';

export { expect, test } from '@playwright/test';

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
  for (const exp of testCase.expectedApi) {
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
  }
}

/** Asserts that no request matching `METHOD /path` was sent (e.g. invalid input must not be saved). */
export function expectNoRequest(recorder: DeviceApiRecorder, method: string, path: string): void {
  const hit = recorder.requests.find(
    (r) => r.method === method.toUpperCase() && pathMatches(path, r.path),
  );
  expect(hit, `unexpected request ${method} ${path}`).toBeUndefined();
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
  for (const css of testCase.expectedCss) {
    const selector = css.selector ?? (defaultUiId ? `@${defaultUiId}` : undefined);
    if (!selector) throw new Error(`[${testCase.id}] CSS expectation "${css.raw}" has no selector`);
    const locator = selector.startsWith('@') ? ui(page, selector.slice(1)) : page.locator(selector);
    await expect(locator, `[${testCase.id}] ${css.raw}`).toHaveCSS(css.property, css.value);
  }
}
