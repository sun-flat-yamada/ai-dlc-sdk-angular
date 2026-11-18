# REST API 連携・シーケンス / REST API sequence specification

- Generated: {{generatedAt}}

## API 仕様 / API specifications

{{apiSpecFiles}}

## サービスと呼び出し / Services and calls

{{serviceApiTable}}

## シーケンス / Sequences

{{apiSequences}}

<!-- AI: Replace the skeletons with the real flow from the code: the triggering ui-id and event, the state transitions, the request mapping, and one `alt` branch per ApiError.kind the code handles (validation / busy / timeout / offline / default). Include the buzzer feedback where the code plays it. -->

## データマッピング / Data mapping

<!-- AI: Per operation, a table: form field / signal | request field (OpenAPI) | response field | displayed in (ui-id) | validation. -->

## エラー処理 / Error handling

<!-- AI: Table: operation | HTTP status | ApiError.kind | screen reaction (message, state, tone) | covered by unit test (file) | covered by Excel case (ID). -->

## Deviations

<!-- AI: Differences between OpenAPI / ui-bindings.yaml and the implementation. -->
