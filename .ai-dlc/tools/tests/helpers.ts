import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root of this SDK. */
export const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** Creates a throw-away git repository. Call the returned cleanup in afterEach. */
export function tempRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'aidlc-test-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'aidlc test');
  git(dir, 'config', 'core.autocrlf', 'false');
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function write(dir: string, file: string, content: string): void {
  const abs = path.join(dir, file);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

export function commitAll(dir: string, message = 'init'): string {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD').trim();
}

/** Copies the harness (config, inputs, references, skills) of this repository into `dir`. */
export function copyHarness(dir: string): void {
  for (const sub of ['.ai-dlc/config', '.ai-dlc/inputs', '.ai-dlc/references', '.github/skills']) {
    cpSync(path.join(REPO_ROOT, sub), path.join(dir, sub), { recursive: true });
  }
  writeFileSync(path.join(dir, '.gitignore'), '/.ai-dlc/outputs/\n', 'utf8');
}
