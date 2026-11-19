/**
 * Installs the AI-DLC SDK into an EXISTING Angular repository without touching its source code.
 *
 *   npm run aidlc:install -- --target ../my-panel-app [--dry-run] [--with-sample] [--force]
 *
 * Copies .ai-dlc/{tools,config,references,inputs,outputs} skeletons, .github/skills/ and the
 * sandbox (.devcontainer/ + scripts/sandbox.ts), adds the aidlc:* and sandbox npm scripts and the
 * harness devDependencies, and appends .gitignore rules. Existing files are kept unless --force
 * is given. Then start the sandbox in the target (npm run sandbox -- up): it installs the
 * dependencies inside the container.
 *
 * The installer is the only harness command that does not require the sandbox: it executes no
 * project code and is how the sandbox gets into the target repository.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { findRepoRoot } from './lib/config.js';
import { isMain, log, runCli } from './lib/cli.js';

export const HARNESS_DEV_DEPENDENCIES = [
  '@playwright/test',
  '@types/cross-spawn',
  '@types/picomatch',
  'cross-spawn',
  'exceljs',
  'picomatch',
  'tsx',
  'vitest',
  'yaml',
  'zod',
] as const;

const GITIGNORE_BLOCK = `
# AI-DLC harness outputs (generated)
/.ai-dlc/outputs/**
!/.ai-dlc/outputs/**/
!/.ai-dlc/outputs/README.md
!/.ai-dlc/outputs/**/.gitkeep
/test-results/
/playwright-report/
# Extra CA certificates for the AI-DLC sandbox image (local only)
/.devcontainer/certs/*
!/.devcontainer/certs/README.md
`;

export interface InstallAction {
  kind: 'copy' | 'skip' | 'package.json' | '.gitignore' | 'config';
  target: string;
  detail: string;
}

function listFiles(
  dir: string,
  filter: (rel: string) => boolean = () => true,
  base = dir,
): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const abs = path.join(dir, name);
    const rel = path.relative(base, abs).split(path.sep).join('/');
    if (statSync(abs).isDirectory()) return listFiles(abs, filter, base);
    return filter(rel) ? [rel] : [];
  });
}

export function planInstall(
  sourceRoot: string,
  targetRoot: string,
  options: { withSample: boolean; force: boolean },
): InstallAction[] {
  const actions: InstallAction[] = [];
  const copy = (srcRel: string) => {
    const dst = path.join(targetRoot, srcRel);
    if (existsSync(dst) && !options.force)
      actions.push({ kind: 'skip', target: srcRel, detail: 'exists (use --force)' });
    else actions.push({ kind: 'copy', target: srcRel, detail: '' });
  };
  const groups: [string, (rel: string) => boolean][] = [
    ['.ai-dlc/tools', (r) => !r.startsWith('tests/') && !r.startsWith('node_modules/')],
    ['.ai-dlc/config', () => true],
    ['.ai-dlc/references', () => true],
    ['.ai-dlc/outputs', (r) => r === 'README.md' || r.endsWith('.gitkeep')],
    ['.ai-dlc/inputs', (r) => options.withSample || r.endsWith('README.md')],
    ['.github/skills', () => true],
    // The sandbox: never copy local CA certificates.
    ['.devcontainer', (r) => !r.startsWith('certs/') || r === 'certs/README.md'],
  ];
  for (const [dir, filter] of groups) {
    for (const rel of listFiles(path.join(sourceRoot, dir), filter)) copy(`${dir}/${rel}`);
  }
  copy('scripts/sandbox.ts');
  actions.push({
    kind: 'package.json',
    target: 'package.json',
    detail: 'add aidlc:* scripts and missing harness devDependencies',
  });
  actions.push({ kind: '.gitignore', target: '.gitignore', detail: 'append AI-DLC output rules' });
  actions.push({
    kind: 'config',
    target: '.ai-dlc/config/aidlc.config.yaml',
    detail: 'set project name from angular.json',
  });
  return actions;
}

export function mergePackageJson(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const srcScripts = (source['scripts'] ?? {}) as Record<string, string>;
  const scripts = { ...((target['scripts'] ?? {}) as Record<string, string>) };
  for (const [k, v] of Object.entries(srcScripts)) {
    if (
      (k.startsWith('aidlc:') || k === 'sandbox') &&
      k !== 'aidlc:install' &&
      k !== 'aidlc:sample-excel' &&
      !(k in scripts)
    )
      scripts[k] = v;
  }
  const devDependencies = { ...((target['devDependencies'] ?? {}) as Record<string, string>) };
  const deps = (target['dependencies'] ?? {}) as Record<string, string>;
  const srcDev = (source['devDependencies'] ?? {}) as Record<string, string>;
  for (const name of HARNESS_DEV_DEPENDENCIES) {
    if (!(name in devDependencies) && !(name in deps) && srcDev[name])
      devDependencies[name] = srcDev[name];
  }
  return { ...target, scripts, devDependencies };
}

export function runInstall(
  sourceRoot: string,
  targetRoot: string,
  options: { withSample: boolean; force: boolean; dryRun: boolean },
): InstallAction[] {
  if (!existsSync(path.join(targetRoot, 'angular.json'))) {
    throw new Error(`${targetRoot} has no angular.json — the target must be an Angular workspace.`);
  }
  const actions = planInstall(sourceRoot, targetRoot, options);
  if (options.dryRun) return actions;
  for (const a of actions) {
    if (a.kind === 'copy') {
      const dst = path.join(targetRoot, a.target);
      mkdirSync(path.dirname(dst), { recursive: true });
      // cpSync keeps the executable bit of the sandbox shell scripts.
      cpSync(path.join(sourceRoot, a.target), dst);
    }
  }
  for (const dir of [
    'requirements',
    'ui-design',
    'api-specs',
    'ui-bindings',
    'subsystem-tests',
    'human-baseline',
  ]) {
    mkdirSync(path.join(targetRoot, '.ai-dlc', 'inputs', dir), { recursive: true });
  }
  const pkgFile = path.join(targetRoot, 'package.json');
  const merged = mergePackageJson(
    JSON.parse(readFileSync(pkgFile, 'utf8')) as Record<string, unknown>,
    JSON.parse(readFileSync(path.join(sourceRoot, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >,
  );
  writeFileSync(pkgFile, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  const gitignore = path.join(targetRoot, '.gitignore');
  const current = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : '';
  if (!current.includes('/.ai-dlc/outputs/**'))
    writeFileSync(gitignore, `${current.trimEnd()}\n${GITIGNORE_BLOCK}`, 'utf8');
  const angular = JSON.parse(readFileSync(path.join(targetRoot, 'angular.json'), 'utf8')) as {
    projects?: Record<string, unknown>;
  };
  const project = Object.keys(angular.projects ?? {})[0];
  const configFile = path.join(targetRoot, '.ai-dlc', 'config', 'aidlc.config.yaml');
  if (project && existsSync(configFile)) {
    const text = readFileSync(configFile, 'utf8')
      .replace(/^(\s*name:\s*).*$/m, `$1${project}`)
      .replace(/^(\s*angularProject:\s*).*$/m, `$1${project}`)
      .replace(/coverage\/front-panel\//g, `coverage/${project}/`);
    writeFileSync(configFile, text, 'utf8');
  }
  return actions;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      target: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'with-sample': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
    },
  });
  if (!values.target) throw new Error('--target <path to an Angular repository> is required');
  const source = findRepoRoot();
  const target = path.resolve(values.target);
  const actions = runInstall(source, target, {
    dryRun: values['dry-run'],
    withSample: values['with-sample'],
    force: values.force,
  });
  for (const a of actions)
    log.info(`${a.kind.padEnd(12)} ${a.target}${a.detail ? ` — ${a.detail}` : ''}`);
  log.info(
    values['dry-run'] ? 'Dry-run: nothing written.' : 'Installed. Next steps in the target:',
  );
  if (!values['dry-run']) {
    log.info('  1. npm run sandbox -- up   (Docker; builds the sandbox and runs npm ci inside)');
    log.info(
      '  2. Edit .ai-dlc/config/boundary-policy.yaml and regenerate .ai-dlc/references/ for YOUR code base',
    );
    log.info(
      '  3. Put the inputs into .ai-dlc/inputs/ and run npm run sandbox -- exec npm run aidlc:validate-inputs',
    );
    log.info(
      '  4. npm run sandbox -- exec npm run aidlc:run -- --max-iterations 3 --dry-run   (docs/sandbox.md)',
    );
  }
  return 0;
}

if (isMain(import.meta.url)) {
  runCli(main);
}
