/**
 * Post-process guard: the reverse-doc and QCD Copilot calls run after the final gate with the same
 * tool permissions as the loop, so everything they may write is checked mechanically here.
 *
 * Before each call the guard snapshots
 *   - the git-visible working tree as a tree object (temporary index, nothing is committed),
 *   - HEAD,
 *   - the content of every file under `.ai-dlc/outputs/` (git-ignored, so invisible to git) except
 *     the paths the call may write,
 *   - git-ignored dependencies (`node_modules/`) through the dependency guard.
 * After the call every difference outside the allowed paths is a violation and is restored to its
 * state from just before the call (not to the run baseline: the gated implementation stays).
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AidlcPaths } from './config.js';
import { DependencyGuard } from './dependency-guard.js';
import { exec } from './exec.js';
import { Git } from './git.js';
import { GateFailure } from './telemetry.js';

export interface PostProcessScope {
  /** Repository-relative paths (files or directories) the call may create or change. */
  allowed: string[];
  /** Files that may only grow: the old content must stay a prefix (QCD numbers, appended sections). */
  appendOnly?: string[];
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function within(file: string, allowed: readonly string[]): boolean {
  return allowed.some((a) => file === a || file.startsWith(`${a.replace(/\/$/, '')}/`));
}

function listFiles(root: string, dir: string): string[] {
  const abs = path.join(root, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() || e.isSymbolicLink())
    .map((e) => toPosix(path.relative(root, path.join(e.parentPath, e.name))));
}

/** Snapshot of the whole git-visible working tree as a tree object id (uses a temporary index). */
export async function snapshotWorktree(root: string): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), 'aidlc-index-'));
  try {
    const env = { GIT_INDEX_FILE: path.join(dir, 'index') };
    for (const args of [['add', '-A', '--', '.'], ['write-tree']]) {
      const r = await exec(['git', ...args], { cwd: root, env });
      if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.output}`);
      if (args[0] === 'write-tree') return r.output.trim();
    }
    throw new Error('unreachable');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export class PostProcessGuard {
  private tree = '';
  private head = '';
  private outputs = new Map<string, Buffer>();
  private appendOnly = new Map<string, Buffer | undefined>();

  constructor(
    private readonly paths: AidlcPaths,
    private readonly scope: PostProcessScope,
    private readonly dependencies?: DependencyGuard,
  ) {}

  private outputsDir(): string {
    return toPosix(path.relative(this.paths.root, this.paths.outputs.root));
  }

  async capture(): Promise<void> {
    const git = new Git(this.paths.root);
    this.tree = await snapshotWorktree(this.paths.root);
    this.head = await git.head().catch(() => '');
    this.outputs = new Map(
      listFiles(this.paths.root, this.outputsDir())
        .filter((f) => !within(f, this.scope.allowed))
        .map((f) => [f, readFileSync(path.join(this.paths.root, f))]),
    );
    this.appendOnly = new Map(
      (this.scope.appendOnly ?? []).map((f) => {
        const abs = path.join(this.paths.root, f);
        return [f, existsSync(abs) ? readFileSync(abs) : undefined];
      }),
    );
    this.dependencies?.capture();
  }

  /** Reports (and with `revert`, undoes) every change outside the allowed paths. */
  async verify(revert: boolean): Promise<GateFailure[]> {
    const root = this.paths.root;
    const git = new Git(root);
    const failures: GateFailure[] = [];
    const note = revert ? ' (restored)' : '';

    const head = await git.head().catch(() => '');
    if (this.head && head !== this.head) {
      if (revert) await git.run(['reset', '-q', '--soft', this.head]);
      failures.push({
        where: 'HEAD',
        message: `Post-process moved HEAD to ${head.slice(0, 12)}; the harness owns version control.${note}`,
      });
    }

    const after = await snapshotWorktree(root);
    if (after !== this.tree) {
      const diff = await git.run(['diff', '--name-only', '--no-renames', this.tree, after, '--']);
      for (const file of diff.split(/\r?\n/).filter(Boolean)) {
        if (within(file, this.scope.allowed)) continue;
        if (revert) {
          const existed = await exec(['git', 'cat-file', '-e', `${this.tree}:${file}`], {
            cwd: root,
          });
          if (existed.exitCode === 0) {
            await git.run(['restore', `--source=${this.tree}`, '--worktree', '--', file]);
          } else {
            rmSync(path.join(root, file), { force: true });
          }
        }
        failures.push({
          where: file,
          message: `Post-process may only write ${this.scope.allowed.join(', ')}.${note}`,
        });
      }
    }

    const now = new Set(
      listFiles(root, this.outputsDir()).filter((f) => !within(f, this.scope.allowed)),
    );
    const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
    for (const file of new Set([...this.outputs.keys(), ...now])) {
      const before = this.outputs.get(file);
      const abs = path.join(root, file);
      const current = now.has(file) ? readFileSync(abs) : undefined;
      if (before && current && sha(before) === sha(current)) continue;
      if (revert) {
        if (before) {
          mkdirSync(path.dirname(abs), { recursive: true });
          writeFileSync(abs, before);
        } else rmSync(abs, { force: true });
      }
      failures.push({
        where: file,
        message: `Harness output changed by the post-process (reports, telemetry and generated tests are read-only here).${note}`,
      });
    }

    for (const [file, before] of this.appendOnly) {
      const abs = path.join(root, file);
      const current = existsSync(abs) ? readFileSync(abs) : undefined;
      const old = before?.toString('utf8').trimEnd() ?? '';
      if (current && current.toString('utf8').startsWith(old)) continue;
      if (revert) {
        if (before) writeFileSync(abs, before);
        else rmSync(abs, { force: true });
      }
      failures.push({
        where: file,
        message: `Only appending is allowed here; existing content (calculated numbers) was changed or removed.${note}`,
      });
    }

    if (this.dependencies) {
      const deps = await this.dependencies.check(revert);
      for (const c of deps.changed) {
        failures.push({
          where: c.path,
          message: `${c.files} file(s) changed in a git-ignored dependency directory.${
            deps.restored
              ? ` (${deps.restored.ok ? deps.restored.detail : `NOT restored: ${deps.restored.detail}`})`
              : ''
          }`,
        });
      }
    }
    return failures;
  }
}
