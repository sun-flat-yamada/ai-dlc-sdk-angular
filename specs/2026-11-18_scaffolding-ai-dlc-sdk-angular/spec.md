# AI-DLC In-Repository SDK & Harness Specification (`spec.md`)

## 1. コンセプトと前提条件

本仕様書は、**すでに存在する組込み機器フロントパネルGUIアプリケーション（Angular製）のコードベース内**に、AI駆動開発ライフサイクル（AI-DLC）を実行するための **Skills、関連ツール群、インプット格納庫、既存資産の参照ドキュメント、および自律ループ実行ハーネス** を整備（Scaffolding）するための定義書である。

スタンドアロンの外部ツールを作るのではなく、既存リポジトリの構造を尊重・保護しながら、以下のワークフローを **GitHub Copilot CLI** を実行エンジンとして自律駆動できる環境をリポジトリ内に構築する。

1. **インプットと参照知識の分離配置**: 要件・HTML/CSSデザイン仕様・REST API仕様・Excelサブシステムテスト仕様書を所定のインプット枠に配置し、既存コードの流用/変更/削除ルールを参照ドキュメントとしてAIに参照させる。
2. **Skills 駆動の自律実装**: 整備された各フェーズ用 Skill（`SKILL.md` と補助スクリプト）を GitHub Copilot CLI が参照し、要件から Angular 実装および Unit Test 作成・検証までを自律実施する。
3. **Excelサブシステムテストによる最終品質ゲートと最大 $N$ 回ループ**: 人間が作成したExcelのサブシステムテスト仕様書から自動テストを生成して最終品質ゲートとし、クリアするまで最大 $N$ 回（パラメーター指定可能）自律的に改善ループを回す。
4. **人間解釈軸でのリバース設計書生成と QCD 比較**: ゲート通過後、人間がレビュー・保守するための軸で設計書をリバース生成し、同一要件を人間が開発した際の実績データと QCD（Quality / Cost / Delivery）を定量比較する。

---

## 2. 既存コードベースへの配置ディレクトリ構造 (Scaffolding 対象)

Claude Code は既存の Angular プロジェクト（`src/`, `angular.json`, `package.json` 等が存在する前提）を破壊せず、以下の `.ai-dlc/` および `.github/skills/` 構造を整備すること。

