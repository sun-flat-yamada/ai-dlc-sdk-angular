import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { devcontainerArgs } from '../../../scripts/sandbox.js';
import { BoundaryClassifier, loadBoundaryPolicy } from '../lib/boundary.js';
import { loadConfig, parseConfig, resolvePaths } from '../lib/config.js';
import {
  FIREWALL_MARKER,
  SandboxError,
  SandboxProbe,
  SandboxStatus,
  detectSandbox,
  enforceSandbox,
  firewallState,
  pid1StartTime,
  sandboxViolations,
} from '../lib/sandbox.js';
import { sandboxChecks } from '../orchestrator.js';
import { REPO_ROOT } from './helpers.js';

const PID1_STAT = '1 (docker-init) S 0 1 1 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 93169 1 2 3';

interface FakeOptions {
  env?: Record<string, string>;
  files?: Record<string, string>;
  gitHelper?: string;
  egress?: 'open' | 'blocked';
}

function fakeProbe(o: FakeOptions = {}): SandboxProbe {
  const files: Record<string, string> = { '/proc/1/stat': PID1_STAT, ...o.files };
  return {
    env: o.env ?? {},
    exists: (f) => f in files,
    read: (f) => files[f] ?? null,
    gitConfig: (key) => (key === 'credential.helper' ? (o.gitHelper ?? null) : null),
    connect: () => Promise.resolve(o.egress ?? 'blocked'),
  };
}

/** A healthy sandbox: env marker, container marker, fresh firewall marker, egress blocked. */
function insideProbe(o: FakeOptions = {}): SandboxProbe {
  return fakeProbe({
    ...o,
    env: { AIDLC_SANDBOX: 'devcontainer', ...o.env },
    files: {
      '/.dockerenv': '',
      [FIREWALL_MARKER]: 'enforced 93169 2026-11-18T00:00:00Z\n',
      ...o.files,
    },
  });
}

const detect = (probe: SandboxProbe) =>
  detectSandbox({ kind: 'devcontainer', egressProbeHost: 'example.com' }, probe);

const strict = {
  enforce: 'strict',
  requireEgressFirewall: true,
  forbidHostCredentialBridges: true,
} as const;

describe('firewall marker', () => {
  it('reads the PID 1 start time from /proc/1/stat', () => {
    expect(pid1StartTime(PID1_STAT)).toBe('93169');
    expect(pid1StartTime('1 (a b) c) S 0 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 42 1')).toBe('42');
    expect(pid1StartTime(null)).toBeNull();
  });

  it('accepts only a marker of the current container start', () => {
    expect(firewallState('enforced 93169 t', PID1_STAT)).toBe('enforced');
    expect(firewallState('disabled 93169 t', PID1_STAT)).toBe('disabled');
    expect(firewallState('failed 93169 t', PID1_STAT)).toBe('disabled');
    expect(firewallState('enforced 11111 t', PID1_STAT)).toBe('stale');
    expect(firewallState(null, PID1_STAT)).toBe('missing');
  });
});

describe('detectSandbox / sandboxViolations', () => {
  it('passes inside a healthy sandbox', async () => {
    const status = await detect(insideProbe());
    expect(status).toMatchObject({
      declared: 'devcontainer',
      container: true,
      firewall: 'enforced',
      egress: 'blocked',
      credentialBridges: [],
      problems: [],
    });
    expect(sandboxViolations(status, strict, 'agent')).toEqual([]);
  });

  it('rejects the host (no AIDLC_SANDBOX, no container) without probing egress', async () => {
    let probed = false;
    const probe: SandboxProbe = {
      ...fakeProbe(),
      connect: () => {
        probed = true;
        return Promise.resolve('open');
      },
    };
    const status = await detect(probe);
    expect(probed).toBe(false);
    expect(status.egress).toBe('skipped');
    const v = sandboxViolations(status, strict, 'tool').join('\n');
    expect(v).toMatch(/AIDLC_SANDBOX is not set/);
    expect(v).toMatch(/container runtime marker/);
  });

  it('does not trust a self-declared AIDLC_SANDBOX outside a container', async () => {
    const status = await detect(fakeProbe({ env: { AIDLC_SANDBOX: 'devcontainer' } }));
    expect(sandboxViolations(status, strict, 'agent')).toEqual([
      'no container runtime marker (/.dockerenv, /run/.containerenv)',
    ]);
  });

  it('requires an effective egress firewall', async () => {
    const stale = await detect(insideProbe({ files: { [FIREWALL_MARKER]: 'enforced 1 t' } }));
    expect(sandboxViolations(stale, strict, 'agent')[0]).toMatch(/egress firewall is stale/);
    const open = await detect(insideProbe({ egress: 'open' }));
    expect(sandboxViolations(open, strict, 'agent')[0]).toMatch(/not effective/);
    expect(sandboxViolations(open, { ...strict, requireEgressFirewall: false }, 'agent')).toEqual(
      [],
    );
  });

  it('detects host credential bridges', async () => {
    const status = await detect(
      insideProbe({
        env: { SSH_AUTH_SOCK: '/tmp/vscode-ssh-auth.sock', VSCODE_GIT_IPC_HANDLE: '/tmp/x' },
        gitHelper:
          '!f() { /tmp/.vscode-server/bin/x/node /tmp/vscode-remote-containers.js git-credential-helper $*; }; f',
      }),
    );
    expect(status.credentialBridges).toHaveLength(3);
    expect(sandboxViolations(status, strict, 'agent')).toHaveLength(3);
    expect(
      sandboxViolations(status, { ...strict, forbidHostCredentialBridges: false }, 'agent'),
    ).toEqual([]);
  });

  it('applies the enforcement level to the command scope', async () => {
    const host = await detect(fakeProbe());
    expect(sandboxViolations(host, { ...strict, enforce: 'off' }, 'agent')).toEqual([]);
    expect(sandboxViolations(host, { ...strict, enforce: 'agent' }, 'tool')).toEqual([]);
    expect(sandboxViolations(host, { ...strict, enforce: 'agent' }, 'agent')).not.toEqual([]);
  });
});

