/**
 * Writes JSON Schemas of the harness input formats (for editor validation / completion):
 *   .ai-dlc/config/schemas/ui-bindings.schema.json
 *
 *   npm run aidlc:schemas
 */
import path from 'node:path';
import { z } from 'zod';
import { findRepoRoot, loadConfig, resolvePaths } from './lib/config.js';
import { isMain, log, runCli } from './lib/cli.js';
import { enforceSandbox } from './lib/sandbox.js';
import { writeJsonAtomic } from './lib/telemetry.js';
import { uiBindingsSchema } from './lib/ui-bindings.js';

export function uiBindingsJsonSchema(): unknown {
  return {
    ...z.toJSONSchema(uiBindingsSchema, { io: 'input' }),
    title: 'AI-DLC ui-bindings.yaml',
    description:
      'Binds design HTML elements (data-ui-id) to REST API operations (OpenAPI operationId) and screen states.',
  };
}

async function main(): Promise<number> {
  const root = findRepoRoot();
  await enforceSandbox(loadConfig(resolvePaths(root).config), 'aidlc:schemas', 'tool');
  const file = path.join(root, '.ai-dlc', 'config', 'schemas', 'ui-bindings.schema.json');
  writeJsonAtomic(file, uiBindingsJsonSchema());
  log.info(`Wrote ${file}`);
  return 0;
}

if (isMain(import.meta.url)) {
  runCli(main);
}
