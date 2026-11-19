import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseWorkbook } from '../excel-to-test-ast.js';
import { AidlcPaths, resolvePaths } from '../lib/config.js';
import { SubsystemCase, hashCases } from '../lib/subsystem-cases.js';
import { buildSampleWorkbook } from '../samples/generate-sample-excel.js';
import { uiBindingsJsonSchema } from '../write-schemas.js';
import {
  extractUiIds,
  findOperationForRequest,
  loadOperations,
  openApiPathMatches,
  renderBindingMatrix,
  serverBasePath,
  schemaHasPath,
  validateInputs,
} from '../validate-inputs.js';
import { REPO_ROOT, copyHarness, tempRepo } from './helpers.js';

describe('validateInputs', () => {
  let cleanup = () => {};
  afterEach(() => cleanup());

  const setup = () => {
    const repo = tempRepo();
    cleanup = repo.cleanup;
    copyHarness(repo.dir);
    return resolvePaths(repo.dir);
  };
  const edit = (file: string, from: string | RegExp, to: string) => {
    const text = readFileSync(file, 'utf8');
    const next = text.replace(from, to);
    expect(next).not.toBe(text);
    writeFileSync(file, next, 'utf8');
  };

  it('accepts the sample inputs without errors or warnings', () => {
    const { findings, bindings, operations } = validateInputs(resolvePaths(REPO_ROOT));
    expect(findings).toEqual([]);
    const matrix = renderBindingMatrix(bindings!, operations);
    expect(matrix).toContain('`save-button`');
    expect(matrix).toContain('PUT /network/ipv4');
  });

  it('detects unknown operations, request fields, states and response paths', () => {
    const paths = setup();
    const file = path.join(paths.inputs.uiBindings, 'ui-bindings.yaml');
    edit(file, 'call: putIpv4Settings', 'call: putIpv4Setting');
    edit(file, 'subnetMask: form.subnetMask', 'subnetMsk: form.subnetMask');
    edit(file, 'success: { transition: saved,', 'success: { transition: done,');
    edit(
      file,
      'path: $.link }\n        map: { up: led--on',
      'path: $.lnk }\n        map: { up: led--on',
    );
    const messages = validateInputs(paths)
      .findings.filter((f) => f.level === 'error')
      .map((f) => f.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/operationId "putIpv4Setting" not found/),
        expect.stringMatching(/transition "done" is not in states/),
        expect.stringMatching(/\$\.lnk is not in the getNetworkLink response schema/),
      ]),
    );
  });

  it('detects request properties missing from the OpenAPI schema', () => {
    const paths = setup();
    edit(
      path.join(paths.inputs.uiBindings, 'ui-bindings.yaml'),
      'subnetMask: form.subnetMask',
      'subnetMsk: form.subnetMask',
    );
    const findings = validateInputs(paths).findings;
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 'error',
          message: expect.stringMatching(/"subnetMsk" is not a property/),
        }),
      ]),
    );
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 'warning',
          message: expect.stringMatching(/required request property "subnetMask"/),
        }),
      ]),
    );
  });

  it('detects HTML / binding mismatches in both directions', () => {
    const paths = setup();
    edit(
      path.join(paths.inputs.uiDesign, 'network-settings.html'),
      'data-ui-id="gateway-error"',
      'data-ui-id="gw-error"',
    );
    const errors = validateInputs(paths)
      .findings.filter((f) => f.level === 'error')
      .map((f) => f.message);
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/data-ui-id="gw-error" is neither bound/),
        expect.stringMatching(/no data-ui-id="gateway-error"/),
      ]),
    );
  });

  const writeCases = async (paths: AidlcPaths, change: (cases: SubsystemCase[]) => void) => {
    const cases = parseWorkbook(await buildSampleWorkbook()).cases;
    change(cases);
    mkdirSync(path.dirname(paths.subsystemCases), { recursive: true });
    writeFileSync(
      paths.subsystemCases,
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: '2026-11-01T00:00:00.000Z',
        sources: [],
        casesSha256: hashCases(cases),
        cases,
        warnings: [],
      }),
      'utf8',
    );
  };
  const byId = (cases: SubsystemCase[], id: string) => cases.find((c) => c.id === id)!;

  it('accepts the sample Excel cases without errors or warnings', async () => {
    const paths = setup();
    await writeCases(paths, () => {});
    expect(validateInputs(paths).findings).toEqual([]);
  });

  it('checks the API notation of Excel cases against OpenAPI', async () => {
    const paths = setup();
    await writeCases(paths, (cases) => {
      const c = byId(cases, 'ST-NET-003');
      c.mockApi.push({ method: 'GET', path: '/api/v1/network/ipv6', status: 200, raw: 'x' });
      c.mockApi.push({ method: 'PUT', path: '/api/v1/network/ipv4', status: 418, raw: 'y' });
      c.expectedApi.push({ method: 'POST', path: '/api/v1/network/ipv4', raw: 'z' });
      c.expectedApi.push({
        method: 'PUT',
        path: '/api/v1/network/ipv4',
        body: { adress: '192.168.0.20' },
        raw: 'w',
      });
    });
    const findings = validateInputs(paths).findings.map((f) => `${f.level}: ${f.message}`);
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^error: API response "GET \/api\/v1\/network\/ipv6" matches no operation/,
        ),
        expect.stringMatching(
          /^warning: API response status 418 is not declared for putIpv4Settings/,
        ),
        expect.stringMatching(
          /^error: expected API request "POST \/api\/v1\/network\/ipv4" matches no/,
        ),
        expect.stringMatching(
          /^error: "adress" in the expected putIpv4Settings request is not a property/,
        ),
      ]),
    );
  });

  it('traces requirement IDs between requirements, ui-bindings and Excel cases', async () => {
    const paths = setup();
    await writeCases(paths, (cases) => {
      byId(cases, 'ST-NET-008').requirements = [];
      byId(cases, 'ST-NET-002').requirements = ['REQ-NET-099'];
    });
    const warnings = validateInputs(paths)
      .findings.filter((f) => f.level === 'warning')
      .map((f) => `${f.where}: ${f.message}`);
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/ST-NET-008: no requirement ID/),
        expect.stringMatching(/ST-NET-002: REQ-NET-099 not found in inputs\/requirements/),
        expect.stringMatching(/REQ-NET-009 is not verified by any Excel subsystem case/),
        expect.stringMatching(/REQ-NET-004 is not verified by any Excel subsystem case/),
      ]),
    );
  });

  it('rejects schema violations with their path', () => {
    const paths = setup();
    edit(path.join(paths.inputs.uiBindings, 'ui-bindings.yaml'), 'kind: indicator', 'kind: lamp');
    const errors = validateInputs(paths).findings;
    expect(errors[0]?.where).toMatch(/elements\.link-led\.kind/);
  });
});

