import { mkdtempSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import path from 'node:path';
import { exec } from './exec.js';

/**
 * Environment for every git call of the harness. The agent can write `.git/` and the home directory,
 * so nothing git would read from there may influence what the guards see (issue #13):
 *   - replace refs (`git replace`) and grafts would swap the baseline commit for another one,
 *   - global / system config could define external diff drivers, filters or excludes.
 * `.git/config`, `.git/info/` and `.git/hooks/` are fingerprinted by the repository guard and restored
 * before the boundary check, so repository-level config is the trusted state from the run start.
 */
export const HARDENED_GIT_ENV: Readonly<Record<string, string>> = {
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: devNull,
  GIT_ATTR_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
};

/** `-c` options that override anything the repository config could set (command line wins). */
export function hardenedGitConfig(cwd: string): string[] {
  return [
    ['core.quotepath', 'off'],
    ['core.hooksPath', devNull],
    ['core.fsmonitor', 'false'],
    ['core.untrackedCache', 'false'],
    ['core.attributesFile', devNull],
    ['core.excludesFile', devNull],
    ['core.sparseCheckout', 'false'],
    // No background maintenance between the snapshots of the guards.
    ['gc.auto', '0'],
    ['maintenance.auto', 'false'],
    // The global config (which normally holds it) is not read; trust only this repository.
    ['safe.directory', path.resolve(cwd)],
  ].flatMap(([k, v]) => ['-c', `${k}=${v}`]);
}

/**
 * Options for `git diff` that keep external drivers and textconv out of the comparison. Binary
 * detection (numstat `-`) cannot be switched off; callers must fail closed on missing line counts.
 */
const DIFF_FLAGS = ['--no-ext-diff', '--no-textconv', '--no-color'];

/** Change status of a path relative to the baseline. */
export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface FileChange {
  /** Repository-relative POSIX path (the new path for renames). */
  path: string;
  status: ChangeStatus;
  /** Original path of a rename. */
  from?: string;
  /** Added / deleted line counts (undefined for binary files). */
  added?: number;
  deleted?: number;
}

export class Git {
  constructor(private readonly cwd: string) {}

  async run(
    args: string[],
    allowFailure = false,
    env?: Record<string, string>,
    input?: string,
  ): Promise<string> {
    const result = await exec(['git', ...hardenedGitConfig(this.cwd), ...args], {
      cwd: this.cwd,
      env: { ...HARDENED_GIT_ENV, ...env },
      ...(input !== undefined ? { input } : {}),
    });
    if (result.exitCode !== 0 && !allowFailure) {
      throw new Error(`git ${args.join(' ')} failed (${result.exitCode}):\n${result.output}`);
    }
    return result.output;
  }

  async isRepository(): Promise<boolean> {
    const out = await this.run(['rev-parse', '--is-inside-work-tree'], true);
    return out.trim() === 'true';
  }

  async head(): Promise<string> {
    return (await this.run(['rev-parse', 'HEAD'])).trim();
  }

  async resolve(ref: string): Promise<string> {
    return (await this.run(['rev-parse', '--verify', `${ref}^{commit}`])).trim();
  }

  /** `git status --porcelain` lines (empty when the tree is clean). */
  async statusLines(): Promise<string[]> {
    const out = await this.run(['status', '--porcelain', '--untracked-files=all']);
    return out.split(/\r?\n/).filter((l) => l.trim().length > 0);
  }

  /**
   * Snapshot of the whole git-visible working tree as a tree object id. A temporary index is used, so
   * nothing is committed and index flags the agent may have set on the real index
   * (`--assume-unchanged`, `--skip-worktree`) cannot hide a change.
   */
  async snapshotTree(): Promise<string> {
    return this.withTemporaryIndex(async (env) => {
      await this.run(['add', '-A', '--', '.'], false, env);
      return (await this.run(['write-tree'], false, env)).trim();
    });
  }

  private async withTemporaryIndex<T>(fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
    const dir = mkdtempSync(path.join(tmpdir(), 'aidlc-index-'));
    try {
      return await fn({ GIT_INDEX_FILE: path.join(dir, 'index') });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /**
   * Every change in the working tree relative to `baseline`
   * (committed after the baseline, staged, unstaged and untracked).
   *
   * The working tree is snapshotted with a temporary index and compared tree-to-tree with the
   * baseline, so the result depends neither on the real index nor on `.git/info/exclude`. Files that
   * are hidden by a `.gitignore` that is new or changed since the baseline are reported as well.
   */
  async changesSince(baseline: string): Promise<FileChange[]> {
    return (await this.snapshotChanges(baseline)).changes;
  }

  /**
   * Same as {@link changesSince}, plus the resolved baseline commit and the tree object of the
   * working-tree snapshot that was compared, so that callers can read both versions of a file.
   */
  async snapshotChanges(
    baseline: string,
  ): Promise<{ base: string; tree: string; changes: FileChange[] }> {
    const base = await this.resolve(baseline);
    // One temporary index for the snapshot and the ignored-file listing (never the real index).
    const { tree, hidden, excluded } = await this.withTemporaryIndex(async (env) => {
      await this.run(['add', '-A', '--', '.'], false, env);
      const id = (await this.run(['write-tree'], false, env)).trim();
      // `add -A` honours .git/info/exclude; whatever it skipped for that reason alone is still a change.
      const excluded = (
        await this.run(['ls-files', '--others', '--exclude-per-directory=.gitignore'], false, env)
      )
        .split(/\r?\n/)
        .filter(Boolean);
      return { tree: id, hidden: await this.ignoredWithSource(env), excluded };
    });
    const changes = new Map<string, FileChange>();
    const nameStatus = await this.run(['diff', ...DIFF_FLAGS, '--name-status', '-M', base, tree]);
    for (const line of nameStatus.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [code = '', a = '', b] = line.split('\t');
      if (code.startsWith('R') && b) {
        changes.set(b, { path: b, status: 'renamed', from: a });
      } else if (code === 'A') {
        changes.set(a, { path: a, status: 'added' });
      } else if (code === 'D') {
        changes.set(a, { path: a, status: 'deleted' });
      } else {
        changes.set(a, { path: a, status: 'modified' });
      }
    }
    const numstat = await this.run(['diff', ...DIFF_FLAGS, '--numstat', '-M', base, tree]);
    for (const line of numstat.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [added = '-', deleted = '-', ...rest] = line.split('\t');
      const file = normalizeRenamePath(rest.join('\t'));
      const entry = changes.get(file);
      if (entry && added !== '-') {
        entry.added = Number(added);
        entry.deleted = Number(deleted);
      }
    }
    const suspicious = [...excluded];
    const baselineRules = new Map<string, Set<string> | undefined>();
    for (const h of hidden) {
      if (!baselineRules.has(h.source)) {
        const shown = await exec(
          ['git', ...hardenedGitConfig(this.cwd), 'show', `${base}:${h.source}`],
          { cwd: this.cwd, env: { ...HARDENED_GIT_ENV } },
        );
        baselineRules.set(
          h.source,
          shown.exitCode === 0
            ? new Set(shown.output.split(/\r?\n/).map((l) => l.trim()))
            : undefined,
        );
      }
      // Hidden by a rule that the baseline did not have (new .gitignore or a newly added pattern).
      if (!baselineRules.get(h.source)?.has(h.pattern.trim())) suspicious.push(h.path);
    }
    for (const file of suspicious) {
      const known = changes.get(file);
      if (known?.status === 'deleted') {
        // Still on disk, only hidden from git: its content is unknown, so it counts as modified.
        changes.set(file, { path: file, status: 'modified' });
      } else if (!known) {
        changes.set(file, { path: file, status: 'added' });
      }
    }
    return {
      base,
      tree,
      changes: [...changes.values()].sort((x, y) => x.path.localeCompare(y.path)),
    };
  }

  /** Content of `file` in a commit or tree (`undefined` when it does not exist there). */
  async readBlob(treeish: string, file: string): Promise<string | undefined> {
    const shown = await exec(
      ['git', ...hardenedGitConfig(this.cwd), 'cat-file', 'blob', `${treeish}:${file}`],
      { cwd: this.cwd, env: { ...HARDENED_GIT_ENV } },
    );
    return shown.exitCode === 0 ? shown.output : undefined;
  }

  /**
   * Ignored, untracked paths with the `.gitignore` rule that hides them. Directories that are ignored
   * as a whole are reported once; a directory that only looks ignored because a nested `.gitignore`
   * hides all of its content is expanded.
   */
  private async ignoredWithSource(
    env: Record<string, string>,
    pathspec: string[] = [],
  ): Promise<{ path: string; source: string; pattern: string }[]> {
    const listArgs = ['ls-files', '--others', '--ignored', '--exclude-per-directory=.gitignore'];
    const ignored = (
      await this.run(
        [...listArgs, ...(pathspec.length ? [] : ['--directory', '--no-empty-directory'])].concat(
          pathspec.length ? ['--', ...pathspec] : [],
        ),
        false,
        env,
      )
    )
      .split(/\r?\n/)
      .filter(Boolean);
    if (!ignored.length) return [];
    const out = await this.run(
      ['check-ignore', '--no-index', '--verbose', '--non-matching', '--stdin'],
      true,
      env,
      `${ignored.join('\n')}\n`,
    );
    const result: { path: string; source: string; pattern: string }[] = [];
    const expand: string[] = [];
    for (const line of out.split(/\r?\n/)) {
      // <source>:<line number>:<pattern>\t<path>   (non-matching: "::\t<path>")
      const tab = line.lastIndexOf('\t');
      if (tab < 0) continue;
      const file = line.slice(tab + 1);
      const m = /^(.*?):(\d*):(.*)$/.exec(line.slice(0, tab));
      const [, source = '', , pattern = ''] = m ?? [];
      if (!source) {
        if (file.endsWith('/') && !pathspec.length) expand.push(file);
      } else if (/(^|\/)\.gitignore$/.test(source)) {
        result.push({ path: file.replace(/\/$/, ''), source, pattern });
      }
    }
    if (expand.length) result.push(...(await this.ignoredWithSource(env, expand)));
    return result;
  }

  /** Restores `file` to its content at `baseline` (or deletes it when it did not exist there). */
  async restore(file: string, baseline: string): Promise<void> {
    // Index flags set by the agent would make checkout skip the file.
    await this.run(
      ['update-index', '--no-assume-unchanged', '--no-skip-worktree', '--', file],
      true,
    );
    const probe = await exec(
      ['git', ...hardenedGitConfig(this.cwd), 'cat-file', '-e', `${baseline}:${file}`],
      { cwd: this.cwd, env: { ...HARDENED_GIT_ENV } },
    );
    if (probe.exitCode === 0) {
      await this.run(['checkout', baseline, '--', file]);
      await this.run(['reset', '-q', '--', file], true);
    } else {
      await this.run(['rm', '-r', '-q', '-f', '--cached', '--ignore-unmatch', '--', file], true);
      await rm(path.join(this.cwd, file), { recursive: true, force: true });
    }
  }
}

/** Converts numstat rename notation (`a/{b => c}/d` or `a => b`) to the new path. */
export function normalizeRenamePath(raw: string): string {
  const braces = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(raw);
  if (braces) {
    const [, pre = '', , to = '', post = ''] = braces;
    return `${pre}${to}${post}`.replace(/\/\//g, '/');
  }
  const arrow = raw.split(' => ');
  return arrow.length === 2 ? (arrow[1] ?? raw) : raw;
}
