/**
 * Repository guard: protects the git metadata (`.git/`) that the boundary guard itself relies on
 * (issue #13). The agent can write `.git/` through `node` / `npm` / `npx`, and the deny rules for
 * `git commit` / `git reset` can be bypassed the same way (issue #15). Without this guard it could
 *   - hide changes from the boundary guard (`git replace`, `.git/info/exclude`, `.git/info/attributes`,
 *     filter / diff drivers or `core.fsmonitor` in `.git/config`),
 *   - move HEAD, branches or other refs (commit, reset, stash, tags),
 *   - plant hooks or config that run on the host the next time a maintainer uses git there.
 *
 * Before the first agent call the orchestrator captures, in memory where the agent cannot reach it,
 *   - the content and mode of `config`, `config.worktree`, `hooks/**`, `info/**` and `objects/info/**`,
 *   - HEAD (symbolic or detached) and every ref (`git for-each-ref`, which includes `refs/replace/`
 *     and `refs/stash`).
 * Gate 1 compares the repository with the capture before the boundary check and restores it, so the
 * boundary check always reads a trusted `.git/`.
 */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { Git } from './git.js';

/** Paths below the git directory whose content is captured (files or directories). */
export const GUARDED_GIT_PATHS = [
  'config',
  'config.worktree',
  'hooks',
  'info',
  // Not the whole objects/info/: gc writes commit-graph and packs there.
  'objects/info/alternates',
  'objects/info/http-alternates',
  'commondir',
] as const;

interface Entry {
  kind: 'file' | 'dir' | 'link';
  mode: number;
  content?: Buffer;
  target?: string;
}

interface RefState {
  /** `refs/heads/main` when HEAD is symbolic, otherwise undefined. */
  symbolicHead?: string;
  head: string;
  refs: Map<string, string>;
}

export interface RepositoryViolation {
  where: string;
  rule: 'git-metadata-changed' | 'git-ref-moved' | 'git-head-moved';
  message: string;
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function scan(root: string, rel: string, out: Map<string, Entry>): void {
  const abs = path.join(root, rel);
  if (!existsSync(abs) && !isLink(abs)) return;
  const s = lstatSync(abs);
  if (s.isSymbolicLink()) {
    out.set(rel, { kind: 'link', mode: s.mode, target: readlinkSync(abs) });
  } else if (s.isDirectory()) {
    out.set(rel, { kind: 'dir', mode: s.mode });
    for (const name of readdirSync(abs)) scan(root, path.posix.join(rel, name), out);
  } else {
    out.set(rel, { kind: 'file', mode: s.mode, content: readFileSync(abs) });
  }
}

function isLink(abs: string): boolean {
  try {
    return lstatSync(abs).isSymbolicLink();
  } catch {
    return false;
  }
}

function same(a: Entry | undefined, b: Entry | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind || a.mode !== b.mode) return false;
  if (a.kind === 'link') return a.target === b.target;
  if (a.kind === 'file') return sha(a.content!) === sha(b.content!);
  return true;
}

export class RepositoryGuard {
  private gitDir = '';
  private files = new Map<string, Entry>();
  private refs: RefState = { head: '', refs: new Map() };

  constructor(private readonly root: string) {}

  private git(): Git {
    return new Git(this.root);
  }

  private async readRefs(): Promise<RefState> {
    const git = this.git();
    const symbolic = (await git.run(['symbolic-ref', '-q', 'HEAD'], true)).trim();
    const head = (await git.run(['rev-parse', '-q', '--verify', 'HEAD'], true)).trim();
    const refs = new Map<string, string>();
    const out = await git.run(['for-each-ref', '--format=%(refname) %(objectname)']);
    for (const line of out.split(/\r?\n/)) {
      const [name, oid] = line.trim().split(' ');
      if (name && oid) refs.set(name, oid);
    }
    return { ...(symbolic.startsWith('refs/') ? { symbolicHead: symbolic } : {}), head, refs };
  }

  private scanFiles(): Map<string, Entry> {
    const out = new Map<string, Entry>();
    for (const p of GUARDED_GIT_PATHS) scan(this.gitDir, p, out);
    return out;
  }

