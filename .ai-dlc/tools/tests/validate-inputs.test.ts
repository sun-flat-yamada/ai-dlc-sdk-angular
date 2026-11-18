import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolvePaths } from '../lib/config.js';
import { uiBindingsJsonSchema } from '../write-schemas.js';
import {
  extractUiIds,
  renderBindingMatrix,
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

  it('keeps the committed JSON Schema in sync with the zod schema', () => {
    const committed = JSON.parse(
      readFileSync(path.join(REPO_ROOT, '.ai-dlc/config/schemas/ui-bindings.schema.json'), 'utf8'),
    );
    expect(committed).toEqual(JSON.parse(JSON.stringify(uiBindingsJsonSchema())));
  });
});
