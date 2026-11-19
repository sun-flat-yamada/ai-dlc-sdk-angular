/**
 * Reports whether the current process runs inside the AI-DLC sandbox and fails when the
 * configured `sandbox.enforce` level does not allow running here.
 *
 *   npm run aidlc:sandbox-check                 # scope "agent": executes project code
 *   npm run aidlc:sandbox-check -- --scope tool
 *   npm run aidlc:sandbox-check -- --json
 */
import { parseArgs } from 'node:util';
import { findRepoRoot, loadConfig, resolvePaths } from './lib/config.js';
import { isMain, log, runCli } from './lib/cli.js';
import { SandboxScope, detectSandbox, sandboxPolicy, sandboxViolations } from './lib/sandbox.js';

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      scope: { type: 'string', default: 'agent' },
      json: { type: 'boolean', default: false },
    },
  });
  const scope = values.scope as SandboxScope;
  if (scope !== 'agent' && scope !== 'tool') throw new Error('--scope must be "agent" or "tool"');
  const config = loadConfig(resolvePaths(findRepoRoot()).config);
  const policy = sandboxPolicy(config);
  const status = await detectSandbox({
    kind: config.sandbox.kind,
    egressProbeHost: config.sandbox.egressProbeHost,
  });
  const violations = sandboxViolations(status, policy, scope);
  if (values.json) {
    console.log(JSON.stringify({ policy, scope, status, violations }, null, 2));
  } else {
    log.info(`Sandbox policy: enforce=${policy.enforce}, scope=${scope}`);
    log.info(`  AIDLC_SANDBOX      ${status.declared ?? '(not set)'}`);
    log.info(`  container          ${status.container ? 'yes' : 'no'}`);
    log.info(`  egress firewall    ${status.firewall} (probe: ${status.egress})`);
    log.info(`  credential bridges ${status.credentialBridges.join('; ') || 'none'}`);
    for (const v of violations) log.warn(v);
    log.info(
      violations.length
        ? 'NOT allowed here. Run it in the sandbox: npm run sandbox -- exec <command> (docs/sandbox.md)'
        : 'OK',
    );
  }
  return violations.length ? 1 : 0;
}

if (isMain(import.meta.url)) {
  runCli(main);
}
