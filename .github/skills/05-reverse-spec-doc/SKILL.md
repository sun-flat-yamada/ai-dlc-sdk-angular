---
name: 05-reverse-spec-doc
description: Reverse-generate human-oriented design documents (reuse and delta architecture, screen and state spec, REST API sequence spec, requirement-test traceability) from the implemented Angular code after the AI-DLC quality gate. Use in the post-processing phase.
---

# 05 — Reverse design documents along human interpretation axes

## Role

Produce design documents that a reviewer or maintainer reads to **agree on and maintain** the change —
not file-by-file summaries. The harness has already rendered the templates with deterministic facts;
your job is to complete and correct them from the actual code.

## Inputs

- `.ai-dlc/outputs/reverse-docs/*.md` — pre-filled from `templates/` (tables and diagram skeletons).
- `.ai-dlc/outputs/reverse-docs/reverse-doc-facts.json` — zones, changed files, components, services,
  routes, Excel cases with requirement IDs.
- The code under `src/app/`, `ui-bindings.yaml`, OpenAPI, requirements, `change-impact-map.md`, `final-quality-gate.md`.

## Documents

| File | Axis | Must contain |
| --- | --- | --- |
| `01-reuse-and-delta-architecture.md` | What was reused, added, rebuilt, deleted | Mermaid component diagram grouped by zone; table of changes; why each deletion was safe |
| `02-panel-screen-and-state-spec.md` | Screen ↔ design ↔ component | Mapping table design HTML → component → `data-ui-id`; `stateDiagram-v2` per screen from the implemented states and transitions |
| `03-rest-api-sequence-spec.md` | Touch → API → screen | `sequenceDiagram` per operation incl. success and each handled `ApiError.kind`; data mapping table (form field ↔ request field ↔ response field ↔ display) |
| `04-requirement-test-traceability.md` | Requirement ↔ code ↔ tests | Requirement × implementation module × unit test × Excel case ID; list uncovered requirements explicitly |

## Rules

1. Describe the code **as implemented**. Where it deviates from the inputs, say so in a "Deviations" section.
2. Keep every `<!-- AI: ... -->` instruction satisfied, then delete the comment.
3. Replace placeholder rows such as `_(to be mapped)_` with real entries.
4. Mermaid must render on GitHub (no HTML in labels, quote labels with spaces).
5. Language: as stated in the prompt (`output.language`). Identifiers, paths and code stay unchanged.
6. Write only in `.ai-dlc/outputs/reverse-docs/`.
