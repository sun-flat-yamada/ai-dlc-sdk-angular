/**
 * Converts human-written subsystem test specifications (Excel) into structured JSON.
 *
 *   npm run aidlc:parse-excel                       # every *.xlsx in .ai-dlc/inputs/subsystem-tests/
 *   npm run aidlc:parse-excel -- --input file.xlsx  # one workbook
 *
 * Output: .ai-dlc/outputs/generated-tests/subsystem-cases.json (+ subsystem-cases.md checklist)
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import ExcelJS from 'exceljs';
import { AidlcConfig, AidlcPaths, findRepoRoot, loadConfig, resolvePaths } from './lib/config.js';
import { isMain, log, rel, runCli } from './lib/cli.js';
import { enforceSandbox } from './lib/sandbox.js';
import {
  SubsystemCase,
  SubsystemCaseFile,
  hashCases,
  parseApiMocks,
  parseApiRequests,
  parseRequirementIds,
  parseCss,
  parseKeyValues,
  parseSteps,
  extractUiRefs,
  splitLines,
} from './lib/subsystem-cases.js';
import { writeJsonAtomic } from './lib/telemetry.js';

export type CaseField =
  | 'id'
  | 'category'
  | 'title'
  | 'priority'
  | 'preconditions'
  | 'initialDeviceState'
  | 'mockApi'
  | 'steps'
  | 'expectedUi'
  | 'expectedCss'
  | 'expectedApi'
  | 'requirements'
  | 'notes';

/** Built-in header names (English / Japanese). Matching ignores case, spaces and full-width forms. */
export const DEFAULT_HEADER_ALIASES: Record<CaseField, string[]> = {
  id: ['test id', 'case id', 'id', 'テストid', 'テストno', 'テスト番号', '項番', 'ケースid'],
  category: ['category', 'feature', '大項目', '機能', '分類'],
  title: ['title', 'test item', 'test name', 'テスト項目', '確認項目', '中項目', 'テスト名'],
  priority: ['priority', '優先度', '重要度'],
  preconditions: ['preconditions', 'precondition', '前提条件'],
  initialDeviceState: [
    'initial device state',
    'device state',
    '機器初期状態',
    '初期状態',
    '機器状態',
  ],
  mockApi: [
    'api responses',
    'mock responses',
    'api mock',
    'api応答',
    'モック応答',
    'api応答(モック)',
  ],
  steps: ['steps', 'procedure', 'operation', '操作手順', '手順', 'フロントパネル操作手順'],
  expectedUi: [
    'expected ui',
    'expected display',
    'expected result',
    '期待画面表示',
    '期待結果',
    '期待値(画面)',
  ],
  expectedCss: ['expected css', 'expected style', '期待css状態', '期待css', '期待スタイル'],
  expectedApi: [
    'expected api request',
    'expected request',
    'expected api',
    '期待apiリクエスト',
    '期待api',
  ],
  requirements: [
    'requirement id',
    'requirement ids',
    'requirements',
    'req id',
    '要件id',
    '要件番号',
    '関連要件',
    '要件',
  ],
  notes: ['notes', 'remarks', '備考'],
};

export function normalizeHeader(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s_　]+/g, ' ')
    .replace(/\s*\(\s*/g, '(')
    .replace(/\s*\)\s*/g, ')')
    .trim();
}

/** Plain text of an ExcelJS cell value (rich text, formulas, hyperlinks, dates). */
export function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText.map((r) => r.text).join('');
    }
    if ('result' in value) return cellText(value.result as ExcelJS.CellValue);
    if ('text' in value) return cellText(value.text as ExcelJS.CellValue);
  }
  return String(value);
}

function buildAliasMap(extra: Record<string, string[]>): Map<string, CaseField> {
  const map = new Map<string, CaseField>();
  for (const [field, names] of Object.entries(DEFAULT_HEADER_ALIASES) as [CaseField, string[]][]) {
    for (const n of [...names, ...(extra[field] ?? [])]) map.set(normalizeHeader(n), field);
  }
  return map;
}

/** Finds the header row (within the first 15 rows) and maps column numbers to fields. */
export function detectHeader(
  sheet: ExcelJS.Worksheet,
  aliases: Map<string, CaseField>,
): { row: number; columns: Map<number, CaseField> } | undefined {
  const last = Math.min(sheet.rowCount, 15);
  for (let r = 1; r <= last; r++) {
    const columns = new Map<number, CaseField>();
    sheet.getRow(r).eachCell((cell, col) => {
      const field = aliases.get(normalizeHeader(cellText(cell.value)));
      if (field && ![...columns.values()].includes(field)) columns.set(col, field);
    });
    const fields = new Set(columns.values());
    if (fields.has('id') && fields.has('steps') && fields.size >= 3) {
      return { row: r, columns };
    }
  }
  return undefined;
}

