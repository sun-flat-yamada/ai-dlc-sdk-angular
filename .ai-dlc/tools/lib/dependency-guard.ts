/**
 * Dependency guard: protects git-ignored directories (by default `node_modules/`) that the boundary
 * guard cannot see, because `git diff` and `git ls-files --exclude-standard` skip ignored paths.
 *
 * Before the first agent call the orchestrator fingerprints every entry under the guarded directories
 * (path, type, mode, size, inode, mtime and ctime with nanosecond precision) and keeps the result in
 * memory, where the agent cannot reach it. Any write changes the ctime, which user space cannot set
 * back, so a rewritten test runner or coverage reporter is detected even when its size and mtime are
 * restored. Gate 1 compares the tree with the fingerprint; on a violation the directories are rebuilt
 * from the immutable `package-lock.json` (`npm ci`) and fingerprinted again.
 *
 * The guard also deletes build caches (`.angular/cache`) before the gates, so no gate result is built
 * from state the agent could have written.
 */
import { existsSync, lstatSync, readdirSync, readlinkSync, rmSync } from 'node:fs';
import path from 'node:path';
import { AidlcConfig } from './config.js';
import { exec, stripAnsi, tail } from './exec.js';

export type Fingerprint = Map<string, string>;

export type DependencyGuardConfig = AidlcConfig['loop']['dependencyGuard'];

function entryKey(abs: string): string {
  const s = lstatSync(abs, { bigint: true });
  const link = s.isSymbolicLink() ? `>${readlinkSync(abs)}` : '';
  return `${s.mode}:${s.size}:${s.ino}:${s.mtimeNs}:${s.ctimeNs}${link}`;
}

/** Fingerprints `dir` (repository-relative) recursively. A missing directory yields an empty map. */
export function fingerprintTree(root: string, dir: string): Fingerprint {
  const result: Fingerprint = new Map();
  const top = path.join(root, dir);
  if (!existsSync(top)) return result;
  result.set(dir, entryKey(top));
  const walk = (abs: string) => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const child = path.join(abs, e.name);
      result.set(path.relative(root, child).split(path.sep).join('/'), entryKey(child));
      if (e.isDirectory()) walk(child);
    }
  };
  walk(top);
  return result;
}

/** Paths that were added, removed or changed between two fingerprints (sorted). */
export function diffFingerprints(before: Fingerprint, after: Fingerprint): string[] {
  const changed = new Set<string>();
  for (const [p, key] of before) if (after.get(p) !== key) changed.add(p);
  for (const p of after.keys()) if (!before.has(p)) changed.add(p);
  return [...changed].sort();
}

/** Groups `node_modules/@scope/pkg/lib/x.js` into `node_modules/@scope/pkg`. */
export function packageOf(file: string, guarded: readonly string[]): string {
  const base = guarded.find((g) => file === g || file.startsWith(`${g}/`));
  if (!base || file === base) return file;
  const rest = file.slice(base.length + 1).split('/');
  const depth = rest[0]?.startsWith('@') ? 2 : 1;
  return [base, ...rest.slice(0, depth)].join('/');
}

export interface DependencyCheck {
  /** Changed packages (or top-level entries) under the guarded directories. */
  changed: { path: string; files: number }[];
  restored?: { ok: boolean; detail: string };
}

export class DependencyGuard {
  private snapshot = new Map<string, Fingerprint>();

  constructor(
    private readonly root: string,
    readonly config: DependencyGuardConfig,
  ) {}

  static fromConfig(root: string, config: AidlcConfig): DependencyGuard | undefined {
    const cfg = config.loop.dependencyGuard;
    return cfg.enabled ? new DependencyGuard(root, cfg) : undefined;
  }

  /** Records the trusted state. Call before the agent runs and after every restore. */
  capture(): void {
    this.snapshot = new Map(this.config.paths.map((d) => [d, fingerprintTree(this.root, d)]));
  }

  /** Changed paths since the last capture. */
  changedPaths(): string[] {
    return this.config.paths.flatMap((d) =>
      diffFingerprints(this.snapshot.get(d) ?? new Map(), fingerprintTree(this.root, d)),
    );
  }

  /** Compares with the snapshot and, when asked, rebuilds the directories and captures again. */
  async check(restore: boolean): Promise<DependencyCheck> {
    const files = this.changedPaths();
    const counts = new Map<string, number>();
    for (const f of files) {
      const pkg = packageOf(f, this.config.paths);
      counts.set(pkg, (counts.get(pkg) ?? 0) + 1);
    }
    const changed = [...counts].map(([p, n]) => ({ path: p, files: n }));
    if (!changed.length || !restore) return { changed };
    if (!this.config.restoreCommand.length) {
      return { changed, restored: { ok: false, detail: 'no restoreCommand configured' } };
    }
    const r = await exec(this.config.restoreCommand, {
      cwd: this.root,
      timeoutMs: this.config.restoreTimeoutMinutes * 60_000,
    });
    if (r.exitCode !== 0) {
      return {
        changed,
        restored: {
          ok: false,
          detail: `\`${this.config.restoreCommand.join(' ')}\` failed (exit ${r.exitCode}): ${tail(stripAnsi(r.output), 5)}`,
        },
      };
    }
    this.capture();
    return {
      changed,
      restored: { ok: true, detail: `rebuilt with \`${this.config.restoreCommand.join(' ')}\`` },
    };
  }

  /** Deletes the build caches so that the gates never reuse state written by the agent. */
  clearCaches(): void {
    for (const dir of this.config.clearBeforeGates) {
      rmSync(path.join(this.root, dir), { recursive: true, force: true });
    }
  }
}
