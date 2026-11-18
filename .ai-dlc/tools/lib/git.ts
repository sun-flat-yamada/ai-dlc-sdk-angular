import { rm } from 'node:fs/promises';
import path from 'node:path';
import { exec } from './exec.js';

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

  async run(args: string[], allowFailure = false): Promise<string> {
    const result = await exec(['git', '-c', 'core.quotepath=off', ...args], { cwd: this.cwd });
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
   * Every change in the working tree relative to `baseline`
   * (committed after the baseline, staged, unstaged and untracked).
   */
  async changesSince(baseline: string): Promise<FileChange[]> {
    const changes = new Map<string, FileChange>();
    const nameStatus = await this.run(['diff', '--name-status', '-M', baseline, '--']);
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
    const numstat = await this.run(['diff', '--numstat', '-M', baseline, '--']);
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
    const untracked = await this.run(['ls-files', '--others', '--exclude-standard']);
    for (const file of untracked.split(/\r?\n/)) {
      if (file.trim() && !changes.has(file)) {
        changes.set(file, { path: file, status: 'added' });
      }
    }
    return [...changes.values()].sort((x, y) => x.path.localeCompare(y.path));
  }

  /** Restores `file` to its content at `baseline` (or deletes it when it did not exist there). */
  async restore(file: string, baseline: string): Promise<void> {
    const probe = await exec(['git', 'cat-file', '-e', `${baseline}:${file}`], { cwd: this.cwd });
    if (probe.exitCode === 0) {
      await this.run(['checkout', baseline, '--', file]);
      await this.run(['reset', '-q', '--', file], true);
    } else {
      await this.run(['rm', '-q', '-f', '--cached', '--ignore-unmatch', '--', file], true);
      await rm(path.join(this.cwd, file), { force: true });
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
