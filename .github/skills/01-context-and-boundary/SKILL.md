---
name: 01-context-and-boundary
description: Map an AI-DLC change onto the existing Angular front-panel code base before implementing. Use at the start of an AI-DLC iteration to decide what to reuse, extend, rebuild and delete under .ai-dlc/config/boundary-policy.yaml, and to write the change impact map.
---

# 01 — Context and boundary

## Role

Understand the request and the existing code base, then produce a **change impact map** that the
implementation step follows. You do not write application code in this step.

## Read

1. `.ai-dlc/inputs/requirements/*` — requirement IDs and acceptance conditions.
2. `.ai-dlc/inputs/ui-bindings/ui-bindings.yaml` and the generated `.ai-dlc/outputs/reports/binding-matrix.md`
   — screens, routes, `data-ui-id`s, API operations, states.
3. `.ai-dlc/config/boundary-policy.yaml` — zones. The most restrictive zone wins:
   `immutable > ignored > extensible > deletable > rebuildable`; unmatched paths are denied.
4. `.ai-dlc/references/*.md` — architecture, reusable catalog, hardware constraints, conventions.
5. Only the source files the map needs. Skip everything in the `ignored` zone.

## Do

1. List every requirement ID and the screen / element / operation that satisfies it.
2. For each screen in `ui-bindings.yaml` decide the files to create (normally
   `src/app/features/<feature>/` and `src/app/api/<resource>/`) and check they are in a `rebuildable` zone.
3. List the shared modules to reuse from `reusable-catalog.md` (e.g. `ApiClient`, `ApiError`,
   `PanelStatusService`, `HardwareBridgeService`, `PanelButton`).
4. List the append-only edits in `extensible` files (route, menu entry, provider) as exact lines to add.
5. List `deletable` files that become obsolete and say whether to delete them now. Deleting is optional;
   deleting a file that is still imported breaks the build — check imports first.
6. Flag anything the inputs leave open (missing operation, ambiguous behaviour). Choose the most
   conservative interpretation, record the assumption, and continue.

## Write

`.ai-dlc/outputs/reports/change-impact-map.md`:

```markdown
# Change impact map
## Requirements → implementation
| Requirement | Screen / ui-id | Operation | New / changed file |
## Reuse (immutable)
## Extensible edits (lines to append)
## New files (rebuildable)
## Deletions (deletable)
## Assumptions
```

## Done when

- Every requirement ID appears in the map.
- Every planned file path is in a zone that allows the planned change.
- Nothing outside `.ai-dlc/outputs/` was modified in this step.
