/**
 * Gate 0 — input validation. Checks that the human inputs are consistent BEFORE any AI work:
 *
 *   ui-bindings.yaml  <->  HTML design (data-ui-id)  <->  OpenAPI (operationId, schemas)
 *                     <->  requirements (REQ IDs)    <->  Excel cases (@ui-id, API, REQ IDs)
 *
 *   npm run aidlc:validate-inputs
 *
 * Writes .ai-dlc/outputs/reports/binding-matrix.md (element x event x API x state).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { AidlcPaths, findRepoRoot, loadConfig, resolvePaths } from './lib/config.js';
import { isMain, log, rel, runCli } from './lib/cli.js';
import { enforceSandbox } from './lib/sandbox.js';
import { SubsystemCaseFile } from './lib/subsystem-cases.js';
import { GateResult } from './lib/telemetry.js';
import {
  ActionBinding,
  UiBindings,
  referencedOperations,
  uiBindingsSchema,
} from './lib/ui-bindings.js';

export interface Finding {
  level: 'error' | 'warning';
  where: string;
  message: string;
}

export interface OperationInfo {
  operationId: string;
  method: string;
  path: string;
  requestSchema?: JsonSchema;
  responseSchema?: JsonSchema;
  responseCodes: string[];
  /** Path prefix from the first OpenAPI `servers` entry (`/api/v1`); requests on the wire carry it. */
  basePath: string;
  /** `x-ui-binding: shared` — used by shared modules (e.g. the status bar), not bound per screen. */
  shared: boolean;
  file: string;
}

interface JsonSchema {
  $ref?: string;
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  allOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
}

/** Extracts `data-ui-id` values from HTML (duplicates included, in document order). */
export function extractUiIds(html: string): string[] {
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, '');
  return [...withoutComments.matchAll(/data-ui-id\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]!);
}

function resolveRef(
  doc: unknown,
  schema: JsonSchema | undefined,
  depth = 0,
): JsonSchema | undefined {
  if (!schema || depth > 20) return schema;
  if (schema.$ref?.startsWith('#/')) {
    const target = schema.$ref
      .slice(2)
      .split('/')
      .reduce<unknown>(
        (node, key) =>
          (node as Record<string, unknown> | undefined)?.[
            key.replace(/~1/g, '/').replace(/~0/g, '~')
          ],
        doc,
      );
    return resolveRef(doc, target as JsonSchema, depth + 1);
  }
  return schema;
}

/** Property names of an object schema, following $ref and allOf / oneOf / anyOf. */
function propertiesOf(doc: unknown, schema: JsonSchema | undefined): Map<string, JsonSchema> {
  const out = new Map<string, JsonSchema>();
  const s = resolveRef(doc, schema);
  if (!s) return out;
  for (const [k, v] of Object.entries(s.properties ?? {})) out.set(k, v);
  for (const part of [...(s.allOf ?? []), ...(s.oneOf ?? []), ...(s.anyOf ?? [])]) {
    for (const [k, v] of propertiesOf(doc, part)) out.set(k, v);
  }
  return out;
}

function requiredOf(doc: unknown, schema: JsonSchema | undefined): string[] {
  const s = resolveRef(doc, schema);
  return [...(s?.required ?? []), ...(s?.allOf ?? []).flatMap((p) => requiredOf(doc, p))];
}

/** Checks that `$.a.b` exists in the schema. Returns undefined when it cannot be decided. */
export function schemaHasPath(
  doc: unknown,
  schema: JsonSchema | undefined,
  jsonPath: string,
): boolean | undefined {
  const parts = jsonPath
    .replace(/^\$\.?/, '')
    .split('.')
    .filter(Boolean);
  let current = resolveRef(doc, schema);
  for (const part of parts) {
    if (!current) return undefined;
    const props = propertiesOf(doc, current);
    if (props.size === 0) return undefined;
    const next = props.get(part);
    if (!next) return false;
    current = resolveRef(doc, next);
  }
  return true;
}

/** Path part of an OpenAPI server URL (`/api/v1`, `https://host/api/v1`); '' when absent. */
export function serverBasePath(url: string | undefined): string {
  if (!url) return '';
  let p = url;
  try {
    p = new URL(url).pathname;
  } catch {
    // relative server URL such as /api/v1
  }
  return p.replace(/\/+$/, '');
}

