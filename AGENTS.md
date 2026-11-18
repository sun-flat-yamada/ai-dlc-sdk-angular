# AGENTS.md — instructions for AI coding agents

This repository has **two kinds of AI work**. Identify which one you are doing first.

| You are… | Typical trigger | Follow |
| --- | --- | --- |
| **The AI-DLC implementation agent** driven by the harness | A prompt file under `.ai-dlc/outputs/telemetry/<run>/…/*.prompt.md` | That prompt and the skills in `.github/skills/` it names. The boundary policy is enforced mechanically. |
| **A contributor to the SDK itself** (harness, skills, sample app, docs) | A normal issue / chat request | The rules below. |

## Rules for SDK contributors

1. **Quality gate** before every commit: `npm run gate`
   (typecheck → lint → unit tests → harness tests → secret scan → build). For harness changes also run
   `npm run aidlc:run -- --max-iterations 3 --dry-run`.
2. **Sample inputs stay consistent**: `npm run aidlc:parse-excel && npm run aidlc:validate-inputs` reports 0 errors.
   When the `ui-bindings.yaml` schema (`.ai-dlc/tools/lib/ui-bindings.ts`) changes, run `npm run aidlc:schemas`.
3. **Do not implement the sample feature** (`src/app/features/network-settings/`). The sample code base is
   the "before" state the AI-DLC loop starts from.
4. **Zero secrets / zero PII**: no tokens, keys, real names, e-mail addresses (use `example.invalid`) or
   absolute user paths. `npm run secret-scan` must pass.
5. **Conventional Commits** in English (`feat(harness): ...`). Branches: `<type>/<issue>-<slug>`.
   Never push directly to `main`; use a pull request.
6. **Language**: code, identifiers, comments and commit messages in English. Issues, PR descriptions and
   replies to the maintainer in Japanese. Documentation keeps the language of the file
   (`README.md` English, `README.ja.md` Japanese — keep them in sync).
7. **Dependencies**: Angular pins the TypeScript minor (`~6.0`). Update Angular, angular-eslint and
   TypeScript together. Keep `npm audit` at 0 vulnerabilities.

## Map

| Path | What |
| --- | --- |
| `.ai-dlc/tools/` | Harness (TypeScript, run with `tsx`): orchestrator, Copilot CLI adapter, boundary guard, Excel parser, input validator, gate runner, QCD calculator, installer. Tests in `tests/` (Vitest). |
| `.ai-dlc/config/` | `aidlc.config.yaml` (loop, Copilot CLI, gates, QCD), `boundary-policy.yaml`, generated JSON Schemas |
| `.ai-dlc/inputs/` | Sample inputs: requirements, HTML/CSS design, OpenAPI, `ui-bindings.yaml`, Excel, human baseline |
| `.ai-dlc/references/` | Knowledge of the existing code base injected into prompts |
| `.github/skills/` | Agent Skills 01-06 used by GitHub Copilot CLI |
| `src/` | Sample "existing" Angular 22 front-panel application |
| `docs/` | Architecture, input format, getting started, adoption guide |