export interface ParseResult {
  cases: SubsystemCase[];
  warnings: string[];
  sheets: string[];
}

export function parseWorkbook(
  workbook: ExcelJS.Workbook,
  options: { sheets?: string[]; headerAliases?: Record<string, string[]> } = {},
): ParseResult {
  const aliases = buildAliasMap(options.headerAliases ?? {});
  const result: ParseResult = { cases: [], warnings: [], sheets: [] };
  const seen = new Set<string>();
  for (const sheet of workbook.worksheets) {
    if (options.sheets?.length && !options.sheets.includes(sheet.name)) continue;
    const header = detectHeader(sheet, aliases);
    if (!header) {
      if (options.sheets?.length)
        result.warnings.push(`Sheet "${sheet.name}": no header row found`);
      continue;
    }
    result.sheets.push(sheet.name);
    let category = '';
    for (let r = header.row + 1; r <= sheet.rowCount; r++) {
      const row = sheet.getRow(r);
      const raw: Partial<Record<CaseField, string>> = {};
      for (const [col, field] of header.columns)
        raw[field] = cellText(row.getCell(col).value).trim();
      // Category cells are often merged / left blank below the first row of a group.
      if (raw.category) category = raw.category;
      const id = raw.id ?? '';
      if (!id) {
        if (raw.steps || raw.expectedUi) {
          result.warnings.push(`${sheet.name}!R${r}: row has content but no test ID — skipped`);
        }
        continue;
      }
      if (seen.has(id)) {
        result.warnings.push(`${sheet.name}!R${r}: duplicate test ID "${id}" — skipped`);
        continue;
      }
      seen.add(id);
      const testCase: SubsystemCase = {
        id,
        sheet: sheet.name,
        row: r,
        category,
        title: raw.title ?? '',
        priority: raw.priority ?? '',
        requirements: parseRequirementIds(raw.requirements ?? '', raw.notes ?? ''),
        preconditions: splitLines(raw.preconditions ?? ''),
        initialDeviceState: parseKeyValues(raw.initialDeviceState ?? ''),
        mockApi: parseApiMocks(raw.mockApi ?? ''),
        steps: parseSteps(raw.steps ?? ''),
        expectedUi: splitLines(raw.expectedUi ?? ''),
        expectedCss: parseCss(raw.expectedCss ?? ''),
        expectedApi: parseApiRequests(raw.expectedApi ?? ''),
        uiRefs: extractUiRefs(
          raw.preconditions ?? '',
          raw.steps ?? '',
          raw.expectedUi ?? '',
          raw.expectedCss ?? '',
        ),
        notes: raw.notes ?? '',
      };
      if (testCase.steps.length === 0) result.warnings.push(`${id}: no steps`);
      if (
        !testCase.expectedUi.length &&
        !testCase.expectedCss.length &&
        !testCase.expectedApi.length
      ) {
        result.warnings.push(`${id}: no expected result (UI / CSS / API)`);
      }
      const unparsedApi = splitLines(raw.expectedApi ?? '').length - testCase.expectedApi.length;
      if (unparsedApi > 0)
        result.warnings.push(
          `${id}: ${unparsedApi} expected API line(s) not in "METHOD /path {json}" form`,
        );
      const unparsedMock = splitLines(raw.mockApi ?? '').length - testCase.mockApi.length;
      if (unparsedMock > 0)
        result.warnings.push(
          `${id}: ${unparsedMock} API response line(s) not in "METHOD /path -> 200 {json}" form`,
        );
      result.cases.push(testCase);
    }
  }
  return result;
}

/**
 * Readable list of the cases. It is an input of the development steps (skills 01-03), so it carries
 * every expectation, not only counts: the implementation is built against these acceptance criteria.
 */