describe('helpers', () => {
  it('ignores ui-ids in HTML comments', () => {
    expect(
      extractUiIds('<!-- data-ui-id="x" --><b data-ui-id="a"></b><i data-ui-id=\'b\'></i>'),
    ).toEqual(['a', 'b']);
  });

  it('resolves response paths through $ref and allOf', () => {
    const doc = {
      components: {
        schemas: {
          A: {
            allOf: [{ $ref: '#/components/schemas/B' }, { properties: { c: { type: 'string' } } }],
          },
          B: { properties: { b: { properties: { d: {} } } } },
        },
      },
    };
    const schema = { $ref: '#/components/schemas/A' };
    expect(schemaHasPath(doc, schema, '$.c')).toBe(true);
    expect(schemaHasPath(doc, schema, '$.b.d')).toBe(true);
    expect(schemaHasPath(doc, schema, '$.x')).toBe(false);
    expect(schemaHasPath(doc, schema, '$')).toBe(true);
  });

  it('matches concrete requests to OpenAPI operations under the server base path', () => {
    expect(serverBasePath('/api/v1/')).toBe('/api/v1');
    expect(serverBasePath('https://device.example.invalid/api/v2')).toBe('/api/v2');
    expect(serverBasePath(undefined)).toBe('');
    expect(openApiPathMatches('/api/v1/items/{id}', '/api/v1/items/42?x=1')).toBe(true);
    expect(openApiPathMatches('/api/v1/items/{id}', '/api/v1/items/42/sub')).toBe(false);
    const { operations } = loadOperations(
      path.join(REPO_ROOT, '.ai-dlc/inputs/api-specs/device-api.openapi.yaml'),
    );
    expect(findOperationForRequest(operations, 'put', '/api/v1/network/ipv4')?.operationId).toBe(
      'putIpv4Settings',
    );
    expect(findOperationForRequest(operations, 'PUT', '/network/ipv4')).toBeUndefined();
  });

  it('keeps the committed JSON Schema in sync with the zod schema', () => {
    const committed = JSON.parse(
      readFileSync(path.join(REPO_ROOT, '.ai-dlc/config/schemas/ui-bindings.schema.json'), 'utf8'),
    );
    expect(committed).toEqual(JSON.parse(JSON.stringify(uiBindingsJsonSchema())));
  });
});
