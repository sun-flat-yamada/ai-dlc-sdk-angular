# `.ai-dlc/inputs/` — human inputs (read-only for the AI)

Place the inputs of one development item here. The harness and the AI never modify this directory
(`immutable` in `boundary-policy.yaml`). The files in this repository are a **sample**
(network settings screen, `REQ-NET`); replace them with your project's inputs.

| Directory | Content | Format | Owner of |
| --- | --- | --- | --- |
| `requirements/` | Functional / non-functional requirements with IDs (`REQ-xxx-001`) | Markdown / YAML | *Why* and *what* |
| `ui-design/` | Screen design mock. Every element the implementation must reproduce has `data-ui-id="<ui-id>"` | HTML + CSS | Structure and look |
| `api-specs/` | Device REST API with an `operationId` on every operation | OpenAPI 3.x (YAML/JSON) | External contract |
| `ui-bindings/` | `ui-bindings.yaml`: element × event → API call, request / response mapping, screen states, error handling | YAML ([JSON Schema](../config/schemas/ui-bindings.schema.json)) | The link between UI and API |
| `subsystem-tests/` | Subsystem test specification written by QA. Elements referenced as `@ui-id` | Excel `*.xlsx` | Acceptance criteria |
| `human-baseline/` | `human-qcd.json`: QCD records of the same requirement developed by humans | JSON | Benchmark |

## Why the binding file?

HTML/CSS tells *what is on the screen*, OpenAPI tells *what the device accepts*. Neither tells
which button calls which operation, which response field drives which indicator, or what the screen
does on HTTP 400 / 503. Without that, the AI guesses. `ui-bindings.yaml` states it explicitly with
stable IDs on both sides (`data-ui-id`, `operationId`), so the harness can check it mechanically
(Gate 0: `npm run aidlc:validate-inputs`) before any AI work starts.

## Checklist before `npm run aidlc:run`

1. `npm run aidlc:validate-inputs` reports **0 errors** (warnings are worth reading).
2. Every requirement ID is referenced by a screen (`requirements:`); every screen requirement is verified by an
   Excel case (`要件ID` column, or `REQ-…` in `備考` / notes).
3. Every Excel case has steps, at least one expected result (UI / CSS / API) and the mocked API responses it needs.
4. `.ai-dlc/outputs/reports/binding-matrix.md` reads correctly to a reviewer.

## Excel layout

The parser finds the header row automatically (first 15 rows) and accepts English or Japanese headers
(`テストID`, `大項目`, `テスト項目`, `優先度`, `前提条件`, `機器初期状態`, `API応答(モック)`, `操作手順`,
`期待画面表示`, `期待CSS状態`, `期待APIリクエスト`, `要件ID`, `備考`). Add other names in
`aidlc.config.yaml` → `excel.headerAliases`.

| Column | Notation |
| --- | --- |
| API応答(モック) | `GET /api/v1/network/ipv4 -> 200 {"dhcp":false}` — one line per response, in call order |
| 期待APIリクエスト | `PUT /api/v1/network/ipv4 {"address":"192.168.0.20"}` — the JSON is a subset match |
| 期待CSS状態 | `@status-message { color: rgb(255, 176, 32) }` — computed style of a `data-ui-id` element |
| 操作手順 / 期待画面表示 | Free text; refer to elements as `@ui-id` |
| 要件ID | Requirement IDs the case verifies (`REQ-NET-006`, comma- or line-separated) |

Regenerate the sample workbook with `npm run aidlc:sample-excel`.
