---
name: 02-angular-panel-impl
description: Implement Angular front-panel screens, REST API services and their unit tests from the HTML/CSS design, the OpenAPI spec, ui-bindings.yaml and the Excel subsystem cases (acceptance criteria). Use when an AI-DLC iteration builds or rebuilds a screen; run build, lint, unit and subsystem tests until they pass.
---

# 02 — Angular front-panel implementation and unit tests

## Role

Turn the inputs into working Angular code with passing unit tests and passing subsystem tests. The inputs have one job each:

| Input | Decides |
| --- | --- |
| `.ai-dlc/inputs/ui-design/*.html` / `*.css` | Structure, text, classes and look |
| `.ai-dlc/inputs/api-specs/*.openapi.yaml` | Paths, methods, request / response types, error codes |
| `.ai-dlc/inputs/ui-bindings/ui-bindings.yaml` | Which element triggers which operation, request mapping, response → display, states, error handling, feedback tones |
| `.ai-dlc/outputs/generated-tests/subsystem-cases.md` / `.json` (from the Excel subsystem test specification) | Acceptance: the exact texts, CSS states and API requests that must result from each operation sequence |

When they disagree, `ui-bindings.yaml` decides behaviour, the HTML/CSS decides presentation, OpenAPI decides the wire format.
The Excel cases are what the result is accepted against: build each screen so that every case passes, and treat
a conflict between a case and the other inputs as an input defect — record it in the change impact map
(Assumptions) and never change the expectation.
Read `.ai-dlc/outputs/reports/change-impact-map.md` (skill 01), `.ai-dlc/outputs/reports/binding-matrix.md` and the
Playwright tests written from the cases (skill 03, `.ai-dlc/outputs/generated-tests/subsystem/`) first.

## Implement, per screen in `ui-bindings.yaml`

1. **Types and API service** — `src/app/api/<resource>/<resource>.model.ts` (interfaces from the OpenAPI schemas)
   and `<resource>-api.ts`, one method per `operationId`, built on `ApiClient` (never `HttpClient`).
   Paths are relative to `/api/v1` (OpenAPI `servers`).
2. **Page component** — `src/app/features/<feature>/<feature>-page.ts`:
   - Template reproduces the design HTML structure, texts and classes. Copy the design CSS into the
     component styles, keeping the token variables. Every `data-ui-id` of the design appears exactly once
     (buttons: `<app-panel-button uiId="...">`).
   - State: a `signal` holding the screen state from `states:`; start in `initial:`; run `onEnter:`.
   - `bind:` → form field; `validate:` → validator; `enabledWhen` / `visibleWhen` → `computed` signals.
     `device.isOperable` is `PanelStatusService.isOperable()`.
   - `on:` actions: call the API method with the `request:` mapping, set `transition:` while pending, then
     apply `success:` / `errors.<ApiError.kind>` / `errors.default` (`show`, `transition`, `feedback`).
     `show: fieldErrors` means: display `ApiError.fieldErrors[field]` in `<field>-error`.
   - `source:` with `poll:` → poll while the screen is shown (stop on destroy); `map:` → CSS class / label.
   - `feedback:` → `HardwareBridgeService.beep(tone)` (the `click` of `PanelButton` is automatic).
3. **Wiring (extensible files, append only)** — add the route to `app.routes.ts` with `loadComponent`;
   append the menu entry to `HOME_MENU` if the requirements ask for it. Never change existing lines.
4. **Unit tests** next to each file:
   - API service: every operation, request body, each error kind mapped by `ApiError`.
   - Page: initial load, every `on:` action success path, every bound error kind, validation,
     `enabledWhen` / `visibleWhen`, polling start / stop, feedback tones. Query by `[data-ui-id]`.
   - Excel cases: for each case, the page unit tests cover the same behaviour at component level (same mocked
     responses, same expected texts / request bodies) and put the case ID in the test name, e.g.
     `it('shows 保存しました after saving (ST-NET-003)', ...)`. This keeps requirement → case → unit test
     traceable and catches a mismatch before the slower subsystem gate.
   - Follow `.ai-dlc/references/coding-and-test-conventions.md`.

## Verify (repeat until green)

```bash
npm run build
npm run lint
npm run test:coverage
npx playwright test --config .ai-dlc/tools/playwright.subsystem.config.ts
```

Coverage thresholds: statements 80, branches 70, functions 80, lines 80.

## Do not

- Edit `immutable` files (core, shared, styles, config, inputs, harness) — reuse them.
- Remove or reorder lines in `extensible` files. The only exception: the import, route entry and menu
  entries of a `deletable` file you delete in the same change (see skill 01).
- Invent operations, fields or texts that are not in the inputs. Record gaps in the change impact map.
- Edit the generated subsystem tests to make them pass, other than fixing a selector or a wait (skill 03).
- Skip tests (`it.skip`, `xit`, `.only`) or lower thresholds.
