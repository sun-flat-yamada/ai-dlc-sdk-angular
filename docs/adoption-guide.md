# Adoption guide

## 1. Install into your repository

```bash
git clone https://github.com/sun-flat-yamada/ai-dlc-sdk-angular.git
cd ai-dlc-sdk-angular && npm ci
npm run aidlc:install -- --target ../your-panel-app --dry-run
npm run aidlc:install -- --target ../your-panel-app          # add --with-sample to copy the sample inputs
cd ../your-panel-app && npm install && npx playwright install chromium
```

The installer never overwrites existing files without `--force` and never touches `src/`.

## 2. Describe your code base (once)

1. **`boundary-policy.yaml`** — classify your folders. Start strict: shared/core code `immutable`,
   route and provider files `extensible`, only the feature folders of the pilot `rebuildable`.
   Run `npm run aidlc:guard -- --snapshot` and edit a few files to see the classification.
2. **`.ai-dlc/references/`** — replace the sample documents with your architecture, the public API of
   reusable modules (signatures + usage), device constraints and test conventions. Keep them short and
   factual: they are injected into every prompt.
3. **`aidlc.config.yaml`** — Angular project name, gate commands (match your `package.json`), coverage
   file and thresholds, Copilot CLI permissions, QCD unit costs.
4. **`playwright.subsystem.config.ts`** — dev-server command and port.

## 3. Prepare one development item

Put requirements, design HTML/CSS (with `data-ui-id`), OpenAPI (with `operationId`), `ui-bindings.yaml`,
the Excel test specification and `human-qcd.json` into `.ai-dlc/inputs/`. Iterate on
`npm run aidlc:validate-inputs` until it reports 0 errors and review `binding-matrix.md` with the team.

## 4. Run

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
- [ ] Runner without production credentials; Copilot policy allows the documents you send.
- [ ] Record the human time spent on input preparation and review in `qcd.aiDlcHumanHours`.
- [ ] Repeat with 2-3 requirements before drawing conclusions (one run is an anecdote).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Working tree has N uncommitted change(s)` | Commit / stash, or `--allow-dirty` (pre-existing changes then count as changes of the run). |
| Gate 1 keeps reverting the same file | The policy and the requirement conflict: allow the change explicitly (zone) or change the requirement. |
| Gate 4: `No test titled with [ID]` | The test title must contain `[<case ID>]`. |
| Gate 4: `Expected values were modified` | `subsystem-cases.json` was edited. Run `npm run aidlc:parse-excel`; never edit the JSON. |
| Copilot CLI asks for permissions / does nothing | Non-interactive mode denies tools without an allow rule: add `--allow-tool` rules in `copilot.args`. |
| QCD tokens marked "estimated" | The Copilot CLI version did not write `--usage-output-file`; numbers fall back to characters ÷ 4. |
