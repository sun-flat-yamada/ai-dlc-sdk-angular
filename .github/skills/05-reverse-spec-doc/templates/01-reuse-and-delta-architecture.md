# 既存流用と変更差分アーキテクチャ / Reuse and delta architecture

- Generated: {{generatedAt}}
- Baseline: `{{baseline}}`
- Quality gate: {{gateStatus}}

<!-- AI: Write a 3-5 sentence overview: which existing modules were reused, what was newly built, what was deleted and why. -->

## 境界ゾーン / Boundary zones

{{zoneTable}}

## コンポーネント構成 / Components by zone

{{componentDiagram}}

<!-- AI: Check the diagram against the code. Add missing dependencies (component → service → ApiClient) and mark new nodes. Keep it readable: at most ~25 nodes. -->

## 変更一覧 / Changes since the baseline

{{changeTable}}

## 流用した既存モジュール / Reused modules

<!-- AI: Table: module (immutable) | used by | how (import, DI, input). Only modules actually imported by new code. -->

## 削除・置換 / Deletions and replacements

<!-- AI: For each deleted / replaced file: why it was obsolete, and why deleting it is safe (no remaining imports, route replaced, tests removed). Write "None" when nothing was deleted. -->

## Deviations

<!-- AI: Differences between change-impact-map.md (plan) and the implementation. -->
