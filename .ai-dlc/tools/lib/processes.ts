/**
 * Leftover processes of an agent call (issue #17). Copilot CLI runs in its own process group, which
 * the harness kills when the call ends; a process that left the group (`setsid`, a double fork)
 * is re-parented to PID 1. Such orphans could keep serving a fake app on the Gate 4 port or rewrite
 * files after Gate 1 checked them, so they are killed before the gates run.
 *
 * Linux only (reads /proc); elsewhere nothing is reported. Only processes of the current user that
 * did not exist before the call are considered.
 */
import { readFileSync, readdirSync } from 'node:fs';

export interface ProcessInfo {
  pid: number;
  ppid: number;
  uid: number;
  command: string;
}

function readProcess(pid: number): ProcessInfo | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // pid (comm) state ppid ...  — comm may contain spaces and parentheses
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const uid = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1] ?? -1);
    const command = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim();
    return { pid, ppid: Number(fields[1]), uid, command };
  } catch {
    return undefined; // exited meanwhile
  }
}

/** Every visible process (empty when /proc is not available). */
export function listProcesses(): ProcessInfo[] {
  if (process.platform !== 'linux') return [];
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return [];
  }
  return entries
    .filter((e) => /^\d+$/.test(e))
    .map((e) => readProcess(Number(e)))
    .filter((p): p is ProcessInfo => p !== undefined);
}

export function snapshotPids(): Set<number> {
  return new Set(listProcesses().map((p) => p.pid));
}

/**
 * Processes started since `before` that were orphaned (re-parented to PID 1), with their
 * descendants. Pure function for testing.
 */
export function orphansSince(
  before: ReadonlySet<number>,
  now: readonly ProcessInfo[],
  self: { pid: number; uid: number },
): ProcessInfo[] {
  const fresh = now.filter((p) => !before.has(p.pid) && p.pid !== self.pid && p.uid === self.uid);
  const picked = new Map<number, ProcessInfo>();
  for (const p of fresh) if (p.ppid === 1) picked.set(p.pid, p);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of fresh) {
      if (!picked.has(p.pid) && picked.has(p.ppid)) {
        picked.set(p.pid, p);
        grew = true;
      }
    }
  }
  return [...picked.values()].sort((a, b) => a.pid - b.pid);
}

/** Kills (SIGKILL) the orphans started since `before` and returns them. */
export function killOrphansSince(before: ReadonlySet<number>): ProcessInfo[] {
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
  const orphans = orphansSince(before, listProcesses(), { pid: process.pid, uid });
  for (const p of orphans) {
    try {
      process.kill(p.pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  return orphans;
}