```text
<既存AngularリポジトリRoot>/
├── src/                                   # [既存] Angular アプリケーションコードベース
├── angular.json                           # [既存] Angular CLI 設定
├── package.json                           # [既存] 最小限の aidlc:* スクリプトのみ追加
├── spec.md                                # 本仕様書
│
├── .github/
│   └── skills/                            # AI-DLC 実行用 Skills 定義群 (Copilot CLI / Agent 参照用)
│       ├── 01-context-and-boundary/       # 既存コード構造把握＆境界ポリシー遵守 Skill
│       │   └── SKILL.md
│       ├── 02-angular-panel-impl/         # HTML/CSS・REST API仕様からのAngular実装＆UnitTest Skill
│       │   └── SKILL.md
│       ├── 03-excel-subsystem-gate/       # Excelテスト仕様からのE2E自動テスト生成＆ゲート検証 Skill
│       │   └── SKILL.md
│       ├── 04-self-healing-fix/           # ゲート失敗ログ・境界違反からの自律原因分析＆修正 Skill
│       │   └── SKILL.md
│       ├── 05-reverse-spec-doc/           # 人間解釈軸での設計書リバース生成 Skill
│       │   ├── SKILL.md
│       │   └── templates/                 # 設計書出力用 Markdown / Mermaid テンプレート
│       └── 06-qcd-benchmark/              # 人間開発実績との QCD 定量比較レポート生成 Skill
│           └── SKILL.md
│
└── .ai-dlc/                               # AI-DLC ハーネス本体・入出力ワークスペース
    ├── config/
    │   ├── aidlc.config.yaml              # ループ最大回数(N)・Copilot CLI設定・ゲート閾値
    │   └── boundary-policy.yaml           # 既存コードの流用/変更禁止/再構築/削除/無視の領域指定
    │
    ├── inputs/                            # 【インプット配置領域】(開発案件ごとに人間が投入)
    │   ├── requirements/                  # 機能要件・業務要件ドキュメント (Markdown/YAML)
    │   ├── ui-design/                     # 組込みフロントパネル HTML / CSS デザイン仕様・モック資産
    │   ├── api-specs/                     # REST API リソース仕様 (OpenAPI YAML/JSON 等)
    │   ├── subsystem-tests/               # 人間作成のサブシステムテスト仕様書 (Excel: *.xlsx)
    │   └── human-baseline/                # 同一要件の人間開発 QCD 実績データ (human-qcd.json)
    │
    ├── references/                        # 【参照ドキュメント領域】(既存コードベースの不変知識)
    │   ├── existing-architecture.md       # 既存Angular構造・共通モジュール・状態管理の解説
    │   ├── panel-hardware-constraints.md  # 組込みフロントパネル制約 (解像度・タッチUI・通信制御)
    │   ├── reusable-catalog.md            # 流用すべき既存Service / Component / Pipe カタログ
    │   └── coding-and-test-conventions.md # 既存の規約・UnitTest / E2E テスト記述標準
    │
    ├── tools/                             # 【関連ツール・ハーネススクリプト群】(Node.js / TypeScript)
    │   ├── tsconfig.json
    │   ├── orchestrator.ts                # 最大N回の自律ループ＆フェーズ進行コントローラー
    │   ├── copilot-cli-adapter.ts         # GitHub Copilot CLI 呼び出し・コンテキスト注入・計測ラッパー
    │   ├── boundary-guard.ts              # Git差分による既存コード境界ポリシー検査・自動Revert
    │   ├── excel-to-test-ast.ts           # Excel (.xlsx) テスト仕様書を構造化JSONへ変換するパーサー
    │   ├── gate-runner.ts                 # Build / UnitTest / SubsystemTest 一括評価＆ログ構造化
    │   └── qcd-calculator.ts              # 実行テレメトリ集計＆人間実績とのQCD比較算出スクリプト
    │
    └── outputs/                           # 【生成物・評価レポート出力領域】
        ├── generated-tests/               # Excel仕様から変換された中間JSONおよび自動テストコード
        ├── reverse-docs/                  # 実装後に人間解釈軸でリバース生成された設計書一式
        ├── telemetry/                     # 各イテレーション(1..N)の実行ログ・トークン・所要時間記録
        └── reports/                       # 最終品質ゲート判定結果および QCD 比較レポート
```

---

## 3. 既存コードベースの境界管理と参照ドキュメント整備

既存のコードベースを安全かつ効率的に扱うため、`.ai-dlc/config/boundary-policy.yaml` と `.ai-dlc/references/` を連携させる。

### 3.1 境界ポリシー定義 (`.ai-dlc/config/boundary-policy.yaml`)
既存コードの各パス（Globパターン）を以下の5つのゾーンに分類し、AIの行動制約とツールによる機械的ガードを行う。

1. **`immutable` (流用・変更禁止領域)**:
   - 例: `src/app/core/**`, `src/app/shared/hardware-bridge/**`, `src/styles/base-panel.scss`
   - **AIの振る舞い**: 積極的に流用（importして利用）するが、ファイル自体の変更は禁止。`.ai-dlc/references/reusable-catalog.md` に公開インターフェースを記載して参照させる。
   - **機械的ガード**: `boundary-guard.ts` が Git diff を検査し、変更が検出された場合は自動で `git checkout -- <file>` を実行し、違反警告を次ループへフィードバックする。
2. **`extensible` (構造維持・最小限追記のみ許可する領域)**:
   - 例: `src/app/app.routes.ts`, `src/app/app.config.ts`, `src/environments/**`
   - **AIの振る舞い**: 既存の構造や既存エントリを変更せず、新規画面のルーティング登録やDIプロバイダ追加のみを許可する。
3. **`rebuildable` (作り直し・新規実装領域)**:
   - 例: `src/app/features/<target-feature>/**`, `src/app/api/<target-resource>/**`
   - **AIの振る舞い**: インプットされた要件・HTML/CSS仕様・REST API仕様に基づき、Component / Service / State および Unit Test（`*.spec.ts`）を自由に新規実装・再構築する。
4. **`deletable` (削除・置換許可領域)**:
   - 例: `src/app/features/legacy-*/**`, `src/app/mocks/deprecated-*`
   - **AIの振る舞い**: 新実装への置き換えに伴い不要となった旧モジュールや仮実装を、AIの判断で削除または置換してよい領域。
