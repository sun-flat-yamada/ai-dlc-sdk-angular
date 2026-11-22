import { createHash } from 'node:crypto';

/** One expected REST API request (`PUT /api/v1/network/ipv4 {"dhcp":false}`). */
export interface ApiRequestExpectation {
  method: string;
  path: string;
  /** Subset of the JSON body that must match. */
  body?: unknown;
  raw: string;
}

/** One mocked REST API response (`GET /api/v1/network/ipv4 -> 200 {...}`). */
export interface ApiMockResponse {
  method: string;
  path: string;
  status: number;
  body?: unknown;
  raw: string;
}

/** One expected CSS state (`[data-testid=save] { background-color: rgb(47, 140, 255) }`). */
export interface CssExpectation {
  selector?: string;
  property: string;
  value: string;
  raw: string;
}

export interface TestStep {
  no: number;
  action: string;
}

/** A subsystem test case converted from one Excel row. */
export interface SubsystemCase {
  id: string;
  sheet: string;
  row: number;
  category: string;
  title: string;
  priority: string;
  /** Requirement IDs this case verifies (requirement ID column, or `REQ-…` found in the notes). */
  requirements: string[];
  preconditions: string[];
  /** `key=value` lines of the initial device state. */
  initialDeviceState: Record<string, string>;
  mockApi: ApiMockResponse[];
  steps: TestStep[];
  expectedUi: string[];
  expectedCss: CssExpectation[];
  expectedApi: ApiRequestExpectation[];
  /** `@ui-id` references found in steps / expectations (resolved against ui-bindings.yaml). */
  uiRefs: string[];
  notes: string;
}

export interface SubsystemCaseFile {
  schemaVersion: 1;
  generatedAt: string;
  sources: { file: string; sha256: string; sheets: string[] }[];
  /** SHA-256 over `cases` only; used to detect tampering with expected values. */
  casesSha256: string;
  cases: SubsystemCase[];
  warnings: string[];
}

/** Playwright annotation type the subsystem kit records for every expectation it verified. */
export const VERIFIED_ANNOTATION = 'aidlc-verified';

export type ExpectationKind = 'api' | 'css' | 'ui';

/** Annotation description of one verified expectation: `<case ID>:<kind>:<index>`. */
export function verifiedKey(caseId: string, kind: ExpectationKind, index: number): string {
  return `${caseId}:${kind}:${index}`;
}

/** Every expectation of a case that a passing test has to verify (as `verifiedKey` strings). */
export function requiredVerifications(c: SubsystemCase): { key: string; label: string }[] {
  return [
    ...c.expectedApi.map((e, i) => ({
      key: verifiedKey(c.id, 'api', i),
      label: `expectedApi[${i}] ${e.raw} (expectApiRequests)`,
    })),
    ...c.expectedCss.map((e, i) => ({
      key: verifiedKey(c.id, 'css', i),
      label: `expectedCss[${i}] ${e.raw} (expectCss)`,
    })),
    ...c.expectedUi.map((line, i) => ({
      key: verifiedKey(c.id, 'ui', i),
      label: `expectedUi[${i}] ${line} (expectUi(c, ${i}, …))`,
    })),
  ];
}

export function hashCases(cases: readonly SubsystemCase[]): string {
  return createHash('sha256').update(JSON.stringify(cases)).digest('hex');
}

const REQUIREMENT_ID = /\bREQ-[A-Z0-9][A-Z0-9-]*[A-Z0-9]\b/g;

/**
 * Requirement IDs of a case. The requirement ID column is split on commas, spaces and line breaks;
 * when it is empty, `REQ-…` IDs written in the notes are used (older workbooks).
 */
export function parseRequirementIds(column: string, notes = ''): string[] {
  const listed = column
    .split(/[\s,、，;；/]+/u)
    .map((x) => x.trim())
    .filter(Boolean);
  const ids = listed.length ? listed : [...notes.matchAll(REQUIREMENT_ID)].map((m) => m[0]);
  return [...new Set(ids)];
}

/** Splits a multi-line cell into items, removing list markers such as `1.`, `(2)`, `①`, `・`, `-`. */
export function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) =>
      l
        .trim()
        .replace(/^(?:\(?\d+[.)．）]|[①-⑳]|[・\-*•])\s*/u, '')
        .trim(),
    )
    .filter((l) => l.length > 0);
}

function parseJsonLoose(text: string | undefined): unknown {
  if (!text?.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text.trim();
  }
}

const METHOD = '(GET|POST|PUT|PATCH|DELETE)';

export function parseApiRequests(text: string): ApiRequestExpectation[] {
  const re = new RegExp(`^${METHOD}\\s+(\\S+)\\s*(.*)$`, 'i');
  return splitLines(text).flatMap((line) => {
    const m = re.exec(line);
    if (!m) return [];
    const body = parseJsonLoose(m[3]);
    return [
      {
        method: m[1]!.toUpperCase(),
        path: m[2]!,
        ...(body !== undefined ? { body } : {}),
        raw: line,
      },
    ];
  });
}

export function parseApiMocks(text: string): ApiMockResponse[] {
  const re = new RegExp(`^${METHOD}\\s+(\\S+)\\s*(?:->|→|=>)\\s*(\\d{3})\\s*(.*)$`, 'i');
  return splitLines(text).flatMap((line) => {
    const m = re.exec(line);
    if (!m) return [];
    const body = parseJsonLoose(m[4]);
    return [
      {
        method: m[1]!.toUpperCase(),
        path: m[2]!,
        status: Number(m[3]),
        ...(body !== undefined ? { body } : {}),
        raw: line,
      },
    ];
  });
}

export function parseCss(text: string): CssExpectation[] {
  return splitLines(text).flatMap((line) => {
    const block = /^(.+?)\s*\{\s*([\w-]+)\s*:\s*(.+?)\s*;?\s*\}$/.exec(line);
    if (block) {
      return [{ selector: block[1]!.trim(), property: block[2]!, value: block[3]!, raw: line }];
    }
    const decl = /^([\w-]+)\s*:\s*(.+?)\s*;?$/.exec(line);
    return decl ? [{ property: decl[1]!, value: decl[2]!, raw: line }] : [];
  });
}

export function parseKeyValues(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of splitLines(text)) {
    const m = /^([^=:：]+)[=:：](.*)$/.exec(line);
    if (m) out[m[1]!.trim()] = m[2]!.trim();
  }
  return out;
}

/** Collects `@ui-id` element references (`@save-button`). E-mail-like text is ignored. */
export function extractUiRefs(...texts: string[]): string[] {
  const refs = texts.flatMap((t) =>
    [...t.matchAll(/(?<![\w.])@([a-z][a-z0-9-]*)/g)].map((m) => m[1]!),
  );
  return [...new Set(refs)];
}

export function parseSteps(text: string): TestStep[] {
  return splitLines(text).map((action, i) => ({ no: i + 1, action }));
}
