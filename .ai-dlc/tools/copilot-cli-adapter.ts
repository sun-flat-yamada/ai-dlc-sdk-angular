/**
 * GitHub Copilot CLI adapter.
 *
 * - Writes the full prompt to a Markdown file and passes a short instruction with `-p`
 *   (avoids command-line length limits and shell quoting issues).
 * - Builds the argument vector from the template in `aidlc.config.yaml` (`copilot.args`).
 * - Records timing, prompt size, token usage (`--usage-output-file`) and changed files
 *   in the run telemetry.
 * - `--dry-run` skips the CLI call but produces the same files and telemetry.
 *
 *   npm exec tsx .ai-dlc/tools/copilot-cli-adapter.ts -- --prompt-file p.md [--dry-run]
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { AidlcConfig, AidlcPaths, findRepoRoot, loadConfig, resolvePaths } from './lib/config.js';
import { exec } from './lib/exec.js';
import { Git } from './lib/git.js';
import { killOrphansSince, snapshotPids } from './lib/processes.js';
import { isMain, log, rel, runCli } from './lib/cli.js';
import { CopilotCallRecord, estimateTokens, parseUsageFile } from './lib/telemetry.js';

export interface CopilotCallRequest {
  id: string;
  phase: CopilotCallRecord['phase'];
  skills: string[];
  /** Full prompt (Markdown). */
  prompt: string;
  /** Directory that receives prompt.md, usage.json, transcript.md and output.log. */
  workDir: string;
  dryRun: boolean;
  /** Mirror the CLI output to the console. */
  echo?: boolean;
}

/** Replaces `{placeholder}` tokens in the argument template. Unknown placeholders are kept. */
export function renderArgs(template: readonly string[], values: Record<string, string>): string[] {
  return template.map((arg) => arg.replace(/\{(\w+)\}/g, (all, key: string) => values[key] ?? all));
}

export function buildCommand(config: AidlcConfig, values: Record<string, string>): string[] {
  return [config.copilot.command, ...renderArgs(config.copilot.args, values)];
}

/** Content fingerprint of every dirty path, used to list the files a call changed. */
async function dirtyFingerprint(git: Git, root: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const line of await git.statusLines()) {
    const file = line.slice(3).replace(/^"|"$/g, '').split(' -> ').pop()!;
    const abs = path.join(root, file);
    const hash = existsSync(abs)
      ? createHash('sha1').update(readFileSync(abs)).digest('hex')
      : 'deleted';
    map.set(file, `${line.slice(0, 2)}:${hash}`);
  }
  return map;
}

export async function callCopilot(
  paths: AidlcPaths,
  config: AidlcConfig,
  request: CopilotCallRequest,
): Promise<CopilotCallRecord> {
  mkdirSync(request.workDir, { recursive: true });
  const promptFile = path.join(request.workDir, `${request.id}.prompt.md`);
  const usageFile = path.join(request.workDir, `${request.id}.usage.json`);
  const transcriptFile = path.join(request.workDir, `${request.id}.transcript.md`);
  const outputFile = path.join(request.workDir, `${request.id}.output.log`);
  writeFileSync(promptFile, request.prompt, 'utf8');

  const values = {
    promptFile: rel(paths.root, promptFile),
    usageFile: rel(paths.root, usageFile),
    transcriptFile: rel(paths.root, transcriptFile),
    logDir: rel(paths.root, path.join(request.workDir, 'logs')),
    model: config.copilot.model,
  };
  const prompt = renderArgs([config.copilot.promptTemplate], values)[0]!;
  const command = buildCommand(config, { ...values, prompt });
  const git = new Git(paths.root);
  const before = await dirtyFingerprint(git, paths.root);
  const startedAt = new Date();
  let exitCode = 0;
  let output = '';
  let leftover: string[] = [];
  if (request.dryRun) {
    output = `[dry-run] ${command.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}\n`;
    log.info(
      `dry-run: Copilot CLI not called (${request.id}, skills: ${request.skills.join(', ')})`,
    );
  } else {
    log.info(`Copilot CLI: ${request.id} (skills: ${request.skills.join(', ')})`);
    const pids = snapshotPids();
    // Own process group, killed when the CLI exits: no background server or watcher survives.
    const result = await exec(command, {
      cwd: paths.root,
      timeoutMs: config.copilot.timeoutMinutes * 60_000,
      echo: request.echo ?? true,
      killProcessGroup: true,
    });
    exitCode = result.exitCode;
    output = result.output;
    leftover = killOrphansSince(pids).map((p) => `${p.pid} ${p.command}`.slice(0, 200));
    if (leftover.length)
      log.warn(
        `Killed ${leftover.length} process(es) the agent left running:\n  ${leftover.join('\n  ')}`,
      );
    if (result.timedOut)
      log.warn(`Copilot CLI timed out after ${config.copilot.timeoutMinutes} min`);
  }
  writeFileSync(outputFile, output, 'utf8');
  const endedAt = new Date();
  const after = await dirtyFingerprint(git, paths.root);
  const changedFiles = [...new Set([...before.keys(), ...after.keys()])]
    .filter((f) => before.get(f) !== after.get(f))
    .filter((f) => !f.startsWith('.ai-dlc/outputs/telemetry/'))
    .sort();
  const usage = existsSync(usageFile) ? parseUsageFile(readFileSync(usageFile, 'utf8')) : undefined;
  return {
    id: request.id,
    skills: request.skills,
    phase: request.phase,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: endedAt.getTime() - startedAt.getTime(),
    dryRun: request.dryRun,
    exitCode,
    promptFile: rel(paths.root, promptFile),
    promptChars: request.prompt.length,
    estimatedInputTokens: estimateTokens(request.prompt.length),
    outputChars: output.length,
    estimatedOutputTokens: estimateTokens(output.length),
    ...(usage ? { usage } : {}),
    ...(leftover.length ? { leftoverProcesses: leftover } : {}),
    changedFiles,
  };
}

/** Checks that the Copilot CLI is installed. */
export async function probeCopilot(
  paths: AidlcPaths,
  config: AidlcConfig,
): Promise<{ ok: boolean; version: string }> {
  const r = await exec([config.copilot.command, '--version'], {
    cwd: paths.root,
    timeoutMs: 60_000,
  });
  return { ok: r.exitCode === 0, version: r.output.trim().split(/\r?\n/)[0] ?? '' };
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      'prompt-file': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      skill: { type: 'string', multiple: true },
    },
  });
  if (!values['prompt-file']) throw new Error('--prompt-file <file> is required');
  const root = findRepoRoot();
  const paths = resolvePaths(root);
  const config = loadConfig(paths.config);
  const record = await callCopilot(paths, config, {
    id: `adhoc-${Date.now()}`,
    phase: 'implement',
    skills: values.skill ?? [],
    prompt: readFileSync(values['prompt-file'], 'utf8'),
    workDir: path.join(paths.outputs.telemetry, 'adhoc'),
    dryRun: values['dry-run'],
  });
  console.log(JSON.stringify(record, null, 2));
  return record.exitCode;
}

if (isMain(import.meta.url)) {
  runCli(main);
}
