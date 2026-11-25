---
name: 04-self-healing-fix
description: Diagnose and fix failures reported by the AI-DLC quality gates (boundary violations, build or lint errors, unit test failures, Excel-derived subsystem test failures) with the smallest change. Use in AI-DLC iterations after the first one.
---

# 04 — Self-healing fix

## Role

The prompt contains the gate results of the previous iteration. Find the root cause of each failure and
fix it with a minimal diff. Gates run in order and stop at the first failure, so later gates may not have
run yet — fix what is reported, then run the local checks for the later gates too.

## Classify every failure

| Class | Typical signal | Fix in |
| --- | --- | --- |
| **B. Boundary violation** | Gate `boundary`: `[immutable/immutable-changed]`, `extensible-lines-removed`, `extensible-binary-change`, `out-of-scope`, `unclassified`, `[git/…]` (`.git/` metadata, refs or HEAD changed) | The change was already reverted. Achieve the goal inside an allowed zone (new file in a rebuildable folder, append-only line, reuse instead of edit). For `extensible-lines-removed` the message names the first line that changed;
only references to `deletable` files deleted in the same change may go (skill 01). Never touch `.git/`, commit, stash or switch branches: the harness owns version control. |
| **D. Design not reflected** | Wrong text / class / color, missing `data-ui-id`, element hidden or enabled at the wrong time | Page template / styles vs. design HTML/CSS and `enabledWhen` / `visibleWhen` |
| **A. API contract misread** | Request body / path differs from `expectedApi`, wrong field names, missing error handling | API service / request mapping vs. OpenAPI and `ui-bindings.yaml` |
| **R. Reuse contract broken** | Duplicate HTTP / beep / polling logic, `HttpClient` injected, `ApiError.kind` ignored | Use the module from `.ai-dlc/references/reusable-catalog.md` |
| **T. Test defect** | Selector not found although the element exists, race without proper `expect` waiting, `Expectation never verified`, `must be awaited`, `must run unconditionally`, `Mutation check: the test still passes` | The test code only: selectors via `ui()`, web-first assertions, one `expectUi` per `expectedUi` line, `expectApiRequests` / `expectCss` for the structured columns. **Never change, weaken or drop an expected value.** |
| **E. Environment** | Timeout starting the dev server, missing browser | Report it in `.ai-dlc/outputs/reports/fix-notes.md`; do not hack around it |

## Procedure

1. Read every failure in the prompt; group by class and by file.
2. Reproduce locally with the narrowest command (`npm run build`, `npm run lint`,
   `npm run test:coverage`, `npx playwright test --config .ai-dlc/tools/playwright.subsystem.config.ts -g "ST-NET-003"`).
3. Fix the root cause. Prefer changing one place over adding special cases.
4. Re-run the narrow command, then the full chain: build → lint → unit → subsystem.
5. Append to `.ai-dlc/outputs/reports/fix-notes.md`: iteration, failure, class, cause, fix.

## Forbidden

- Editing `.ai-dlc/inputs/**`, `.ai-dlc/config/**`, `subsystem-cases.json`, `.ai-dlc/tools/**`, `.github/skills/**`.
- Weakening assertions, skipping tests, lowering coverage thresholds, adding `// eslint-disable` to pass lint.
- Retrying the same change that failed before — read the previous fix notes first.
