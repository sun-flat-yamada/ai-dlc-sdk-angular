# Front-panel hardware constraints

| Constraint | Value | Consequence for the implementation |
| --- | --- | --- |
| Display | 800 × 480 px, landscape, no scrolling of the page body | Screen content area is 800 × 440 (40 px status bar). Fit every control without page scrolling. |
| Input | Resistive / capacitive touch, no keyboard, no mouse hover | No hover-only affordances. Touch targets ≥ 48 px (`--panel-touch-target-min`). Use `inputmode="decimal"` for numeric fields (on-screen keypad). |
| Feedback | Buzzer through `HardwareBridgeService` | `click` is played by `PanelButton`; play `accept` on success and `error` on failure as `ui-bindings.yaml` says. |
| CPU / memory | Low-end ARM SoC, WebView | Keep the initial bundle small (budgets in `angular.json`), lazy-load screens, avoid heavy libraries and animations. |
| Network to the device API | Local HTTP to the firmware, `/api/v1` | Requests can be slow while the device is busy: respect `requestTimeoutMs`, never fire a request per keystroke, debounce polling. |
| Device busy | The firmware answers 409 / 503 while printing / updating | Map to `ApiError.kind === 'busy'`, keep the user's input, allow retry. |
| Concurrency | One operator at a time | No optimistic locking needed; always re-read after a successful write. |
| Fonts | Noto Sans JP pre-installed | No web fonts. |
| Locale | Japanese UI text | Labels and messages come from the design HTML / `ui-bindings.yaml` verbatim. |
| Power loss | Possible at any time | Never keep unsaved state outside the screen; do not use `localStorage` for settings. |
