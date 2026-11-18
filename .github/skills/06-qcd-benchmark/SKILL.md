---
name: 06-qcd-benchmark
description: Interpret the QCD (quality, cost, delivery) comparison between an AI-DLC run and the human development of the same requirement. Use after qcd-calculator.ts produced qcd-comparison-report.md, to add an evidence-based interpretation without changing any number.
---

# 06 — QCD benchmark against human development

## Role

`npm run aidlc:qcd` (`.ai-dlc/tools/qcd-calculator.ts`) has calculated the numbers from
`.ai-dlc/outputs/telemetry/run-history.json` and `.ai-dlc/inputs/human-baseline/human-qcd.json`.
Add an **Interpretation** section to `.ai-dlc/outputs/reports/qcd-comparison-report.md`.

## Axes (already calculated)

| Axis | AI-DLC | Human |
| --- | --- | --- |
| Quality | Subsystem pass rate first → final, pass rate per iteration, unit coverage, lint warnings, defects found by the first gate, defect density | Same items from `human-qcd.json` |
| Cost | Copilot CLI calls, AI credits / premium requests, tokens, AI cost + human effort for inputs and review | Effort hours × hourly rate |
| Delivery | Lead time from loop start to reverse docs, iterations k / N | Lead time, calendar days |

## Write

Append:

```markdown
## Interpretation
### Summary (3 lines)
### Quality — what the numbers mean, and what they do not
### Cost — main drivers, sensitivity to aiCreditUnitCost / human hours
### Delivery — where the time went (iterations, gates)
### Threats to validity
### Recommendations for the next run
```

## Rules

- Never change a calculated number or table. Quote numbers exactly as they appear.
- Mark estimates as estimates (tokens without usage data, dry-run results).
- Name the comparability limits: different people / skills, sample size of one, human effort recorded
  differently, inputs prepared once and reused.
- If the run was a dry-run or did not pass the gate, say that the comparison is not meaningful yet.
- Language: as stated in the prompt.