describe('enforceSandbox', () => {
  const config = loadConfig(resolvePaths(REPO_ROOT).config);

  it('is strict in the shipped configuration', () => {
    expect(config.sandbox).toEqual({
      enforce: 'strict',
      kind: 'devcontainer',
      requireEgressFirewall: true,
      forbidHostCredentialBridges: true,
      egressProbeHost: 'example.com',
    });
  });

  it('defaults to strict when the section is missing', () => {
    const raw = parse(readFileSync(resolvePaths(REPO_ROOT).config, 'utf8')) as Record<
      string,
      unknown
    >;
    delete raw['sandbox'];
    expect(parseConfig(JSON.stringify(raw)).sandbox.enforce).toBe('strict');
  });

  it('throws a SandboxError with guidance on the host', async () => {
    const run = () => enforceSandbox(config, 'aidlc:gate', 'agent', fakeProbe());
    await expect(run()).rejects.toThrow(SandboxError);
    await expect(run()).rejects.toThrow(/npm run sandbox -- exec/);
  });

  it('returns the status inside the sandbox and null when disabled', async () => {
    const status = (await enforceSandbox(
      config,
      'aidlc:run',
      'agent',
      insideProbe(),
    )) as SandboxStatus;
    expect(status.firewall).toBe('enforced');
    const off = { ...config, sandbox: { ...config.sandbox, enforce: 'off' as const } };
    expect(await enforceSandbox(off, 'aidlc:run', 'agent', fakeProbe())).toBeNull();
  });

  it('reports the sandbox as checks of aidlc:init-check', async () => {
    const outside = await sandboxChecks(config, false, fakeProbe());
    expect(outside.filter((c) => !c.ok && c.required).map((c) => c.name)).toEqual([
      'Sandbox (enforce: strict)',
      'Sandbox container runtime',
    ]);
    const inside = await sandboxChecks(config, false, insideProbe());
    expect(inside.every((c) => c.ok)).toBe(true);
  });
});

describe('sandbox definition', () => {
  const devcontainer = readFileSync(
    path.join(REPO_ROOT, '.devcontainer/devcontainer.json'),
    'utf8',
  );

  it('pins the Playwright image version to the locked @playwright/test', () => {
    const lock = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { version: string }>;
    };
    const pinned = /"PLAYWRIGHT_VERSION":\s*"([^"]+)"/.exec(devcontainer)?.[1];
    expect(pinned).toBe(lock.packages['node_modules/@playwright/test']?.version);
  });

  it('declares the sandbox kind the harness expects and least-privilege run arguments', () => {
    expect(devcontainer).toMatch(/"AIDLC_SANDBOX":\s*"devcontainer"/);
    expect(devcontainer).toContain('"--cap-drop=ALL"');
    expect(devcontainer).toContain('"--security-opt=no-new-privileges:true"');
    const code = devcontainer.replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/--privileged|docker\.sock|--network=host|--ipc=host/);
  });

  it('protects the sandbox from the agent with the boundary policy', () => {
    const classifier = new BoundaryClassifier(
      loadBoundaryPolicy(resolvePaths(REPO_ROOT).boundaryPolicy),
    );
    for (const file of [
      '.devcontainer/devcontainer.json',
      '.devcontainer/init-firewall.sh',
      'scripts/sandbox.ts',
    ])
      expect(classifier.classify(file)).toBe('immutable');
  });

  it('maps launcher commands to the Dev Container CLI', () => {
    expect(devcontainerArgs('up', [], '/r')).toEqual(['up', '--workspace-folder', '/r']);
    expect(devcontainerArgs('exec', ['npm', 'run', 'gate'], '/r')).toEqual([
      'exec',
      '--workspace-folder',
      '/r',
      'npm',
      'run',
      'gate',
    ]);
    expect(devcontainerArgs('down', [], '/r')).toBeNull();
    expect(() => devcontainerArgs('exec', [], '/r')).toThrow(/needs a command/);
    expect(() => devcontainerArgs('nope', [], '/r')).toThrow(/Unknown command/);
  });
});
