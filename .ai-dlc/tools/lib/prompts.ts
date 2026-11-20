import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { BoundaryPolicy, describePolicy } from './boundary.js';
import { AidlcConfig, AidlcPaths } from './config.js';
import { rel } from './cli.js';
import { GateResult } from './telemetry.js';

export const SKILLS = {
  context: '01-context-and-boundary',
  implement: '02-angular-panel-impl',
  gate: '03-excel-subsystem-gate',
  fix: '04-self-healing-fix',
  reverseDoc: '05-reverse-spec-doc',
  qcd: '06-qcd-benchmark',
} as const;

/** Lists files (recursively, max `limit`) as repository-relative paths, ignoring README/.gitkeep. */
export function listFiles(root: string, dir: string, limit = 200): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (out.length >= limit) return;
      const abs = path.join(d, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (name !== '.gitkeep' && name.toLowerCase() !== 'readme.md') out.push(rel(root, abs));
    }
  };
  walk(dir);
  return out;
}

function bullet(files: string[], empty = '_(none)_'): string {
  return files.length ? files.map((f) => `- \`${f}\``).join('\n') : empty;
}

function skillRef(paths: AidlcPaths, skill: string): string {
  return `\`${skill}\` (\`${rel(paths.root, path.join(paths.skills, skill, 'SKILL.md'))}\`)`;
}

const GUARDRAILS = `## Non-negotiable rules

1. Obey \`.ai-dlc/config/boundary-policy.yaml\`. Changes in \`immutable\` / \`ignored\` zones, removed lines in \`extensible\` files and unclassified paths are reverted automatically and reported as violations. Installed packages (\`node_modules/\`) are fingerprinted: any change there, including \`npm install\`, fails the boundary gate and they are reinstalled from \`package-lock.json\`.
2. Never edit anything under \`.ai-dlc/inputs/\`, \`.ai-dlc/config/\`, \`.ai-dlc/tools/\`, \`.github/skills/\` or \`subsystem-cases.json\`. Expected values come from humans; a test is fixed by fixing the implementation or a wrong selector, never by weakening an expectation.
3. Never use \`test.skip\`, \`test.fixme\`, \`it.skip\`, \`xit\` or \`.only\`. Skipped tests fail the gate.
4. Do not run \`git commit\`, \`git push\`, \`git reset\`, \`git checkout\` or \`git clean\`. The harness owns version control.
5. Reuse the shared modules listed in \`.ai-dlc/references/reusable-catalog.md\` instead of re-implementing them.
6. Finish by running the local checks named in the skills (build, lint, unit tests). Leave the workspace in a buildable state.`;

export interface PromptContext {
  paths: AidlcPaths;
  config: AidlcConfig;
  policy: BoundaryPolicy;
  iteration: number;
  maxIterations: number;
  caseCount: number;
}

function inputsSection(paths: AidlcPaths): string {
  const root = paths.root;
  return `## Inputs (read-only)

### Requirements
${bullet(listFiles(root, paths.inputs.requirements))}

### UI design specification (HTML / CSS)
${bullet(listFiles(root, paths.inputs.uiDesign))}

### REST API specification
${bullet(listFiles(root, paths.inputs.apiSpecs))}

### UI ⇄ REST API bindings (the contract between the two above)
${bullet(listFiles(root, paths.inputs.uiBindings))}
- Generated matrix (element × event × API × state): \`${rel(root, path.join(paths.outputs.reports, 'binding-matrix.md'))}\`
- Every bound element carries \`data-ui-id="<ui-id>"\` in the Angular template, exactly as in the design HTML.

### Subsystem test specification (acceptance criteria — use while designing and implementing)
- Source workbooks: ${bullet(listFiles(root, paths.inputs.subsystemTests)).replace(/\n/g, ' ')}
- Structured cases (generated, read-only): \`${rel(root, paths.subsystemCases)}\`
- Readable list with every step and expectation: \`${rel(root, path.join(paths.outputs.generatedTests, 'subsystem-cases.md'))}\`

### References (existing code base knowledge)
${bullet(listFiles(root, paths.references))}`;
}