5. **`ignored` (無視・コンテキスト除外領域)**:
   - 例: 無関係な他機能モジュール、`dist/**`, `node_modules/**`, `.git/**`
   - **AIの振る舞い**: トークン浪費とハルシネーションを防ぐため、プロンプトおよび検索対象から完全に除外する。

### 3.2 既存コードの初期スキャンによる参照ドキュメント生成
Claude Code は Scaffolding 時に既存の `src/` 配下を解析し、`.ai-dlc/references/` 配下の初期ドキュメントテンプレート（既存アーキテクチャ概要、流用可能モジュール一覧、フロントパネル画面制約）を実態に合わせて生成・配置すること。

---

## 4. 整備すべき Skills 仕様 (`.github/skills/`)

GitHub Copilot CLI が各フェーズで呼び出す Skills を以下の通り整備する。各 `SKILL.md` には **役割、参照すべき `.ai-dlc/inputs/` と `.ai-dlc/references/` のパス、実行コマンド、完了条件** を明記すること。

### Skill 1: `01-context-and-boundary` (コンテキスト把握と設計計画)
- **入力**: `.ai-dlc/inputs/requirements/`, `.ai-dlc/config/boundary-policy.yaml`, `.ai-dlc/references/*`
- **処理**: 既存コードのうち「何をそのまま流用し」「どこを新規実装/作り直し」「何を削除するか」の変更影響マップを策定する。

### Skill 2: `02-angular-panel-impl` (フロントパネル実装 & Unit Test 自律実行)
- **入力**:
  - 画面デザイン仕様（`.ai-dlc/inputs/ui-design/` 内の HTML / CSS）
  - REST API リソース仕様（`.ai-dlc/inputs/api-specs/` 内の OpenAPI / JSON スキーマ）
- **処理**:
  - 指定された HTML 構造と CSS スタイル仕様を組込みフロントパネル用 Angular Component（テンプレート・スタイル・イベントバインディング）へ正確に統合する。
  - REST API リソース仕様に合致する通信 Service と型定義を実装（既存の共通 HTTP 基盤があれば流用）する。
  - Component および Service の Unit Test（`*.spec.ts`）を作成・実行し、正常系・API異常系・画面状態変化を網羅して全件パスさせる。

### Skill 3: `03-excel-subsystem-gate` (Excelサブシステムテスト変換 & 最終品質ゲート)
- **入力**: `.ai-dlc/inputs/subsystem-tests/*.xlsx`
- **処理**:
  1. 補助ツール `excel-to-test-ast.ts` を呼び出し、人間が記述した Excel テストシート（前提条件、機器初期状態、フロントパネル操作手順、期待される画面表示/CSS状態、期待されるREST APIリクエスト）を構造化 JSON（`.ai-dlc/outputs/generated-tests/subsystem-cases.json`）に変換する。
  2. 構造化 JSON と実装済み Angular 画面の DOM / ルーティング / API エンドポイントを紐付け、自動実行可能なサブシステムテストコード（Playwright E2E テスト + REST API モック検証）を生成する。
  3. テストを実行し、全テストケースの合否を **最終品質ゲート（Final Quality Gate）** として判定する。

### Skill 4: `04-self-healing-fix` (自律デバッグ・改善フィードバック)
- **入力**: 直前イテレーションの失敗ログ（境界違反、ビルドエラー、Unit Test 失敗、Excel由来サブシステムテストの失敗トレース・DOM差分・APIペイロード不一致）
- **処理**: 失敗原因が「HTML/CSS仕様の反映漏れ」「REST API仕様の解釈誤り」「既存流用モジュールの呼び出し規約違反」「テストコード側のセレクタ不整合（ただし期待値自体の改ざんは厳禁）」のどれにあるかを特定し、最小差分で修正を行う。

