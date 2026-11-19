/**
 * Sandbox detection and enforcement.
 *
 * The SDK ships a dev container (`.devcontainer/`) as its isolated execution environment. Every
 * `aidlc:*` command checks that it runs inside that sandbox before it touches the repository, starts
 * GitHub Copilot CLI or executes project code (npm scripts, Angular CLI, Playwright). The checks are
 * mechanical and cannot be satisfied by the agent itself:
 *
 * - `AIDLC_SANDBOX` is set by `devcontainer.json` (`containerEnv`) and must equal `sandbox.kind`.
 * - A container runtime marker exists (`/.dockerenv`, `/run/.containerenv`).
 * - The egress firewall marker is written by root (the container entrypoint runs
 *   `/usr/local/bin/aidlc-init-firewall` before dropping to the sandbox user, who has no way to
 *   become root) and is bound to the start time of the container's PID 1, so a marker that
 *   survived a container restart does not count.
 * - A live TCP probe to a host outside the allow-list must be refused.
 * - No host credential bridge is visible (forwarded SSH agent, VS Code git credential helper).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import type { AidlcConfig } from './config.js';

export type SandboxScope =
  /** Starts Copilot CLI or executes project code (gates, npm scripts, Playwright). */
  | 'agent'
  /** Reads inputs and writes harness outputs only. */
  | 'tool';

export type SandboxEnforcement = 'strict' | 'agent' | 'off';

export const SANDBOX_ENV = 'AIDLC_SANDBOX';
export const FIREWALL_MARKER = '/run/aidlc-sandbox/egress-firewall';
const CONTAINER_MARKERS = ['/.dockerenv', '/run/.containerenv'];

export type FirewallState = 'enforced' | 'disabled' | 'stale' | 'missing';
export type EgressProbe = 'blocked' | 'open' | 'skipped';

/** Everything the detection reads from the machine. Injected in tests. */
export interface SandboxProbe {
  env: NodeJS.ProcessEnv;
  exists(file: string): boolean;
  read(file: string): string | null;
  /** Values of a git config key (`git config --get-all`), or null. */
  gitConfig(key: string): string | null;
  /** TCP connect probe. Resolves `open` when the connection is established. */
  connect(host: string, port: number, timeoutMs: number): Promise<EgressProbe>;
}

export interface SandboxStatus {
  /** `AIDLC_SANDBOX` value, or null. */
  declared: string | null;
  container: boolean;
  firewall: FirewallState;
  egress: EgressProbe;
  /** Host credential bridges visible inside the environment. */
  credentialBridges: string[];
  /** Reasons why the environment is not the SDK sandbox at all. Empty = it is. */
  problems: string[];
}

