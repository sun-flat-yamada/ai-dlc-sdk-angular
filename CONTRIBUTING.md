# Contributing

Thank you for improving **ai-dlc-sdk-angular**. Human and AI contributors follow the same rules
(see [AGENTS.md](AGENTS.md)).

## Setup

```bash
git clone https://github.com/sun-flat-yamada/ai-dlc-sdk-angular.git
cd ai-dlc-sdk-angular
npm ci
npx playwright install chromium
npm run gate
```

Requirements: Node.js 22.22+, 24.15+ or 26+ (see `.nvmrc`), npm 11, Git. GitHub Copilot CLI is only needed
for real (non dry-run) loops.

## Workflow

1. Open or pick an issue that states the goal and acceptance criteria.
2. Branch from `main`: `<type>/<issue>-<slug>` (for example `feat/12-sse-indicator-source`).
3. Commit with Conventional Commits in English: `feat(harness): ...`, `fix(skills): ...`, `docs: ...`.
4. Run the quality gate:

   ```bash
   npm run gate
   npm run aidlc:parse-excel && npm run aidlc:validate-inputs
   npm run aidlc:run -- --max-iterations 3 --dry-run
   npm run e2e   # when the sample app changed
   ```

5. Open a pull request using the template (description in Japanese is welcome). The `main` branch is
   updated by **rebase merge** only.

## Where to change what

| Change | Files | Also update |
| --- | --- | --- |
| Loop / gates / telemetry | `.ai-dlc/tools/*.ts`, `.ai-dlc/tools/lib/*.ts` | tests in `.ai-dlc/tools/tests/`, `docs/architecture.md` |
| `ui-bindings.yaml` format | `.ai-dlc/tools/lib/ui-bindings.ts`, `validate-inputs.ts` | `npm run aidlc:schemas`, `docs/input-format.md`, `.ai-dlc/inputs/README.md` |
| Excel columns | `excel-to-test-ast.ts` (`DEFAULT_HEADER_ALIASES`) | sample generator, `docs/input-format.md` |
| Skills | `.github/skills/*/SKILL.md` | prompts in `lib/prompts.ts` if names or order change |
| Sample app | `src/` | `.ai-dlc/references/*.md`, `boundary-policy.yaml` |

## Code of conduct

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).
