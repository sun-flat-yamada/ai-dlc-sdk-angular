# Coding and test conventions

## Angular

- Standalone components, `ChangeDetectionStrategy.OnPush` (lint rule), `inject()` instead of constructor injection.
- Signals for state; `computed` for derived values; `input()` / `output()` functions, not decorators.
- Built-in control flow (`@if`, `@for` with `track`), no `*ngIf` / `*ngFor`.
- Forms: Reactive forms (`FormGroup` / `FormControl` with validators) or signal state; keep validation rules in one place.
- File names: `<name>-page.ts` for screens, `<resource>-api.ts` for API services, `<name>.model.ts` for types, `<name>.spec.ts` next to the file.
- Selectors: prefix `app-`, kebab-case. Templates and styles may be inline (small) or in sibling files.
- Use design tokens (`var(--panel-*)`) for colors and sizes.
- Every element in `ui-bindings.yaml` carries `data-ui-id="<ui-id>"` exactly once on the screen.
- Code, identifiers and comments in English; UI text in Japanese, copied from the design / bindings.

## Unit tests (`*.spec.ts`, Vitest via `ng test`)

- Globals: `describe`, `it`, `expect`, `vi` (no imports needed).
- HTTP: `provideHttpClient()` + `provideHttpClientTesting()`, assert with `HttpTestingController` (`expectOne`, `flush`, `verify`).
- Replace `HardwareBridgeService` / `PanelStatusService` with simple fakes via `providers`.
- Render with `TestBed.createComponent(...)` then `await fixture.whenStable()` (zoneless).
- Query elements by `[data-ui-id="..."]`.
- Cover for every API call: success, each `ApiError.kind` bound in `ui-bindings.yaml`, and the resulting screen state.
- Never `it.skip`, `xit`, `it.only`. Coverage thresholds: statements 80, branches 70, functions 80, lines 80.

## Subsystem tests (Playwright, generated from Excel)

- Location: `.ai-dlc/outputs/generated-tests/subsystem/<sheet-or-feature>.spec.ts`.
- One `test()` per Excel case, title starting with `[<case ID>]`.
- Import helpers from `.ai-dlc/tools/subsystem-kit.ts`: `loadCase`, `ui`, `mockDeviceApi`, `expectApiRequests`, `expectNoRequest`, `expectCss`.
- Expected values come from `loadCase(id)`; do not copy them into the test.
- Select elements with `ui(page, '<ui-id>')` only.

## Commands

| Purpose | Command |
| --- | --- |
| Build | `npm run build` |
| Lint | `npm run lint` |
| Unit tests + coverage | `npm run test:coverage` |
| Subsystem tests | `npx playwright test --config .ai-dlc/tools/playwright.subsystem.config.ts` |
| All gates | `npm run aidlc:gate` |