export function defaultProbe(cwd: string = process.cwd()): SandboxProbe {
  return {
    env: process.env,
    exists: (file) => existsSync(file),
    read: (file) => {
      try {
        return readFileSync(file, 'utf8');
      } catch {
        return null;
      }
    },
    gitConfig: (key) => {
      try {
        const out = execFileSync('git', ['config', '--get-all', key], {
          cwd,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        return out === '' ? null : out;
      } catch {
        return null;
      }
    },
    connect: (host, port, timeoutMs) =>
      new Promise((resolve) => {
        const socket = net.connect({ host, port });
        const done = (result: EgressProbe) => {
          socket.destroy();
          resolve(result);
        };
        socket.setTimeout(timeoutMs, () => done('blocked'));
        socket.once('connect', () => done('open'));
        socket.once('error', () => done('blocked'));
      }),
  };
}

/** Start time (clock ticks since boot) of PID 1: changes whenever the container restarts. */
export function pid1StartTime(stat: string | null): string | null {
  if (!stat) return null;
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  // Fields after "pid (comm) " start at field 3 (state); starttime is field 22.
  return fields[22 - 3] ?? null;
}

/** Parses the firewall marker: `<state> <pid1-starttime> <timestamp>`. */
export function firewallState(marker: string | null, pid1Stat: string | null): FirewallState {
  if (marker === null) return 'missing';
  const [state, start] = marker.trim().split(/\s+/);
  const current = pid1StartTime(pid1Stat);
  if (!current || start !== current) return 'stale';
  return state === 'enforced' ? 'enforced' : 'disabled';
}

export interface DetectOptions {
  kind: string;
  /** Host outside the egress allow-list used for the live probe. Empty = no probe. */
  egressProbeHost: string;
  probeTimeoutMs?: number;
}

export async function detectSandbox(
  options: DetectOptions,
  probe: SandboxProbe = defaultProbe(),
): Promise<SandboxStatus> {
  const declared = probe.env[SANDBOX_ENV]?.trim() || null;
  const container = CONTAINER_MARKERS.some((m) => probe.exists(m));
  const firewall = firewallState(probe.read(FIREWALL_MARKER), probe.read('/proc/1/stat'));
  const egress =
    options.egressProbeHost && declared
      ? await probe.connect(options.egressProbeHost, 443, options.probeTimeoutMs ?? 3000)
      : 'skipped';

  const credentialBridges: string[] = [];
  if (probe.env['SSH_AUTH_SOCK']) credentialBridges.push('SSH agent forwarded (SSH_AUTH_SOCK)');
  const helper = probe.gitConfig('credential.helper');
  if (helper && /vscode|remote-containers|devcontainer|\.vscode-server/i.test(helper))
    credentialBridges.push(`git credential helper bridged to the host (${helper.split('\n')[0]})`);
  if (probe.env['VSCODE_GIT_IPC_HANDLE'] || probe.env['GIT_ASKPASS']?.includes('vscode'))
    credentialBridges.push('VS Code git askpass bridge (VSCODE_GIT_IPC_HANDLE / GIT_ASKPASS)');

  const problems: string[] = [];
  if (declared !== options.kind)
    problems.push(
      declared
        ? `${SANDBOX_ENV}="${declared}" but sandbox.kind is "${options.kind}"`
        : `${SANDBOX_ENV} is not set — not running inside the SDK sandbox (.devcontainer)`,
    );
  if (!container) problems.push('no container runtime marker (/.dockerenv, /run/.containerenv)');
  return { declared, container, firewall, egress, credentialBridges, problems };
}

export interface SandboxPolicy {
  enforce: SandboxEnforcement;
  requireEgressFirewall: boolean;
  forbidHostCredentialBridges: boolean;
}

/** Problems that block `scope` under `policy`. Empty = allowed to run. */
export function sandboxViolations(
  status: SandboxStatus,
  policy: SandboxPolicy,
  scope: SandboxScope,
): string[] {
  if (policy.enforce === 'off') return [];
  if (policy.enforce === 'agent' && scope === 'tool') return [];
  const problems = [...status.problems];
  if (problems.length) return problems; // the remaining checks only make sense inside the sandbox
  if (policy.requireEgressFirewall) {
    if (status.firewall !== 'enforced')
      problems.push(
        `egress firewall is ${status.firewall} — restart the container (the entrypoint applies it) and check /run/aidlc-sandbox/firewall.log`,
      );
    if (status.egress === 'open')
      problems.push(
        'egress probe reached a host outside the allow-list — the firewall is not effective',
      );
  }
  if (policy.forbidHostCredentialBridges) problems.push(...status.credentialBridges);
  return problems;
}

export function sandboxPolicy(config: AidlcConfig): SandboxPolicy {
  return {
    enforce: config.sandbox.enforce,
    requireEgressFirewall: config.sandbox.requireEgressFirewall,
    forbidHostCredentialBridges: config.sandbox.forbidHostCredentialBridges,
  };
}

export class SandboxError extends Error {}

/**
 * Throws when `command` may not run here. Call it at the start of every CLI entry point,
 * after loading the configuration and before doing any work.
 */
export async function enforceSandbox(
  config: AidlcConfig,
  command: string,
  scope: SandboxScope,
  probe?: SandboxProbe,
): Promise<SandboxStatus | null> {
  const policy = sandboxPolicy(config);
  if (policy.enforce === 'off' || (policy.enforce === 'agent' && scope === 'tool')) return null;
  const status = await detectSandbox(
    { kind: config.sandbox.kind, egressProbeHost: config.sandbox.egressProbeHost },
    probe,
  );
  const problems = sandboxViolations(status, policy, scope);
  if (problems.length) {
    throw new SandboxError(
      [
        `${command} must run inside the AI-DLC sandbox (sandbox.enforce: ${policy.enforce}).`,
        ...problems.map((p) => `  - ${p}`),
        'Start it with: npm run sandbox -- exec <command>   (or "Reopen in Container" in VS Code).',
        'See docs/sandbox.md.',
      ].join('\n'),
    );
  }
  return status;
}
