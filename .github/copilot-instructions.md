# Repository instructions for GitHub Copilot

Read `AGENTS.md` at the repository root first.

- When you were started by the AI-DLC harness (`npm run aidlc:run`), the prompt file you were given is the
  task. Apply the skills it names from `.github/skills/`, obey `.ai-dlc/config/boundary-policy.yaml`, and
  never edit `.ai-dlc/inputs/`, `.ai-dlc/config/`, `.ai-dlc/tools/`, `.github/skills/` or
  `.ai-dlc/outputs/generated-tests/subsystem-cases.json`.
- Angular 22, standalone components, zoneless, signals, `OnPush`. Unit tests: Vitest through `ng test`.
- Every element that appears in `.ai-dlc/inputs/ui-bindings/ui-bindings.yaml` carries
  `data-ui-id="<ui-id>"`; tests select elements by that attribute.
- REST calls go through `ApiClient` (`src/app/core/http/api-client.ts`); errors arrive as `ApiError`.
- Code, identifiers and comments in English; UI text in Japanese as given by the design.
