# Input format: binding the HTML/CSS design to the REST API

## Principle

An AI implements reliably when every kind of information has **exactly one owner** and the owners are
connected by **stable IDs** instead of prose.

| Information | Owner | Stable ID |
| --- | --- | --- |
| Why / what (requirements) | `requirements/*.md` | `REQ-xxx-nnn` |
| Structure and look | `ui-design/*.html` + `*.css` | `data-ui-id="<ui-id>"` |
| External contract | `api-specs/*.openapi.yaml` | `operationId` |
| **UI ⇄ API ⇄ state** | **`ui-bindings/ui-bindings.yaml`** | references both IDs |
| Acceptance | `subsystem-tests/*.xlsx` | case ID, `@ui-id` |

HTML/CSS and OpenAPI alone leave the binding, the state transitions and the error behaviour implicit; the
model fills the gap by guessing. The binding file makes them explicit and machine-checkable (Gate 0).

### Background

- Spec-driven development (GitHub Spec Kit) moves the source of truth from chat to versioned spec artifacts
  that the agent executes against.
- Arazzo 1.1 (OpenAPI Initiative, May 2026) standardizes *API-call sequences* and can reference AsyncAPI,
  but it has no notion of UI elements — the UI binding still needs its own artifact.
- Making states and transitions explicit before code (statecharts / SCXML) improves the state consistency
  of LLM-generated code (arXiv:2510.24019), which is why `states` / `transition` are first-class here.

## `ui-bindings.yaml`

JSON Schema: [`.ai-dlc/config/schemas/ui-bindings.schema.json`](../.ai-dlc/config/schemas/ui-bindings.schema.json)
(VS Code validates and completes it with the YAML extension; see `.vscode/settings.json`).

```yaml
version: 1
apiSpecs: [device-api.openapi.yaml]
screens:
  network-settings:                    # screen id
    title: ネットワーク設定
    route: /settings/network
    requirements: [REQ-NET-001, ...]
    design: network-settings.html      # in inputs/ui-design/
    states: [loading, editing, saving, saved, error]
    initial: loading
    onEnter: { call: getIpv4Settings, success: { transition: editing }, errors: { default: { transition: error } } }
    static: [network-settings-page]    # decorative data-ui-ids
    elements:
      ip-address:
        kind: input                    # button | toggle | input | select | indicator | text | list | container
        bind: body.address             # form field -> form.address
        validate: ipv4
        enabledWhen: "state == 'editing' && !form.dhcp"
      link-led:
        kind: indicator
        source: { call: getNetworkLink, poll: 5s, path: $.link }
        map: { up: led--on, down: led--off }      # value -> CSS class
      save-button:
        kind: button
        enabledWhen: "state == 'editing' && form.valid && device.isOperable"
        on:
          press:
            call: putIpv4Settings
            request: { address: form.address, ... }
            transition: saving
            success: { transition: saved, show: message.saved, feedback: accept }
            errors:                                 # keys = ApiError.kind (+ default)
              validation: { transition: editing, show: fieldErrors, feedback: error }
              busy:       { transition: editing, show: message.busy, feedback: error }
              default:    { transition: editing, show: message.failed }
```

Expression vocabulary (for the implementer, not evaluated by the harness): `state`, `form.<field>`,
`form.valid`, `form.<field>.invalid`, `device.isOperable`, `response.<path>`.

### What Gate 0 checks

| Check | Level |
| --- | --- |
| Schema (kinds, kebab-case IDs, events, error kinds, poll format, JSONPath form) | error |
| Every bound element exists as `data-ui-id` in the design; every `data-ui-id` is bound or `static`; no duplicates; IDs unique across screens | error |
| `initial` / every `transition` is a declared state | error |
| `call` exists as `operationId`; `request` keys exist in the request schema; `source.path` exists in the response schema | error |
| Required request properties not mapped; error outcomes without a matching OpenAPI response; OpenAPI error responses without an outcome | warning |
| Operation not bound anywhere (mark shared ones with `x-ui-binding: shared`) | warning |
| Requirement IDs not found in `requirements/` | warning |
| Excel `@ui-id` references that do not exist | error |

## Design HTML

- A static mock per screen. Put `data-ui-id` on every element the implementation must reproduce.
- Use the design tokens (`var(--panel-*)`) in the CSS; mark values that tests assert, e.g. `/* (test) */`.
- Placeholder values are fine; texts (labels, messages) are copied verbatim by the implementation.

## OpenAPI

- An `operationId` on every operation, JSON request / response schemas, and every error response the device
  really returns (400 with `fieldErrors`, 409 / 503 busy, 404).

## Excel subsystem tests

| Column (EN / JA) | Notation |
| --- | --- |
| Test ID / テストID | Unique, e.g. `ST-NET-003` |
| Category / 大項目 | May be left blank below the first row of a group |
| Steps / 操作手順 | Numbered lines; refer to elements as `@ui-id` |
| API responses / API応答(モック) | `GET /api/v1/x -> 200 {json}` per line, in call order |
| Expected UI / 期待画面表示 | Free text with `@ui-id` |
| Expected CSS / 期待CSS状態 | `@ui-id { property: computed-value }` |
| Expected API request / 期待APIリクエスト | `PUT /api/v1/x {json subset}` |
| Notes / 備考 | Requirement IDs (`REQ-…`) for traceability |

Other header names can be added in `aidlc.config.yaml` → `excel.headerAliases`.

## Alternatives considered

| Option | Verdict |
| --- | --- |
| A. HTML/CSS + OpenAPI + a Markdown screen specification | Easy to write, but not machine-checkable; the AI still interprets prose. |
| **B. Binding file with stable IDs (adopted)** | Small learning cost; Gate 0, binding matrix, traceability and deterministic test selectors come for free. |
| C. OpenAPI + Arazzo + AsyncAPI + SCXML / XState + HTML | Standards-based but four formats, and the UI binding is still missing. Can be layered on later (`source` → AsyncAPI channel, `states` → SCXML export). |
