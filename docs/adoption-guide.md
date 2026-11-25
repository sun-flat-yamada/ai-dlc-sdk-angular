# Adoption guide

## 1. Install into your repository

The installer is the one harness command that runs on the host: it only copies files, executes no
project code, and is how the sandbox gets into your repository. Install the SDK's own dependencies
without running their install scripts:

```bash
git clone https://github.com/sun-flat-yamada/ai-dlc-sdk-angular.git
cd ai-dlc-sdk-angular && npm ci --ignore-scripts
npm run aidlc:install -- --target ../your-panel-app --dry-run
npm run aidlc:install -- --target ../your-panel-app          # add --with-sample to copy the sample inputs
cd ../your-panel-app && npm run sandbox -- up                # builds the sandbox, runs npm ci inside it
```

The installer copies the sandbox (`.devcontainer/`, `scripts/sandbox.ts`) together with the harness,
never overwrites existing files without `--force` and never touches `src/`. From here on every command
runs in the target's sandbox: `npm run sandbox -- shell`, or **Reopen in Container** in VS Code.
If your project needs extra hosts (private npm registry, internal APIs) add them to
`.devcontainer/allowed-domains.txt` — see [sandbox.md](sandbox.md).

## 2. Describe your code base (once)

1. **`boundary-policy.yaml`** — classify your folders. Start strict: shared/core code `immutable`,
   route and provider files `extensible`, only the feature folders of the pilot `rebuildable`.
   Run `npm run aidlc:guard -- --snapshot` and edit a few files to see the classification.
2. **`.ai-dlc/references/`** — replace the sample documents with your architecture, the public API of
   reusable modules (signatures + usage), device constraints and test conventions. Keep them short and
   factual: they are injected into every prompt.
3. **`aidlc.config.yaml`** — Angular project name, gate commands (match your `package.json`), coverage
   file and thresholds, Copilot CLI permissions, QCD unit costs.
4. **`playwright.subsystem.config.ts`** — dev-server command (Gate 4 picks the port itself).
5. **Replacing `deletable` code** — `extensible` files are append-only, except for the parts that only
   reference `deletable` files deleted in the same change (`removeReferencesToDeleted: true` in
   `boundary-policy.yaml`, the default). When the agent deletes an old screen it may remove or rewrite
   its `import`, the array entry or top-level statement that loads or uses it (a lazy route), and the
   array entries that link to a route removed that way (a menu item with `route: '/old-path'`). Every
   other existing line must stay. The guard finds these parts with the TypeScript AST, so they must
   start and end on their own lines (one route object per line range, as Prettier formats them), and
   only relative import paths are followed (not path aliases such as `@app/...`). References it cannot
   attribute — a `routerLink` in a template, an alias import, an entry sharing a line with other code
   — are still violations: remove those yourself before the run and commit. Set the option to `false`
   to keep `extensible` files strictly append-only.

## 3. Prepare one development item

Put requirements, design HTML/CSS (with `data-ui-id`), OpenAPI (with `operationId`), `ui-bindings.yaml`,
the Excel test specification and `human-qcd.json` into `.ai-dlc/inputs/`. Iterate on
`npm run aidlc:validate-inputs` until it reports 0 errors and review `binding-matrix.md` with the team.

## 4. Run (inside the sandbox)

```bash
npm run aidlc:run -- --max-iterations 3 --dry-run   # rehearsal: prompts, Gate 0/1, reports
git status                                          # must be clean for a real run
npm run aidlc:run -- --max-iterations 5
```

Review in this order: `final-quality-gate.md` → `unresolved-issues.md` (if any) → `git diff` →
`reverse-docs/` → `qcd-comparison-report.md`. The harness does not commit; you decide what to keep.

## 5. Pilot checklist

- [ ] Same requirement already developed by humans, with effort, lead time and defect records (`human-qcd.json`).
- [ ] Inputs frozen before the run (they are the controlled variable).
- [ ] Runs only in the sandbox (`npm run aidlc:sandbox-check` is OK); Copilot policy allows the documents you send.
- [ ] Record the human time spent on input preparation and review in `qcd.aiDlcHumanHours`.
- [ ] Repeat with 2-3 requirements before drawing conclusions (one run is an anecdote).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `… must run inside the AI-DLC sandbox` | Run the command in the sandbox: `npm run sandbox -- exec <command>` or a sandbox shell. See [sandbox.md](sandbox.md). |
| `egress firewall is stale / missing` | Restart the container (`npm run sandbox -- down && npm run sandbox -- up`) and read `/run/aidlc-sandbox/firewall.log`. |
| `git credential helper bridged to the host` | VS Code forwarded your git credentials. Set `dev.containers.gitCredentialHelperConfigLocation` to `none` and rebuild, or use `npm run sandbox`. |
| `npm ci` / Copilot cannot reach a host in the sandbox | Add the host to `.devcontainer/allowed-domains.txt` (or `AIDLC_FIREWALL_EXTRA_DOMAINS`) and restart. |
| `Working tree has N uncommitted change(s)` | Commit / stash, or `--allow-dirty` (pre-existing changes then count as changes of the run). |
| Gate 1 keeps reverting the same file | The policy and the requirement conflict: allow the change explicitly (zone) or change the requirement. |
| Gate 4: `No test titled with [ID]` | The test title must contain `[<case ID>]`. |
| Gate 4: `Expectation never verified by a passing test` | Each `expectedApi` / `expectedCss` entry needs `expectApiRequests` / `expectCss`, each `expectedUi` line its own `expectUi(c, index, …)` (skill 03). |
| Gate 4: `Mutation check: the test still passes` | The assertion for that `expectedUi` line is too weak (for example `toBeVisible()` for a text). Assert the exact text, value, state or URL. Mutants that cannot affect a property (`gates.subsystem.mutation.mutants`) can be removed for your app. |
| Gate 2: `angular.json budgets` | The production bundle exceeds a budget: lazy-load the screen or drop the heavy dependency. |
| Gate 4: `Expected values were modified` | `subsystem-cases.json` was edited. Run `npm run aidlc:parse-excel`; never edit the JSON. |
| Copilot CLI asks for permissions / does nothing | Non-interactive mode denies tools without an allow rule: add `--allow-tool` rules in `copilot.args`. |
| QCD tokens marked "estimated" | The Copilot CLI version did not write `--usage-output-file`; numbers fall back to characters ÷ 4. |
