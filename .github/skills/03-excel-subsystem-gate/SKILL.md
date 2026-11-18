---
name: 03-excel-subsystem-gate
description: Turn the human-written Excel subsystem test specification (converted to subsystem-cases.json) into Playwright tests that form the AI-DLC final quality gate. Use after the screens are implemented, and whenever a subsystem case has no passing test.
---

# 03 — Excel subsystem tests as the final quality gate

## Role

Write one automated Playwright test per Excel case. The cases are the acceptance criteria written by
humans; your tests must check exactly what they say — no more lenient, no stricter.

## Inputs

- `.ai-dlc/outputs/generated-tests/subsystem-cases.json` (from `npm run aidlc:parse-excel`; **read-only**)
  and the readable list `subsystem-cases.md`.
- `.ai-dlc/inputs/ui-bindings/ui-bindings.yaml` — `@ui-id` in the cases are its element IDs; `route:` gives the URL.
- `.ai-dlc/tools/subsystem-kit.ts` — the only helpers you need.

Each case has: `id`, `title`, `preconditions`, `initialDeviceState`, `mockApi` (responses to serve),
`steps`, `expectedUi` (free text with `@ui-id`), `expectedCss`, `expectedApi`, `uiRefs`.

## Write

`.ai-dlc/outputs/generated-tests/subsystem/<feature>.spec.ts`:

```ts
import { expect, expectApiRequests, expectCss, expectNoRequest, loadCase, mockDeviceApi, test, ui } from '../../../tools/subsystem-kit';

test.describe('ネットワーク設定', () => {
  const c = loadCase('ST-NET-003');
  test(`[${c.id}] ${c.title}`, async ({ page }) => {
    const api = await mockDeviceApi(page, c);           // serves c.mockApi, records requests
    await page.goto('/settings/network');                // step 1 (route from ui-bindings.yaml)
    await ui(page, 'ip-address').fill('192.168.0.20');   // step 2
    await ui(page, 'save-button').click();               // step 3
    await expect(ui(page, 'status-message')).toHaveText('保存しました'); // expectedUi
    await expectCss(page, c);                            // expectedCss
    await expectApiRequests(api, c);                     // expectedApi
  });
});
```

Rules:

1. Title starts with `[<case ID>]`. One case → at least one test; a test may cover only one case.
2. Steps in order, one statement (or a small group) per step. Elements only via `ui(page, '<ui-id>')`.
3. Literal values in steps (text to type, URL) come from the case text. Expected values come from the case:
   use `expectApiRequests` / `expectCss` for the structured columns and translate each `expectedUi` line
   into an assertion (`toHaveText`, `toContainText`, `toBeDisabled`, `toBeVisible`, `toHaveURL`, ...).
   A line such as "PUT ... は送信されない" becomes `expectNoRequest(api, 'PUT', '/api/v1/...')`.
4. Never `test.skip`, `test.fixme`, `test.only`, `waitForTimeout`, or `force: true` clicks.
5. If a case cannot be automated as written, still write the test with the closest faithful assertion
   and explain why in a comment. Never weaken or delete an expectation.

## Run

```bash
npx playwright test --config .ai-dlc/tools/playwright.subsystem.config.ts
```

The harness (Gate 4) passes only when **every** case ID has a passing test, no test is skipped and
`subsystem-cases.json` still matches the Excel snapshot.

## When a test fails

Decide whether the implementation or the test is wrong (skill 04). The expectation is right by
definition; only selectors / timing in the test may be fixed.
