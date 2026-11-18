# REQ-NET: ネットワーク設定画面（IPv4）

> サンプル要件。実案件では本ディレクトリを案件の要件に置き換える。

## 背景

現行の `features/legacy-network/` は読み取り専用の仮画面で、設定変更はサービスツールでしかできない。
フロントパネルから IPv4 設定を確認・変更できる画面を新設する。旧画面は保守用として当面残す。

## 機能要件

| ID | 要件 |
| --- | --- |
| REQ-NET-001 | `/settings/network` に「ネットワーク設定」画面を新設し、ホームメニューの末尾に入口を追加する。既存のメニュー項目は変更しない。 |
| REQ-NET-002 | 画面表示時に現在の IPv4 設定（DHCP 有効/無効、IP アドレス、サブネットマスク、デフォルトゲートウェイ）を機器から取得して表示する。取得中は読込中表示を出す。 |
| REQ-NET-003 | LAN のリンク状態を LED インジケーターで表示する（リンクアップ: 緑、リンクダウン: 赤）。5 秒周期で更新する。 |
| REQ-NET-004 | DHCP を有効にすると、IP アドレス・サブネットマスク・ゲートウェイの入力を無効化する。 |
| REQ-NET-005 | IP アドレス・サブネットマスク・ゲートウェイは IPv4 形式で入力検証し、不正な項目の直下にエラーを表示する。不正な間は保存できない。 |
| REQ-NET-006 | 「保存」で設定を機器へ送信する。成功時は「保存しました」と表示し、受付音（accept）を鳴らす。 |
| REQ-NET-007 | 機器が項目エラー（HTTP 400）を返した場合、該当項目の直下に機器のメッセージを表示し、編集を継続できる。 |
| REQ-NET-008 | 機器が動作中（HTTP 503）の場合、「機器が動作中のため保存できません」を警告色で表示し、エラー音（error）を鳴らす。 |
| REQ-NET-009 | 「キャンセル」でホーム画面へ戻る。 |

## 非機能要件

| ID | 要件 |
| --- | --- |
| REQ-NET-N01 | 画面は 800×480 に収まり、スクロールなしで全項目を操作できる。 |
| REQ-NET-N02 | タッチ対象は 48px 以上（`--panel-touch-target-min`）。 |
| REQ-NET-N03 | REST API 呼び出しは既存の `ApiClient` を使い、エラーは `ApiError.kind` で分岐する。 |
| REQ-NET-N04 | 新規 Component / Service の Unit Test カバレッジ（行）は 80% 以上。 |

## 参照

- 画面デザイン: `../ui-design/network-settings.html`, `../ui-design/network-settings.css`
- REST API: `../api-specs/device-api.openapi.yaml`
- 画面要素と API の対応: `../ui-bindings/ui-bindings.yaml`
- サブシステムテスト: `../subsystem-tests/ST-NET-network-settings.xlsx`
