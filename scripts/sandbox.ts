/**
 * Host-side launcher for the AI-DLC sandbox (.devcontainer). Needs only Node.js and Docker on the
 * host: it runs with Node's built-in TypeScript support, imports nothing outside node:*, and never
 * installs the repository's dependencies on the host.
 *
 *   npm run sandbox -- up                 build (first time) and start the sandbox
 *   npm run sandbox -- exec <command…>    run a command inside, e.g. exec npm run aidlc:run
 *   npm run sandbox -- shell              interactive shell inside the sandbox
 *   npm run sandbox -- status             show the container
 *   npm run sandbox -- down               stop and remove the container (volumes are kept)
 *   npm run sandbox -- rebuild            rebuild the image and recreate the container
 *
 * Uses the Dev Container CLI (@devcontainers/cli, pinned below) through npx.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEVCONTAINER_CLI = '@devcontainers/cli@0.90.0';

const USAGE = 'Usage: npm run sandbox -- <up|exec <command…>|shell|status|down|rebuild>';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The argument vector for the Dev Container CLI, or null for commands handled with docker. */
export function devcontainerArgs(command: string, rest: string[], root: string): string[] | null {
  const ws = ['--workspace-folder', root];
  switch (command) {
    case 'up':
      return ['up', ...ws];
    case 'rebuild':
      return ['up', ...ws, '--remove-existing-container', '--build-no-cache'];
    case 'exec':
      if (rest.length === 0) throw new Error(`exec needs a command.\n${USAGE}`);
      return ['exec', ...ws, ...rest];
    case 'shell':
      return ['exec', ...ws, 'bash', '-l'];
    case 'status':
    case 'down':
      return null;
    default:
      throw new Error(`Unknown command "${command}".\n${USAGE}`);
  }
}

/** Runs npx through the npm that ships with this Node.js (no shell, also on Windows). */
function npxCommand(): [string, string[]] {
  const bin = path.dirname(process.execPath);
  const candidates = [
    path.join(bin, 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    path.join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
  ];
  const cli = candidates.find((c) => existsSync(c));
  if (cli) return [process.execPath, [cli]];
  return ['npx', []];
}

function run(file: string, args: string[]): number {
  const result = spawnSync(file, args, { stdio: 'inherit', cwd: repoRoot });
  if (result.error) {
    console.error(`[sandbox] cannot start ${file}: ${result.error.message}`);
    return 127;
  }
  return result.status ?? 1;
}

const label = () => `label=devcontainer.local_folder=${repoRoot}`;

function dockerContainers(): string[] {
  const result = spawnSync('docker', ['ps', '-a', '-q', '--filter', label()], {
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0)
    throw new Error('docker is not available. Install Docker Desktop / Docker Engine first.');
  return result.stdout.split(/\s+/).filter(Boolean);
}

function main(argv: string[]): number {
  const [command = 'help', ...rest] = argv;
  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(USAGE);
    return 0;
  }
  const args = devcontainerArgs(command, rest, repoRoot);
  if (args) {
    const [npx, prefix] = npxCommand();
    return run(npx, [...prefix, '--yes', DEVCONTAINER_CLI, ...args]);
  }
  const ids = dockerContainers();
  if (command === 'status') {
    if (!ids.length) {
      console.log('[sandbox] no container — start it with: npm run sandbox -- up');
      return 0;
    }
    return run('docker', [
      'ps',
      '-a',
      '--filter',
      label(),
      '--format',
      'table {{.ID}}\t{{.Status}}\t{{.Image}}',
    ]);
  }
  if (!ids.length) {
    console.log('[sandbox] nothing to remove');
    return 0;
  }
  return run('docker', ['rm', '-f', ...ids]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`[sandbox] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