/** Matches `/items/{id}` style OpenAPI path templates against a concrete path (query string ignored). */
export function openApiPathMatches(template: string, actual: string): boolean {
  const pattern = template
    .split(/(\{[^}]+\})/)
    .map((part) => (part.startsWith('{') ? '[^/]+' : part.replace(/[.*+?^$()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${pattern}/?$`).test(actual.split('?')[0]!);
}

/** The operation a concrete request (`PUT /api/v1/network/ipv4`) is sent to, if any. */
export function findOperationForRequest(
  operations: Iterable<OperationInfo>,
  method: string,
  requestPath: string,
): OperationInfo | undefined {
  for (const op of operations) {
    if (
      op.method === method.toUpperCase() &&
      openApiPathMatches(op.basePath + op.path, requestPath)
    )
      return op;
  }
  return undefined;
}

export function loadOperations(file: string): { doc: unknown; operations: OperationInfo[] } {
  const doc = parse(readFileSync(file, 'utf8')) as {
    paths?: Record<string, Record<string, unknown>>;
    servers?: { url?: string }[];
  };
  const basePath = serverBasePath(doc.servers?.[0]?.url);
  const operations: OperationInfo[] = [];
  for (const [p, item] of Object.entries(doc.paths ?? {})) {
    for (const method of ['get', 'put', 'post', 'patch', 'delete']) {
      const op = item[method] as
        | {
            operationId?: string;
            'x-ui-binding'?: string;
            requestBody?: { content?: Record<string, { schema?: JsonSchema }> };
            responses?: Record<string, { content?: Record<string, { schema?: JsonSchema }> }>;
          }
        | undefined;
      if (!op?.operationId) continue;
      const okCode = Object.keys(op.responses ?? {}).find((c) => /^2\d\d$/.test(c));
      operations.push({
        operationId: op.operationId,
        method: method.toUpperCase(),
        path: p,
        requestSchema: op.requestBody?.content?.['application/json']?.schema,
        responseSchema: okCode
          ? op.responses?.[okCode]?.content?.['application/json']?.schema
          : undefined,
        responseCodes: Object.keys(op.responses ?? {}),
        basePath,
        shared: op['x-ui-binding'] === 'shared',
        file,
      });
    }
  }
  return { doc, operations };
}

const ERROR_CODES: Record<string, string[]> = {
  validation: ['400', '422'],
  busy: ['409', '503'],
  'not-found': ['404'],
};

export interface ValidationResult {
  findings: Finding[];
  bindings?: UiBindings;
  operations: Map<string, OperationInfo>;
}

export function validateInputs(paths: AidlcPaths): ValidationResult {
  const findings: Finding[] = [];
  const err = (where: string, message: string) => findings.push({ level: 'error', where, message });
  const warn = (where: string, message: string) =>
    findings.push({ level: 'warning', where, message });
  const operations = new Map<string, OperationInfo>();
  const bindingsFile = path.join(paths.inputs.uiBindings, 'ui-bindings.yaml');
  const relB = rel(paths.root, bindingsFile);
  if (!existsSync(bindingsFile)) {
    err(relB, 'ui-bindings.yaml not found');
    return { findings, operations };
  }
  const parsed = uiBindingsSchema.safeParse(parse(readFileSync(bindingsFile, 'utf8')));
  if (!parsed.success) {
    for (const i of parsed.error.issues) err(`${relB}#${i.path.join('.')}`, i.message);
    return { findings, operations };
  }
  const bindings = parsed.data;

  // OpenAPI
  const docs = new Map<string, unknown>();
  for (const spec of bindings.apiSpecs) {
    const file = path.join(paths.inputs.apiSpecs, spec);
    if (!existsSync(file)) {
      err(relB, `apiSpecs: ${spec} not found in inputs/api-specs/`);
      continue;
    }
    const { doc, operations: ops } = loadOperations(file);
    for (const op of ops) {
      if (operations.has(op.operationId))
        err(rel(paths.root, file), `duplicate operationId "${op.operationId}"`);
      operations.set(op.operationId, op);
      docs.set(op.operationId, doc);
    }
  }

  // Requirement IDs mentioned in requirement documents.
  const reqText = existsSync(paths.inputs.requirements)
    ? readdirSync(paths.inputs.requirements)
        .filter((f) => /\.(md|ya?ml|txt)$/i.test(f))
        .map((f) => readFileSync(path.join(paths.inputs.requirements, f), 'utf8'))
        .join('\n')
    : '';

  const allUiIds = new Set<string>();
  const usedOps = new Set<string>();
  for (const [screenId, screen] of Object.entries(bindings.screens)) {
    const where = (suffix = '') => `${relB}#screens.${screenId}${suffix}`;
    const states = new Set(screen.states);
    if (!states.has(screen.initial)) err(where('.initial'), `"${screen.initial}" is not in states`);
    for (const req of screen.requirements) {
      if (!reqText.includes(req))
        warn(where('.requirements'), `${req} not found in inputs/requirements/`);
    }
    // Design HTML
    const designFile = path.join(paths.inputs.uiDesign, screen.design);
    let htmlIds: string[] = [];
    if (!existsSync(designFile)) {
      err(where('.design'), `${screen.design} not found in inputs/ui-design/`);
    } else {
      htmlIds = extractUiIds(readFileSync(designFile, 'utf8'));
      const dup = htmlIds.filter((x, i) => htmlIds.indexOf(x) !== i);
      for (const d of new Set(dup)) err(rel(paths.root, designFile), `duplicate data-ui-id="${d}"`);
      const declared = new Set([...Object.keys(screen.elements), ...screen.static]);
      for (const h of new Set(htmlIds)) {
        if (!declared.has(h))
          err(
            rel(paths.root, designFile),
            `data-ui-id="${h}" is neither bound in elements nor listed in static`,
          );
      }
      for (const e of declared) {
        if (!htmlIds.includes(e))
          err(where(`.elements.${e}`), `no data-ui-id="${e}" in ${screen.design}`);
      }
    }
    for (const e of [...Object.keys(screen.elements), ...screen.static]) {
      if (allUiIds.has(e))
        err(
          where(`.elements.${e}`),
          `ui-id "${e}" is used by more than one screen; ui-ids must be globally unique`,
        );
      allUiIds.add(e);
    }

    const checkAction = (a: ActionBinding | undefined, at: string) => {
      if (!a) return;
      for (const t of [
        a.transition,
        a.success?.transition,
        ...Object.values(a.errors ?? {}).map((o) => o.transition),
      ]) {
        if (t && !states.has(t)) err(where(at), `transition "${t}" is not in states`);
      }
      if (!a.call) return;
      const op = operations.get(a.call);
      usedOps.add(a.call);
      if (!op) {
        err(where(at), `operationId "${a.call}" not found in ${bindings.apiSpecs.join(', ')}`);
        return;
      }
      const doc = docs.get(a.call);
      if (a.request) {
        const props = propertiesOf(doc, op.requestSchema);
        if (!op.requestSchema) err(where(`${at}.request`), `${a.call} has no JSON request body`);
        for (const k of Object.keys(a.request)) {
          if (op.requestSchema && props.size && !props.has(k))
            err(
              where(`${at}.request.${k}`),
              `"${k}" is not a property of the ${a.call} request body`,
            );
        }
        for (const r of requiredOf(doc, op.requestSchema)) {
          if (!(r in a.request))
            warn(
              where(`${at}.request`),
              `required request property "${r}" of ${a.call} is not mapped`,
            );
        }
      } else if (op.requestSchema && op.method !== 'GET') {
        warn(where(at), `${a.call} expects a request body but no request mapping is given`);
      }
      for (const kind of Object.keys(a.errors ?? {})) {
        const codes = ERROR_CODES[kind];
        if (codes && !codes.some((c) => op.responseCodes.includes(c))) {
          warn(
            where(`${at}.errors.${kind}`),
            `${a.call} declares no ${codes.join('/')} response in OpenAPI`,
          );
        }
      }
      for (const [kind, codes] of Object.entries(ERROR_CODES)) {
        if (
          codes.some((c) => op.responseCodes.includes(c)) &&
          !a.errors?.[kind as keyof typeof a.errors] &&
          !a.errors?.default
        ) {
          warn(
            where(at),
            `${a.call} can answer ${codes.filter((c) => op.responseCodes.includes(c)).join('/')} but no "${kind}" (or "default") error outcome is bound`,
          );
        }
      }
    };
    checkAction(screen.onEnter, '.onEnter');
    for (const [elId, el] of Object.entries(screen.elements)) {
      if (el.kind === 'indicator' && !el.source && !el.map)
        warn(where(`.elements.${elId}`), 'indicator without source / map');
      if (['button'].includes(el.kind) && !el.on)
        warn(where(`.elements.${elId}`), 'button without an "on" event');
      if (['input', 'toggle', 'select'].includes(el.kind) && !el.bind)
        warn(where(`.elements.${elId}`), `${el.kind} without "bind"`);
      if (el.source) {
        const op = operations.get(el.source.call);
        usedOps.add(el.source.call);
        if (!op)
          err(where(`.elements.${elId}.source`), `operationId "${el.source.call}" not found`);
        else {
          const has = schemaHasPath(docs.get(el.source.call), op.responseSchema, el.source.path);
          if (has === false)
            err(
              where(`.elements.${elId}.source.path`),
              `${el.source.path} is not in the ${el.source.call} response schema`,
            );
        }
      }
      for (const [event, action] of Object.entries(el.on ?? {}))
        checkAction(action, `.elements.${elId}.on.${event}`);
    }
  }
  for (const op of operations.values()) {
    if (!usedOps.has(op.operationId) && !op.shared)
      warn(
        rel(paths.root, op.file),
        `operationId "${op.operationId}" (${op.method} ${op.path}) is not bound to any screen`,
      );
  }

  // Excel cases: @ui-id references, API notation against OpenAPI, requirement traceability.
  if (existsSync(paths.subsystemCases)) {
    const cases = JSON.parse(readFileSync(paths.subsystemCases, 'utf8')) as SubsystemCaseFile;
    const knownReqs = new Set(
      [...reqText.matchAll(/\bREQ-[A-Z0-9][A-Z0-9-]*[A-Z0-9]\b/g)].map((m) => m[0]),
    );
    const covered = new Set<string>();
    for (const c of cases.cases) {
      const at = `${c.sheet}!R${c.row} ${c.id}`;
      for (const ref of c.uiRefs ?? []) {
        if (!allUiIds.has(ref)) err(at, `@${ref} is not a ui-id in ui-bindings.yaml`);
      }
      for (const m of c.mockApi ?? []) {
        const op = findOperationForRequest(operations.values(), m.method, m.path);
        if (!op) {
          err(at, `API response "${m.method} ${m.path}" matches no operation in the OpenAPI spec`);
        } else if (
          !op.responseCodes.includes(String(m.status)) &&
          !op.responseCodes.includes(`${String(m.status)[0]}XX`) &&
          !op.responseCodes.includes('default')
        ) {
          warn(
            at,
            `API response status ${m.status} is not declared for ${op.operationId} (${op.method} ${op.path})`,
          );
        }
      }
      for (const r of c.expectedApi ?? []) {
        const op = findOperationForRequest(operations.values(), r.method, r.path);
        if (!op) {
          err(
            at,
            `expected API request "${r.method} ${r.path}" matches no operation in the OpenAPI spec`,
          );
          continue;
        }
        const props = propertiesOf(docs.get(op.operationId), op.requestSchema);
        if (r.body && typeof r.body === 'object' && !Array.isArray(r.body) && props.size) {
          for (const k of Object.keys(r.body)) {
            if (!props.has(k))
              err(
                at,
                `"${k}" in the expected ${op.operationId} request is not a property of its request body`,
              );
          }
        }
      }
      const reqs = c.requirements ?? [];
      if (!reqs.length) warn(at, 'no requirement ID (requirement ID column or REQ-… in the notes)');
      for (const req of reqs) {
        covered.add(req);
        if (!knownReqs.has(req)) warn(at, `${req} not found in inputs/requirements/`);
      }
    }
    for (const [screenId, screen] of Object.entries(bindings.screens)) {
      for (const req of screen.requirements) {
        if (!covered.has(req))
          warn(
            `${relB}#screens.${screenId}.requirements`,
            `${req} is not verified by any Excel subsystem case`,
          );
      }
    }
  }
  return { findings, bindings, operations };
}

/** Element x event x API x state matrix for humans and for the implementing agent. */
export function renderBindingMatrix(
  bindings: UiBindings,
  operations: Map<string, OperationInfo>,
): string {
  const api = (call?: string) => {
    if (!call) return '—';
    const op = operations.get(call);
    return op ? `\`${call}\`<br>\`${op.method} ${op.path}\`` : `\`${call}\` ⚠`;
  };
  const lines = ['# UI ⇄ REST API binding matrix (generated from ui-bindings.yaml)', ''];
  for (const [id, s] of Object.entries(bindings.screens)) {
    lines.push(`## ${s.title} (\`${id}\`, route \`${s.route}\`)`, '');
    lines.push(
      `States: ${s.states.map((x) => (x === s.initial ? `**${x}** (initial)` : x)).join(' → ')}`,
      '',
    );
    lines.push(
      '| ui-id | kind | trigger | API | request | success | errors | conditions |',
      '| --- | --- | --- | --- | --- | --- | --- | --- |',
    );
    const cond = (el: { enabledWhen?: string; visibleWhen?: string }) =>
      [
        el.enabledWhen && `enabled: ${el.enabledWhen}`,
        el.visibleWhen && `visible: ${el.visibleWhen}`,
      ]
        .filter(Boolean)
        .join('<br>')
        .replace(/\|/g, '\\|') || '—';
    const out = (o?: { transition?: string; show?: string }) =>
      [o?.transition && `→ ${o.transition}`, o?.show].filter(Boolean).join(' / ') || '—';
    if (s.onEnter) {
      lines.push(
        `| _(screen)_ | — | enter | ${api(s.onEnter.call)} | — | ${out(s.onEnter.success)} | ${
          Object.entries(s.onEnter.errors ?? {})
            .map(([k, v]) => `${k}: ${out(v)}`)
            .join('<br>') || '—'
        } | — |`,
      );
    }
    for (const [elId, el] of Object.entries(s.elements)) {
      const rows = Object.entries(el.on ?? {});
      if (el.source) {
        lines.push(
          `| \`${elId}\` | ${el.kind} | ${el.source.poll ? `poll ${el.source.poll}` : 'load'} | ${api(el.source.call)} | \`${el.source.path}\` | ${
            Object.entries(el.map ?? {})
              .map(([k, v]) => `${k}→${v}`)
              .join(', ') || '—'
          } | — | ${cond(el)} |`,
        );
      }
      for (const [event, a] of rows) {
        lines.push(
          `| \`${elId}\` | ${el.kind} | ${event} | ${a.navigate ? `navigate \`${a.navigate}\`` : api(a.call)} | ${
            Object.entries(a.request ?? {})
              .map(([k, v]) => `${k}=${v}`)
              .join('<br>') || '—'
          } | ${out(a.success ?? a)} | ${
            Object.entries(a.errors ?? {})
              .map(([k, v]) => `${k}: ${out(v)}`)
              .join('<br>') || '—'
          } | ${cond(el)} |`,
        );
      }
      if (!el.source && rows.length === 0) {
        lines.push(
          `| \`${elId}\` | ${el.kind} | ${el.bind ? `bind \`${el.bind}\`` : '—'} | — | ${el.validate ? `validate ${[el.validate].flat().join(', ')}` : '—'} | — | — | ${cond(el)} |`,
        );
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function inputsGate(paths: AidlcPaths): GateResult {
  const started = Date.now();
  const { findings, bindings, operations } = validateInputs(paths);
  if (bindings) {
    mkdirSync(paths.outputs.reports, { recursive: true });
    writeFileSync(
      path.join(paths.outputs.reports, 'binding-matrix.md'),
      renderBindingMatrix(bindings, operations),
      'utf8',
    );
  }
  const errors = findings.filter((f) => f.level === 'error');
  const warnings = findings.filter((f) => f.level === 'warning');
  return {
    gate: 'inputs',
    status: errors.length ? 'fail' : 'pass',
    durationMs: Date.now() - started,
    summary: `${errors.length} error(s), ${warnings.length} warning(s) in the inputs`,
    failures: errors.map((f) => ({ where: f.where, message: f.message })),
    metrics: { errors: errors.length, warnings: warnings.length },
  };
}

async function main(): Promise<number> {
  const root = findRepoRoot();
  const paths = resolvePaths(root);
  await enforceSandbox(loadConfig(paths.config), 'aidlc:validate-inputs', 'tool');
  const { findings, bindings, operations } = validateInputs(paths);
  for (const f of findings)
    (f.level === 'error' ? log.warn : log.info)(
      `${f.level.toUpperCase()} ${f.where}: ${f.message}`,
    );
  if (bindings) {
    mkdirSync(paths.outputs.reports, { recursive: true });
    const file = path.join(paths.outputs.reports, 'binding-matrix.md');
    writeFileSync(file, renderBindingMatrix(bindings, operations), 'utf8');
    log.info(`Binding matrix: ${rel(root, file)}`);
  }
  const errors = findings.filter((f) => f.level === 'error').length;
  log.info(`${errors} error(s), ${findings.length - errors} warning(s)`);
  return errors ? 1 : 0;
}

if (isMain(import.meta.url)) {
  runCli(main);
}