### Skill 5: `05-reverse-spec-doc` (人間解釈軸での設計書リバース生成)
- **実行タイミング**: 最終品質ゲート通過後
- **処理**: コードの単純なファイル別要約ではなく、**人間がレビュー・保守・合意形成を行うための4つの解釈軸** で `.ai-dlc/outputs/reverse-docs/` に設計書（Markdown + Mermaid 図）をリバース生成する。
  1. **`01-reuse-and-delta-architecture.md` (既存流用と変更差分アーキテクチャ)**:
     - 既存の流用領域（`immutable`）と今回新規実装・再構築した領域（`rebuildable`）、削除した領域（`deletable`）の結合関係を Mermaid コンポーネント図で可視化。
  2. **`02-panel-screen-and-state-spec.md` (フロントパネル画面仕様・状態遷移設計書)**:
     - 投入された HTML/CSS デザイン仕様がどの Angular Component に実装されたかの対応表、および組込み機器特有の画面状態遷移図（Mermaid `stateDiagram-v2`）。
  3. **`03-rest-api-sequence-spec.md` (REST API リソース連携・シーケンス設計書)**:
     - フロントパネルのタッチ操作から REST API リソース呼び出し、正常/異常レスポンス時の画面反映までのシーケンス図（Mermaid `sequenceDiagram`）とデータマッピング表。
  4. **`04-requirement-test-traceability.md` (要件・UnitTest・サブシステムテスト追跡表)**:
     - 「要件項目」×「実装モジュール」×「Unit Test」×「ExcelサブシステムテストID」の完全なトレーサビリティマトリクス。

### Skill 6: `06-qcd-benchmark` (人間開発との QCD 定量比較レポート)
- **入力**: `.ai-dlc/outputs/telemetry/run-history.json`, `.ai-dlc/inputs/human-baseline/human-qcd.json`
- **処理**: 補助ツール `qcd-calculator.ts` を実行し、同一要件における人間開発実績と AI-DLC 実績を以下の軸で比較した `.ai-dlc/outputs/reports/qcd-comparison-report.md` を生成する。
  - **Quality (品質)**: Excelサブシステムテスト合格率推移（初回 vs 最終）、Unit Test カバレッジ、静的解析警告数、人間開発時の摘出バグ密度との比較。
  - **Cost (コスト)**: GitHub Copilot CLI 呼び出し回数・推定消費トークン・AI実行コスト＋人間の仕様配置/レビュー工数 vs 人間開発の総工数（人時/人日）およびコスト削減率（%）。
  - **Delivery (納期)**: 要件投入から最終品質ゲート通過・リバース設計書生成完了までの実リードタイム（分/時間）とループ回数（$k / N$ 回） vs 人間開発の設計・実装・UnitTest・サブシステムテスト消化にかかった期間および納期短縮率（%）。

---

## 5. GitHub Copilot CLI 自律ループハーネス仕様 (`.ai-dlc/tools/`)

### 5.1 オーケストレーターと最大 $N$ 回ループ制御 (`orchestrator.ts`)
CLI 引数 `--max-iterations <N>`（または `aidlc.config.yaml` の `loop.maxIterations`）で指定された回数 $N$ を上限として、以下の自律ループを実行する。

```text
[事前準備: Excelテスト仕様のパース & 境界チェック用Gitスナップショット記録]
       │
       ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 自律改善ループ (Iteration i = 1 .. N)                                   │
│                                                                         │
│  Step 1: プロンプト＆コンテキスト構築                                   │
│          - 初回(i=1): Skill 01, 02, 03 + inputs/ + references/ を注入   │
│          - 2回目以降(i>1): Skill 04 + 前回Gateの失敗詳細ログを注入      │
│                                                                         │
│  Step 2: GitHub Copilot CLI の非対話実行 (`copilot-cli-adapter.ts`)     │
│          - 実装コード、Unit Test、サブシステム自動テストの生成・修正    │
│          - 実行時間・CLI呼び出しログを Telemetry に記録                 │
│                                                                         │
│  Step 3: 段階的品質ゲート評価 (`gate-runner.ts`)                        │
│          - [Gate 1: 境界保護] `boundary-guard.ts` による変更領域検証    │
│            (immutable 変更時は自動 Revert して即座に次イテレーションへ) │
│          - [Gate 2: ビルド＆静的解析] Angular build / tsc / lint        │
│          - [Gate 3: Unit Test] 単体テスト全件パス＆カバレッジ閾値判定   │
│          - [Gate 4: 最終品質ゲート] Excel由来サブシステム自動テスト実行 │
│                                                                         │
│  ── Gate 1〜4 すべて PASS? ──► [YES] ──► ループ完了 (Post-Processへ)    │
│               │                                                         │
│              [NO]                                                       │
│               ▼                                                         │
│     失敗原因の構造化抽出 (エラー箇所・期待値差分を次周回コンテキストへ) │
└───────────────┼─────────────────────────────────────────────────────────┘
                │ (i < N の場合は i+1 へ継続)
                ▼
     [ i == N 到達時: 未解決課題サマリを出力してループ終了 ]
                │
                ▼
[事後処理 (Post-Process)]
  1. Skill 05 実行 (Copilot CLI): 人間解釈軸でのリバース設計書一式を生成
  2. Skill 06 実行 (`qcd-calculator.ts` + Copilot CLI): QCD比較レポート生成
```

