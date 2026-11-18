import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ReverseDocFacts } from './reverse-doc-facts.js';

const esc = (s: string) => s.replace(/\|/g, '\\|');
const code = (s: string) => `\`${esc(s)}\``;
const table = (header: string[], rows: string[][], empty = '_(none)_') =>
  rows.length
    ? [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n')
    : empty;
const mermaidId = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_');

/** Normalizes `/api/v1/network/ipv4` and `network/ipv4` to `network/ipv4` for matching. */
export function apiKey(p: string): string {
  return p.replace(/^\/+/, '').replace(/^api\/v\d+\//, '').replace(/\$\{[^}]+\}/g, '{param}').toLowerCase();
}

export function renderPlaceholders(facts: ReverseDocFacts, gateStatus: string): Record<string, string> {
  const zoneOrder = ['immutable', 'extensible', 'rebuildable', 'deletable', 'ignored', 'unclassified'];
  const nodes = [...facts.components.map((c) => ({ ...c, kind: 'component' })), ...facts.services.map((s) => ({ ...s, kind: 'service', selector: '', usesServices: [] as string[] }))];
  const diagram = ['```mermaid', 'flowchart LR'];
  for (const zone of zoneOrder) {
    const inZone = nodes.filter((n) => n.zone === zone);
    if (!inZone.length) continue;
    diagram.push(`  subgraph ${zone}["${zone}"]`);
    for (const n of inZone) diagram.push(`    ${mermaidId(n.className)}["${n.className}"]`);
    diagram.push('  end');
  }
  const known = new Set(nodes.map((n) => n.className));
  for (const c of facts.components) {
    for (const s of c.usesServices) if (known.has(s)) diagram.push(`  ${mermaidId(c.className)} --> ${mermaidId(s)}`);
  }
  for (const removed of facts.changes.filter((c) => c.status === 'deleted')) {
    diagram.push(`  %% deleted: ${removed.path}`);
  }
  diagram.push('```');

  const sequences: string[] = [];
  for (const s of facts.services.filter((x) => x.apiCalls.length)) {
    const users = facts.components.filter((c) => c.usesServices.includes(s.className)).map((c) => c.className);
    const comp = users[0] ?? 'Component';
    sequences.push(
      [
        `#### ${s.className}`,
        '',
        '```mermaid',
        'sequenceDiagram',
        '  actor Operator',
        `  participant UI as ${comp}`,
        `  participant SVC as ${s.className}`,
        '  participant API as Device REST API',
        ...s.apiCalls.flatMap((a) => [
          `  Operator->>UI: touch`,
          `  UI->>SVC: call`,
          `  SVC->>API: ${a.method} ${a.path}`,
          '  alt 2xx',
          '    API-->>SVC: response',
          '    SVC-->>UI: update state',
          '  else error (ApiError)',
          '    API-->>SVC: 4xx / 5xx / timeout',
          '    SVC-->>UI: show error',
          '  end',
        ]),
        '```',
      ].join('\n'),
    );
  }

  const specOf = (file: string) => file.replace(/\.ts$/, '.spec.ts');
  const traceRows = facts.subsystemCases.map((c) => {
    const impl = facts.services.filter((s) => s.apiCalls.some((a) => c.expectedApi.some((e) => apiKey(e.split(' ')[1] ?? '') === apiKey(a.path))));
    return [
      c.requirements.map(code).join('<br>') || '—',
      code(c.id),
      esc(c.title),
      c.uiRefs.map((u) => code(`@${u}`)).join(' ') || '—',
      c.expectedApi.map(code).join('<br>') || '—',
      impl.map((s) => code(s.className)).join('<br>') || '_(to be mapped)_',
      impl.filter((s) => s.hasSpec).map((s) => code(specOf(s.file))).join('<br>') || '—',
    ];
  });

  return {
    generatedAt: facts.generatedAt,
    baseline: facts.baseline ?? '(working tree)',
    gateStatus,
    zoneTable: table(
      ['Zone', 'Paths'],
      Object.entries(facts.zones).filter(([, p]) => p.length).map(([z, p]) => [code(z), p.map(code).join('<br>')]),
    ),
    changeTable: table(
      ['Path', 'Zone', 'Status', '+', '-'],
      facts.changes.map((c) => [code(c.path), c.zone, c.status, String(c.added ?? '—'), String(c.deleted ?? '—')]),
      '_(no changes since the baseline)_',
    ),
    componentDiagram: diagram.join('\n'),
    componentTable: table(
      ['Component', 'Selector', 'Zone', 'Uses', 'data-testid', 'Unit test'],
      facts.components.map((c) => [
        code(c.className),
        code(c.selector),
        c.zone,
        c.usesServices.map(code).join(', ') || '—',
        c.testIds.map(code).join(', ') || '—',
        c.hasSpec ? '✅' : '❌',
      ]),
    ),
    routeTable: table(['Route', 'Target'], facts.routes.map((r) => [code(r.path), code(r.target)])),
    uiDesignFiles: facts.uiDesignFiles.map((f) => `- ${code(f)}`).join('\n') || '_(none)_',
    apiSpecFiles: facts.apiSpecFiles.map((f) => `- ${code(f)}`).join('\n') || '_(none)_',
    requirementFiles: facts.requirementFiles.map((f) => `- ${code(f)}`).join('\n') || '_(none)_',
    serviceApiTable: table(
      ['Service', 'Zone', 'API calls', 'Unit test'],
      facts.services.map((s) => [code(s.className), s.zone, s.apiCalls.map((a) => code(`${a.method} ${a.path}`)).join('<br>') || '—', s.hasSpec ? '✅' : '❌']),
    ),
    apiSequences: sequences.join('\n\n') || '_(no REST API calls found)_',
    traceabilityTable: table(['Requirement', 'Case ID', 'Title', 'UI elements', 'Expected API', 'Implementation', 'Unit test'], traceRows),
  };
}

/** Fills `{{name}}` placeholders. Unknown placeholders are left for the AI to complete. */
export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (all, key: string) => values[key] ?? all);
}

/** Renders every `templates/*.md` into `outDir`. Returns the written files. */
export function renderReverseDocs(
  templatesDir: string,
  outDir: string,
  facts: ReverseDocFacts,
  gateStatus: string,
  extra: Record<string, string> = {},
): string[] {
  if (!existsSync(templatesDir)) throw new Error(`Templates not found: ${templatesDir}`);
  mkdirSync(outDir, { recursive: true });
  const values = { ...renderPlaceholders(facts, gateStatus), ...extra };
  const written: string[] = [];
  for (const name of readdirSync(templatesDir).filter((f) => f.endsWith('.md')).sort()) {
    const out = path.join(outDir, name);
    writeFileSync(out, fillTemplate(readFileSync(path.join(templatesDir, name), 'utf8'), values), 'utf8');
    written.push(out);
  }
  return written;
}