export function buildImplementPrompt(ctx: PromptContext): string {
  const { paths, config } = ctx;
  return `# AI-DLC task — iteration ${ctx.iteration} of ${ctx.maxIterations}: implement

You are the implementation agent of an AI-driven development life cycle for the Angular application \`${config.project.angularProject}\`, an embedded device front-panel GUI.
Work autonomously. Nobody will answer questions during this run.

## Skills to apply, in order (test-first)

The Excel subsystem cases (${ctx.caseCount} case(s)) are the human-written acceptance criteria. They drive every step, not only the final gate.

1. ${skillRef(paths, SKILLS.context)} — map requirements, Excel cases and what to reuse, rebuild and delete. Write the change impact map to \`.ai-dlc/outputs/reports/change-impact-map.md\`.
2. ${skillRef(paths, SKILLS.gate)} — **before implementing**, write one Playwright test per subsystem case under \`.ai-dlc/outputs/generated-tests/subsystem/\`. They are expected to fail until step 3 is done.
3. ${skillRef(paths, SKILLS.implement)} — implement the screens, services and unit tests so that the inputs are met and the tests of step 2 pass. Run the subsystem tests at the end.

Read each SKILL.md completely before starting that step.

${inputsSection(paths)}

## Boundary policy

${describePolicy(ctx.policy)}

${GUARDRAILS}

## Definition of done for this iteration

- \`npm run build\`, \`npm run lint\` and \`npm run test:coverage\` succeed.
- Every case in \`subsystem-cases.json\` has a passing Playwright test titled \`[<case ID>] ...\`.
- The harness re-runs every gate after you finish; you do not need to report anything else.
`;
}

function formatGate(result: GateResult): string {
  const failures = result.failures
    .slice(0, 30)
    .map((f) => `- \`${f.where}\` — ${f.message.replace(/\n/g, ' ')}`)
    .join('\n');
  const log = result.logTail
    ? `\n<details><summary>log tail</summary>\n\n\`\`\`text\n${result.logTail}\n\`\`\`\n</details>\n`
    : '';
  return `### Gate \`${result.gate}\`: ${result.status.toUpperCase()} — ${result.summary}\n\n${failures || '_(no structured failures)_'}\n${log}`;
}

export function buildFixPrompt(ctx: PromptContext, previous: readonly GateResult[]): string {
  const { paths } = ctx;
  const failed = previous.filter((g) => g.status === 'fail');
  const skippedGates = previous.filter((g) => g.status === 'skipped').map((g) => g.gate);
  return `# AI-DLC task — iteration ${ctx.iteration} of ${ctx.maxIterations}: fix

The previous iteration did not pass the quality gates. Apply ${skillRef(paths, SKILLS.fix)}.
Read it completely, classify every failure below, then make the smallest change that fixes the root cause.
${skillRef(paths, SKILLS.implement)} and ${skillRef(paths, SKILLS.gate)} remain the reference for how code and tests are written.

## Failures from iteration ${ctx.iteration - 1}

${failed.map(formatGate).join('\n') || '_(no failing gate — previous gates were skipped)_'}
${skippedGates.length ? `\nGates not reached yet (they will run after the failing gate passes): ${skippedGates.map((g) => `\`${g}\``).join(', ')}.\n` : ''}
${inputsSection(paths)}

## Boundary policy

${describePolicy(ctx.policy)}

${GUARDRAILS}
`;
}

export function buildReverseDocPrompt(
  paths: AidlcPaths,
  config: AidlcConfig,
  factsFile: string,
): string {
  return `# AI-DLC task — reverse-generate design documents

Apply ${skillRef(paths, SKILLS.reverseDoc)}. Read it completely first.

- Facts collected by the harness: \`${rel(paths.root, factsFile)}\` (zones, changed files, components, routes, API calls, subsystem cases).
- Templates: \`${rel(paths.root, path.join(paths.skills, SKILLS.reverseDoc, 'templates'))}/\`
- Output directory: \`${rel(paths.root, paths.outputs.reverseDocs)}/\`
- Document language: **${config.output.language === 'ja' ? 'Japanese' : 'English'}** (identifiers, paths and code stay as they are).

Write only inside the output directory. Do not modify source code. Any change elsewhere is restored automatically and reported as a boundary violation.
`;
}

export function buildQcdPrompt(paths: AidlcPaths, config: AidlcConfig, reportFile: string): string {
  return `# AI-DLC task — QCD benchmark commentary

Apply ${skillRef(paths, SKILLS.qcd)}. Read it completely first.

The numbers are already calculated in \`${rel(paths.root, reportFile)}\` and \`${rel(paths.root, reportFile.replace(/\.md$/, '.json'))}\`.
Append the "Interpretation" section the skill describes to the end of the Markdown report. Never change a calculated number: the existing content and the JSON are checked, and any other change is restored and reported as a boundary violation.
Language: **${config.output.language === 'ja' ? 'Japanese' : 'English'}**.
`;
}
