import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HEADER_ALIASES,
  cellText,
  normalizeHeader,
  parseWorkbook,
} from '../excel-to-test-ast.js';
import {
  extractUiRefs,
  hashCases,
  parseApiMocks,
  parseApiRequests,
  parseCss,
  parseKeyValues,
  parseRequirementIds,
  splitLines,
} from '../lib/subsystem-cases.js';
import { SAMPLE_ROWS, buildSampleWorkbook } from '../samples/generate-sample-excel.js';

describe('cell parsers', () => {
  it('splits numbered and bulleted lines', () => {
    expect(splitLines('1. open\n2) press\n③ wait\n・check\n- done\n\n')).toEqual([
      'open',
      'press',
      'wait',
      'check',
      'done',
    ]);
  });

  it('parses expected API requests and mock responses', () => {
    expect(parseApiRequests('PUT /api/v1/x {"a":1}\nget /api/v1/y\nnot a request')).toEqual([
      { method: 'PUT', path: '/api/v1/x', body: { a: 1 }, raw: 'PUT /api/v1/x {"a":1}' },
      { method: 'GET', path: '/api/v1/y', raw: 'get /api/v1/y' },
    ]);
    expect(parseApiMocks('GET /api/v1/x -> 200 {"ok":true}\nPUT /api/v1/x → 503')).toEqual([
      {
        method: 'GET',
        path: '/api/v1/x',
        status: 200,
        body: { ok: true },
        raw: 'GET /api/v1/x -> 200 {"ok":true}',
      },
      { method: 'PUT', path: '/api/v1/x', status: 503, raw: 'PUT /api/v1/x → 503' },
    ]);
  });

  it('parses CSS expectations with and without selectors', () => {
    expect(parseCss('@led { background-color: rgb(1, 2, 3) }\ncolor: red;')).toEqual([
      {
        selector: '@led',
        property: 'background-color',
        value: 'rgb(1, 2, 3)',
        raw: '@led { background-color: rgb(1, 2, 3) }',
      },
      { property: 'color', value: 'red', raw: 'color: red;' },
    ]);
  });

  it('parses key-values and ui references', () => {
    expect(parseKeyValues('state=ready\nlink：up')).toEqual({ state: 'ready', link: 'up' });
    expect(
      extractUiRefs('press @save-button then @save-button', 'mail a@b.c', '@ip-address'),
    ).toEqual(['save-button', 'ip-address']);
  });

  it('parses requirement IDs from the column, or from the notes as a fallback', () => {
    expect(parseRequirementIds('REQ-NET-001, REQ-NET-002\nREQ-NET-001、REQ-NET-003')).toEqual([
      'REQ-NET-001',
      'REQ-NET-002',
      'REQ-NET-003',
    ]);
    expect(parseRequirementIds('', 'see REQ-NET-004 and REQ-NET-N01.')).toEqual([
      'REQ-NET-004',
      'REQ-NET-N01',
    ]);
    expect(parseRequirementIds('', 'no ids')).toEqual([]);
  });

  it('normalizes headers and reads rich text cells', () => {
    expect(normalizeHeader(' API応答 （モック） ')).toBe('api応答(モック)');
    expect(DEFAULT_HEADER_ALIASES.mockApi.map(normalizeHeader)).toContain('api応答(モック)');
    expect(cellText({ richText: [{ text: 'a' }, { text: 'b' }] } as ExcelJS.CellValue)).toBe('ab');
    expect(cellText({ formula: '1+1', result: 2 } as ExcelJS.CellValue)).toBe('2');
  });
});

describe('parseWorkbook', () => {
  it('converts the sample workbook', async () => {
    const result = parseWorkbook(await buildSampleWorkbook());
    expect(result.sheets).toEqual(['ネットワーク設定']);
    expect(result.cases).toHaveLength(SAMPLE_ROWS.length);
    expect(result.warnings).toEqual([]);
    const c3 = result.cases.find((c) => c.id === 'ST-NET-003')!;
    expect(c3.category).toBe('ネットワーク設定'); // carried down from the first row of the group
    expect(c3.steps.map((s) => s.no)).toEqual([1, 2, 3]);
    expect(c3.expectedApi[0]).toMatchObject({
      method: 'PUT',
      path: '/api/v1/network/ipv4',
      body: { address: '192.168.0.20' },
    });
    expect(c3.mockApi.map((m) => `${m.method} ${m.path} ${m.status}`)).toContain(
      'PUT /api/v1/network/ipv4 200',
    );
    expect(c3.uiRefs).toEqual(['ip-address', 'save-button', 'status-message']);
    expect(c3.requirements).toEqual(['REQ-NET-006']);
    expect(result.cases.find((c) => c.id === 'ST-NET-001')!.requirements).toEqual([
      'REQ-NET-001',
      'REQ-NET-002',
      'REQ-NET-003',
    ]);
  });

  it('round-trips through an xlsx buffer', async () => {
    const buffer = await (await buildSampleWorkbook()).xlsx.writeBuffer();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const result = parseWorkbook(wb);
    expect(result.cases).toHaveLength(SAMPLE_ROWS.length);
    expect(hashCases(result.cases)).toBe(
      hashCases(parseWorkbook(await buildSampleWorkbook()).cases),
    );
  });

  it('reports rows without ID, duplicates and missing expectations', () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    ws.addRow(['Test ID', 'Title', 'Steps', 'Expected UI']);
    ws.addRow(['T-1', 'ok', '1. a', 'x']);
    ws.addRow(['', 'orphan', '1. b', 'y']);
    ws.addRow(['T-1', 'dup', '1. c', 'z']);
    ws.addRow(['T-2', 'no expectation', '1. d', '']);
    const result = parseWorkbook(wb);
    expect(result.cases.map((c) => c.id)).toEqual(['T-1', 'T-2']);
    expect(result.warnings.join('\n')).toMatch(/no test ID/);
    expect(result.warnings.join('\n')).toMatch(/duplicate test ID "T-1"/);
    expect(result.warnings.join('\n')).toMatch(/T-2: no expected result/);
  });

  it('supports custom header aliases and sheet filters', () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Other').addRow(['nothing']);
    const ws = wb.addWorksheet('Main');
    ws.addRow(['Case No', 'Procedure', 'Result']);
    ws.addRow(['C-1', 'do', 'see']);
    const result = parseWorkbook(wb, {
      sheets: ['Main'],
      headerAliases: { id: ['Case No'], expectedUi: ['Result'] },
    });
    expect(result.cases).toHaveLength(1);
    expect(result.cases[0]).toMatchObject({ id: 'C-1', expectedUi: ['see'] });
  });
});
