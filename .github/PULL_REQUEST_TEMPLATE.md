## 概要

<!-- この PR の目的と解決する課題を簡潔に記述してください。 -->

- Closes #

## 変更の種類

- [ ] ✨ 機能追加（ハーネス / Skills / サンプルアプリ）
- [ ] 🐛 バグ修正
- [ ] 📝 ドキュメント
- [ ] ♻️ リファクタリング（動作変更なし）
- [ ] 🧪 テスト / CI
- [ ] 🔧 入力フォーマット（`ui-bindings.yaml` スキーマ、Excel 列、OpenAPI の扱い）の変更

## 主な変更点

-

## 品質ゲート（必須）

- [ ] `npm run gate`（typecheck → lint → unit → harness tests → secret-scan → build）が成功
- [ ] `npm run aidlc:validate-inputs` が 0 errors
- [ ] `npm run aidlc:run -- --max-iterations 3 --dry-run` が完走
- [ ] 入力フォーマットを変えた場合は `npm run aidlc:schemas` で JSON Schema を再生成し、`docs/` と `.ai-dlc/inputs/README.md` を更新

## 互換性

- [ ] 既存リポジトリへ導入済みのハーネス（`aidlc:install`）への影響を確認した