export function renderChecklist(file: SubsystemCaseFile): string {
  const lines = [
    '# Subsystem test cases (generated — do not edit)',
    '',
    `Generated: ${file.generatedAt} / cases: ${file.cases.length} / sha256: \`${file.casesSha256.slice(0, 16)}\``,
    '',
    'Acceptance criteria written by humans. Use them while designing and implementing, not only at test time.',
    '',
    '| ID | Category | Title | Requirements | Steps | Expected UI | Expected CSS | Expected API |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, '<br>');
  for (const c of file.cases) {
    lines.push(
      `| ${cell(c.id)} | ${cell(c.category)} | ${cell(c.title)} | ${cell(c.requirements.join(', ')) || '—'} | ${c.steps.length} | ${c.expectedUi.length} | ${c.expectedCss.length} | ${c.expectedApi.length} |`,
    );
  }
  const list = (title: string, items: string[]) =>
    items.length ? ['', `**${title}**`, '', ...items.map((x) => `- ${x}`)] : [];
  for (const c of file.cases) {
    lines.push(
      '',
      `## ${c.id} — ${c.title}`,
      '',
      `Requirements: ${c.requirements.join(', ') || '—'} / priority: ${c.priority || '—'} / source: ${c.sheet}!R${c.row}`,
      ...list('Preconditions', c.preconditions),
      ...list(
        'Initial device state',
        Object.entries(c.initialDeviceState).map(([k, v]) => `\`${k}=${v}\``),
      ),
      ...list(
        'Mocked API responses',
        c.mockApi.map((m) => `\`${m.raw}\``),
      ),
      ...list(
        'Steps',
        c.steps.map((s) => `${s.no}. ${s.action}`),
      ),
      ...list('Expected UI', c.expectedUi),
      ...list(
        'Expected CSS',
        c.expectedCss.map((x) => `\`${x.raw}\``),
      ),
      ...list(
        'Expected API requests',
        c.expectedApi.map((x) => `\`${x.raw}\``),
      ),
      ...(c.notes ? ['', `Notes: ${c.notes.replace(/\n/g, ' ')}`] : []),
    );
  }
  if (file.warnings.length) {
    lines.push('', '## Warnings', '', ...file.warnings.map((w) => `- ${w}`));
  }
  return `${lines.join('\n')}\n`;
}

export function findWorkbooks(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.xlsx') && !f.startsWith('~$'))
    .sort()
    .map((f) => path.join(dir, f));
}

/** Parses every workbook and writes `subsystem-cases.json` / `.md`. */
export async function convertWorkbooks(
  paths: AidlcPaths,
  config: AidlcConfig,
  inputs: string[] = findWorkbooks(paths.inputs.subsystemTests),
): Promise<SubsystemCaseFile> {
  if (inputs.length === 0) {
    throw new Error(`No *.xlsx found in ${rel(paths.root, paths.inputs.subsystemTests)}`);
  }
  const file: SubsystemCaseFile = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sources: [],
    casesSha256: '',
    cases: [],
    warnings: [],
  };
  const ids = new Set<string>();
  for (const input of inputs) {
    const buffer = readFileSync(input);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const parsed = parseWorkbook(workbook, config.excel);
    for (const c of parsed.cases) {
      if (ids.has(c.id)) {
        file.warnings.push(
          `${rel(paths.root, input)}: duplicate test ID "${c.id}" across workbooks — skipped`,
        );
        continue;
      }
      ids.add(c.id);
      file.cases.push(c);
    }
    file.warnings.push(...parsed.warnings.map((w) => `${path.basename(input)}: ${w}`));
    file.sources.push({
      file: rel(paths.root, input),
      sha256: createHash('sha256').update(buffer).digest('hex'),
      sheets: parsed.sheets,
    });
  }
  file.casesSha256 = hashCases(file.cases);
  writeJsonAtomic(paths.subsystemCases, file);
  mkdirSync(paths.outputs.generatedTests, { recursive: true });
  writeFileSync(
    path.join(paths.outputs.generatedTests, 'subsystem-cases.md'),
    renderChecklist(file),
    'utf8',
  );
  return file;
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { input: { type: 'string', multiple: true } } });
  const root = findRepoRoot();
  const paths = resolvePaths(root);
  const config = loadConfig(paths.config);
  await enforceSandbox(config, 'aidlc:parse-excel', 'tool');
  const inputs = values.input?.map((f) => path.resolve(f));
  const file = await convertWorkbooks(paths, config, inputs);
  log.info(
    `${file.cases.length} case(s) from ${file.sources.length} workbook(s) -> ${rel(root, paths.subsystemCases)}`,
  );
  for (const w of file.warnings) log.warn(w);
  return file.cases.length > 0 ? 0 : 1;
}

if (isMain(import.meta.url)) {
  runCli(main);
}
