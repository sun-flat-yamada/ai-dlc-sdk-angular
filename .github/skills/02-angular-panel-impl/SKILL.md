---
name: 02-angular-panel-impl
description: Implement Angular front-panel screens, REST API services and their unit tests from the HTML/CSS design, the OpenAPI spec and ui-bindings.yaml. Use when an AI-DLC iteration builds or rebuilds a screen; run build, lint and unit tests until they pass.
---

# 02 — Angular front-panel implementation and unit tests

## Role

Turn the inputs into working Angular code with passing unit tests. The three inputs have one job each:

| Input | Decides |
| --- | --- |
| `.ai-dlc/inputs/ui-design/*.html` / `*.css` | Structure, text, classes and look |
| `.ai-dlc/inputs/api-specs/*.openapi.yaml` | Paths, methods, request / response types, error codes |
| `.ai-dlc/inputs/ui-bindings/ui-bindings.yaml` | Which element triggers which operation, request mapping, response → display, states, error handling, feedback tones |

When they disagree, `ui-bindings.yaml` decides behaviour, the HTML/CSS decides presentation, OpenAPI decides the wire format.
Read `.ai-dlc/outputs/reports/change-impact-map.md` (skill 01) and `.ai-dlc/outputs/reports/binding-matrix.md` first.

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
   - Follow `.ai-dlc/references/coding-and-test-conventions.md`.

## Verify (repeat until green)

```bash
npm run build
npm run lint
npm run test:coverage
```

Coverage thresholds: statements 80, branches 70, functions 80, lines 80.

## Do not

- Edit `immutable` files (core, shared, styles, config, inputs, harness) — reuse them.
- Remove or reorder lines in `extensible` files.
- Invent operations, fields or texts that are not in the inputs. Record gaps in the change impact map.
- Skip tests (`it.skip`, `xit`, `.only`) or lower thresholds.