### 5.2 GitHub Copilot CLI アダプター (`copilot-cli-adapter.ts`)
- GitHub Copilot CLI（`gh copilot` / Copilot Agent CLI コマンド）をサブプロセスとして呼び出すラッパーを実装する。
- 設定ファイル（`aidlc.config.yaml`）で CLI コマンドテンプレートやオプションフラグを柔軟に切り替えられる設計とし、ローカルでのハーネス動作検証用に `--dry-run` モードも備えること。
- 各呼び出しの「開始・終了時刻」「対象 Skill」「入出力テキストサイズ（推定トークン数）」「変更されたファイル一覧」を `.ai-dlc/outputs/telemetry/run-history.json` に自動追記する。

---

## 6. `package.json` に追加する実行インターフェース

既存 Angular プロジェクトの `package.json` の `scripts` に、以下のコマンドエントリを追加して人間または CI からワンコマンドで実行できるようにする。

```json
{
  "scripts": {
    "aidlc:init-check": "tsx .ai-dlc/tools/orchestrator.ts --mode validate-env",
    "aidlc:parse-excel": "tsx .ai-dlc/tools/excel-to-test-ast.ts",
    "aidlc:guard": "tsx .ai-dlc/tools/boundary-guard.ts",
    "aidlc:gate": "tsx .ai-dlc/tools/gate-runner.ts",
    "aidlc:run": "tsx .ai-dlc/tools/orchestrator.ts --mode full-loop",
    "aidlc:reverse-doc": "tsx .ai-dlc/tools/orchestrator.ts --mode reverse-doc",
    "aidlc:qcd": "tsx .ai-dlc/tools/qcd-calculator.ts"
  }
}
```
※ 最大ループ回数 $N$ は `npm run aidlc:run -- --max-iterations 5` のように引数でオーバーライド可能とする。

---

## 7. Claude Code への Scaffolding 実行手順 (Action Items)

Claude Code は本 `spec.md` を読み込んだら、以下のステップを順番に実行して環境を整備せよ。

1. **既存コードベースの非破壊調査**:
   - ルートの `package.json`, `angular.json`, `tsconfig.json`, および `src/` 配下のディレクトリ構造を確認する（既存コードは変更しないこと）。
2. **`.ai-dlc/` ワークスペースと設定ファイルの生成**:
   - `.ai-dlc/config/aidlc.config.yaml` と `.ai-dlc/config/boundary-policy.yaml` を生成する。`boundary-policy.yaml` には現在の `src/` 構造を反映した初期ルール（`immutable`, `extensible`, `rebuildable`, `deletable`, `ignored`）を記述する。
   - `.ai-dlc/inputs/` 配下の各ディレクトリと、配置方法を記載した `README.md` およびサンプルデータ（ダミーの要件、HTML/CSS断片、OpenAPIサンプル、Excelテスト仕様書のサンプル生成スクリプト、`human-qcd.json` サンプル）を配置する。
3. **参照ドキュメント（`.ai-dlc/references/`）の初期生成**:
   - 既存コードベースをスキャンし、`existing-architecture.md`, `panel-hardware-constraints.md`, `reusable-catalog.md`, `coding-and-test-conventions.md` を作成する。
4. **Skills 一式（`.github/skills/01〜06`）の作成**:
   - セクション4で定義した6つの `SKILL.md` と、リバース設計書用のテンプレート群（`templates/*.md`）を作成する。
5. **ハーネスツール群（`.ai-dlc/tools/`）の実装**:
   - `orchestrator.ts`, `copilot-cli-adapter.ts`, `boundary-guard.ts`, `excel-to-test-ast.ts`, `gate-runner.ts`, `qcd-calculator.ts` を TypeScript で実装する。
6. **動作確認テストの実施**:
   - `--dry-run` モードで `npm run aidlc:run -- --max-iterations 3 --dry-run` を実行し、境界チェック、Excelテスト変換、最大 $N$ 回ループ制御、リバース設計書出力、QCD比較レポート生成の一連のパイプラインがエラーなく完走することを検証する。
