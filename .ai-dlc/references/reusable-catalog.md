# Reusable catalog — use these, do not re-implement them

All entries are in `immutable` zones: import them, never edit them.

## `ApiClient` — `src/app/core/http/api-client.ts`

```ts
@Injectable({ providedIn: 'root' })
class ApiClient {
  get<T>(path: string): Observable<T>;
  put<T>(path: string, body: unknown): Observable<T>;
  post<T>(path: string, body: unknown): Observable<T>;
  delete<T>(path: string): Observable<T>;
}
```

- `path` is relative to `environment.apiBaseUrl` (`/api/v1`): `api.get<Ipv4Settings>('network/ipv4')`.
- Applies `environment.requestTimeoutMs`; every error arrives as `ApiError`.
- Never inject `HttpClient` in feature code.

## `ApiError` — `src/app/core/http/api-error.ts`

| `kind` | HTTP | Typical screen reaction |
| --- | --- | --- |
| `validation` | 400, 422 | Show `fieldErrors[field]` next to the field |
| `busy` | 409, 503 | Show a warning, allow retry |
| `not-found` | 404 | Show an error |
| `timeout` | (no answer in time) | Show an error, allow retry |
| `offline` | 0 | Show an error |
| `server` | other | Show an error |

`fieldErrors: Readonly<Record<string, string>>` holds the device messages for HTTP 400.
`kind` values are the keys of `errors:` in `ui-bindings.yaml`.

## `PanelStatusService` — `src/app/core/panel-status/panel-status.service.ts`

- `status: Signal<PanelStatus>` — `{ deviceName, firmwareVersion, state: 'ready'|'busy'|'error'|'offline', alerts }`
- `isOperable: Signal<boolean>` — `state === 'ready'`; this is `device.isOperable` in `ui-bindings.yaml`.
- Polling is started by the app shell. Do not start a second poller.

## `HardwareBridgeService` — `src/app/shared/hardware-bridge/hardware-bridge.service.ts`

- `beep(tone: 'click' | 'accept' | 'error')` — `feedback:` in `ui-bindings.yaml`.
- `setBacklight(level: number)`.
- No-op in the browser; tests provide a fake through `NATIVE_PANEL_BRIDGE` or replace the service.

## `PanelButton` — `src/app/shared/ui/panel-button/panel-button.ts`

```html
<app-panel-button variant="primary" uiId="save-button" [disabled]="!canSave()" (pressed)="save()">保存</app-panel-button>
```

- Inputs: `variant` (`primary` | `secondary` | `danger`), `disabled`, `uiId` (rendered as `data-ui-id`).
- Output: `pressed`. Already plays the `click` tone — do not beep again for the click.

## `StatusBar` — `src/app/shared/ui/status-bar/status-bar.ts`

Rendered by the app shell on every screen. Screens must not render their own status bar.

## Design tokens — `src/styles/base-panel.scss`

`--panel-color-{bg,surface,surface-raised,text,text-muted,primary,success,warning,danger}`,
`--panel-font-size-{sm,md,lg}`, `--panel-touch-target-min` (48px), `--panel-radius`, `--panel-gap`.
Use tokens instead of literal colors so that computed colors match the design CSS.
