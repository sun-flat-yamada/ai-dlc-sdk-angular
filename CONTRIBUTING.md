# Contributing

Thank you for improving **ai-dlc-sdk-angular**. Human and AI contributors follow the same rules
(see [AGENTS.md](AGENTS.md)).

## Setup

All work happens in the bundled sandbox ([docs/sandbox.md](docs/sandbox.md)); `npm run gate` and every
`aidlc:*` command refuse to run on the host.

```bash
git clone https://github.com/sun-flat-yamada/ai-dlc-sdk-angular.git
cd ai-dlc-sdk-angular
npm run sandbox -- up        # builds the image, applies the egress firewall, runs npm ci inside
npm run sandbox -- shell     # or: VS Code "Reopen in Container"
npm run gate                 # inside the sandbox
```

Host requirements: Docker, Node.js 22.22+, 24.15+ or 26+ (only to start the launcher) and Git. Everything
else — Node.js for the build, Angular CLI, Playwright Chromium, GitHub Copilot CLI — is in the sandbox image.

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
6. Merge it. With PR Auto-Pilot on (`PR_AUTO_PILOT`, the repository default; `npm run pr:mode`), open the
   pull request ready for review and run `npm run pr:finish -- <number>` on the host: it waits for CI,
   approves and rebase-merges the checked head without bypassing branch protection. With it off, open a
   draft and a maintainer merges. See [docs/pr-auto-merge.md](docs/pr-auto-merge.md).

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