  /** Records the trusted state. Call before the agent runs. */
  async capture(): Promise<void> {
    this.gitDir = (await this.git().run(['rev-parse', '--absolute-git-dir'])).trim();
    this.files = this.scanFiles();
    this.refs = await this.readRefs();
  }

  /** Reports (and with `restore`, undoes) every change since the capture. */
  async check(restore: boolean): Promise<RepositoryViolation[]> {
    if (!this.gitDir) throw new Error('RepositoryGuard.check() called before capture()');
    const note = restore ? ' (restored)' : '';
    const violations: RepositoryViolation[] = [];
    const now = this.scanFiles();
    const changed = [...new Set([...this.files.keys(), ...now.keys()])]
      .filter((p) => !same(this.files.get(p), now.get(p)))
      .sort();
    for (const rel of changed) {
      violations.push({
        where: `.git/${rel}`,
        rule: 'git-metadata-changed',
        message: `Git metadata changed (${this.files.has(rel) ? (now.has(rel) ? 'modified' : 'deleted') : 'added'}). The harness owns .git/: hooks, config and info files must not be touched.${note}`,
      });
    }
    if (restore) this.restoreFiles(now, changed);

    const current = await this.readRefs();
    const git = this.git();
    if (current.symbolicHead !== this.refs.symbolicHead || current.head !== this.refs.head) {
      violations.push({
        where: 'HEAD',
        rule: 'git-head-moved',
        message: `HEAD ${current.symbolicHead === this.refs.symbolicHead ? `moved to ${current.head.slice(0, 12) || '(none)'}` : `switched to ${current.symbolicHead ?? current.head.slice(0, 12)}`}; the harness owns version control (no checkout, switch or commit).${note}`,
      });
      if (restore) {
        if (this.refs.symbolicHead) await git.run(['symbolic-ref', 'HEAD', this.refs.symbolicHead]);
        else if (this.refs.head)
          await git.run(['update-ref', '--no-deref', 'HEAD', this.refs.head]);
      }
    }
    const names = [...new Set([...this.refs.refs.keys(), ...current.refs.keys()])].sort();
    for (const name of names) {
      const before = this.refs.refs.get(name);
      const after = current.refs.get(name);
      if (before === after) continue;
      violations.push({
        where: name,
        rule: 'git-ref-moved',
        message: `${before ? (after ? `Ref moved to ${after.slice(0, 12)}` : 'Ref deleted') : 'Ref created'}; the harness owns version control (no commit, reset, stash, tag or replace).${note}`,
      });
      if (restore) {
        if (before) await git.run(['update-ref', '--no-deref', name, before]);
        else await git.run(['update-ref', '--no-deref', '-d', name]);
      }
    }
    // Restoring refs only moves pointers: the working tree is still checked by the boundary guard.
    return violations;
  }

  private restoreFiles(now: Map<string, Entry>, changed: string[]): void {
    // Remove what was added (deepest first), then write back what was there.
    for (const rel of [...changed].reverse()) {
      if (!this.files.has(rel) && now.has(rel)) {
        rmSync(path.join(this.gitDir, rel), { recursive: true, force: true });
      }
    }
    for (const rel of changed) {
      const entry = this.files.get(rel);
      if (!entry) continue;
      const abs = path.join(this.gitDir, rel);
      const present = now.get(rel);
      if (present && present.kind !== entry.kind) rmSync(abs, { recursive: true, force: true });
      if (entry.kind === 'dir') {
        mkdirSync(abs, { recursive: true });
      } else if (entry.kind === 'link') {
        rmSync(abs, { force: true });
        mkdirSync(path.dirname(abs), { recursive: true });
        symlinkSync(entry.target!, abs);
        continue;
      } else {
        mkdirSync(path.dirname(abs), { recursive: true });
        if (isLink(abs)) rmSync(abs, { force: true });
        writeFileSync(abs, entry.content!);
      }
      chmodSync(abs, entry.mode & 0o7777);
    }
  }
}
