/**
 * Host-side PR Auto-Pilot: after a pull request is opened, mark it ready, wait for CI, approve and
 * rebase-merge it — without bypassing branch protection. Modelled on the change-dev Auto-Pilot of
 * sun-flat-yamada/github-copilot-dashboard.
 *
 *   npm run pr:mode                                   print the resolved mode
 *   npm run pr:finish -- <pr> [--wait] [--dry-run] [--force]
 *     exit code: 0 = merged (or mergeable with --dry-run), 2 = CI still running, 1 = stopped (reason printed)
 *
 * Mode: PR_AUTO_PILOT, resolved from the process environment, then `.env`, then `.env.example` (the
 * repository default). `true` (any case) or `1` enables it; anything else means manual merging.
 *
 * Why this runs on the host and not in the sandbox: it needs the maintainer's GitHub credentials, which
 * the sandbox deliberately never holds (docs/sandbox.md). It only talks to the GitHub REST API through
 * `gh api` and never builds, tests or runs repository code.
 *
 * Why REST only: Claude Code cloud sessions reach GitHub through a proxy that rejects GraphQL, so
 * `gh pr view|ready|merge|checks` do not work there. REST has no "ready for review" route, so cloud
 * sessions (CLAUDE_CODE_REMOTE=true) use the proxy route `pulls/{n}/ccr/ready_for_review` and local
 * runs use `gh pr ready`.
 *
 * Runs with Node's built-in TypeScript support and imports nothing outside node:*.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const AUTO_PILOT_KEY = 'PR_AUTO_PILOT';
export const MERGE_METHOD = 'rebase';
const WAIT_INTERVAL_MS = 30_000;
const WAIT_LIMIT_MS = 45 * 60_000;

const USAGE =
  'Usage: npm run pr:mode | npm run pr:finish -- <pr-number> [--wait] [--dry-run] [--force]';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Mode resolution (pure)
// ---------------------------------------------------------------------------

export type AutoPilotSource = 'process-env' | '.env' | '.env.example' | 'unset';

export interface AutoPilotResolution {
  enabled: boolean;
  source: AutoPilotSource;
  raw: string | null;
}

/** Reads the `.env` format: KEY=value, `#` comments, optional quotes and `export`. */
export function parseEnvFile(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = (m[2] ?? '').trim();
    const quoted = /^(['"])(.*)\1$/.exec(value);
    value = quoted ? (quoted[2] ?? '') : value.replace(/\s+#.*$/, '').trim();
    result[m[1] as string] = value;
  }
  return result;
}

/** `true` (any case) or `1` enables Auto-Pilot. */
export function isEnabledValue(raw: string | null | undefined): boolean {
  if (raw === null || raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === 'true' || v === '1';
}

/** The first layer with a non-empty value wins: process env → `.env` → `.env.example`. */
export function resolveAutoPilot(input: {
  env: Record<string, string | undefined>;
  dotEnv?: Record<string, string> | null;
  dotEnvExample?: Record<string, string> | null;
}): AutoPilotResolution {
  const layers: Array<[AutoPilotSource, string | undefined]> = [
    ['process-env', input.env[AUTO_PILOT_KEY]],
    ['.env', input.dotEnv?.[AUTO_PILOT_KEY]],
    ['.env.example', input.dotEnvExample?.[AUTO_PILOT_KEY]],
  ];
  for (const [source, raw] of layers) {
    if (raw !== undefined && raw !== '') return { enabled: isEnabledValue(raw), source, raw };
  }
  return { enabled: false, source: 'unset', raw: null };
}

export interface PrPolicy {
  autoPilot: boolean;
  /** Claude Code cloud session (CLAUDE_CODE_REMOTE=true). */
  cloud: boolean;
  /** Open the pull request as a draft? */
  prDraft: boolean;
  /** What happens after the pull request is opened. */
  afterPr: 'auto-merge' | 'manual';
  /** How "ready for review" is set. */
  readyRoute: 'ccr-rest' | 'gh-cli';
}

export function derivePolicy(autoPilot: boolean, cloud: boolean): PrPolicy {
  return {
    autoPilot,
    cloud,
    prDraft: !autoPilot,
    afterPr: autoPilot ? 'auto-merge' : 'manual',
    readyRoute: cloud ? 'ccr-rest' : 'gh-cli',
  };
}

// ---------------------------------------------------------------------------
// Merge readiness (pure)
// ---------------------------------------------------------------------------

export interface PullSnapshot {
  state: string;
  merged: boolean;
  draft: boolean;
  /** REST `mergeable_state`: clean / unstable / blocked / behind / dirty / unknown / draft / has_hooks. */
  mergeableState: string;
  headSha: string;
}

export interface CheckRunSnapshot {
  name: string;
  /** queued / in_progress / completed / waiting / requested / pending */
  status: string;
  conclusion: string | null;
}

export interface ReviewSnapshot {
  user: string;
  /** APPROVED / CHANGES_REQUESTED / COMMENTED / DISMISSED / PENDING */
  state: string;
}

export interface MergeReadiness {
  state: 'ready' | 'pending' | 'blocked';
  reasons: string[];
}

const FAILED_CONCLUSIONS = new Set([
  'failure',
  'cancelled',
  'timed_out',
  'action_required',
  'startup_failure',
  'stale',
]);

/** Users whose latest decisive review (approve / request changes / dismissed) requests changes. */
export function outstandingChangeRequests(reviews: ReviewSnapshot[]): string[] {
  const latest = new Map<string, string>();
  for (const r of reviews) {
    if (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED' || r.state === 'DISMISSED') {
      latest.set(r.user, r.state);
    }
  }
  return [...latest].filter(([, state]) => state === 'CHANGES_REQUESTED').map(([user]) => user);
}

/**
 * Decides whether the pull request may be merged.
 * - a failed check, a conflict or an outstanding change request blocks it (the agent fixes and pushes);
 * - a running check, no check at all yet, or a mergeability still being computed means pending.
 * Merging with zero checks would merge untested code right after a push, before CI has registered.
 */
export function evaluateMergeReadiness(
  pr: PullSnapshot,
  checkRuns: CheckRunSnapshot[],
  reviews: ReviewSnapshot[] = [],
  options: { allowNoChecks?: boolean } = {},
): MergeReadiness {
  if (pr.merged) return { state: 'blocked', reasons: ['already merged'] };
  if (pr.state !== 'open') return { state: 'blocked', reasons: ['pull request is closed'] };

  const blocked: string[] = [];
  for (const c of checkRuns) {
    if (c.status === 'completed' && FAILED_CONCLUSIONS.has(c.conclusion ?? '')) {
      blocked.push(`check failed: ${c.name} (${c.conclusion})`);
    }
  }
  if (pr.mergeableState === 'dirty') blocked.push('merge conflict with the base branch');
  for (const user of outstandingChangeRequests(reviews))
    blocked.push(`changes requested by ${user}`);
  if (blocked.length > 0) return { state: 'blocked', reasons: blocked };

  const pending: string[] = [];
  if (checkRuns.length === 0 && !options.allowNoChecks)
    pending.push('no check has reported on the head commit yet');
  for (const c of checkRuns) if (c.status !== 'completed') pending.push(`check running: ${c.name}`);
  if (pr.mergeableState === 'unknown') pending.push('mergeability is being computed');
  return pending.length > 0
    ? { state: 'pending', reasons: pending }
    : { state: 'ready', reasons: [] };
}

/** GitHub rejects an approval by the pull request's author with 422. */
export function isSelfApprovalRejection(message: string): boolean {
  return /approve your own pull request/i.test(message);
}

/** Parses `owner/repo` from an origin URL (https, ssh, or a local proxy that keeps the path). */
export function repoSlugFromUrl(url: string): string | null {
  const m = /(?:github\.com[/:]|\/git\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

// ---------------------------------------------------------------------------
// GitHub REST through `gh api`
// ---------------------------------------------------------------------------

function gh(args: string[]): string {
  return execFileSync('gh', args, {
    cwd: repoRoot,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function errorText(e: unknown): string {
  const err = e as { stderr?: string; stdout?: string; message?: string };
  return `${err.stdout ?? ''}${err.stderr ?? ''}${err.message ?? ''}`;
}

type Json = any;

function ghApi(method: string, route: string, fields: Record<string, string> = {}): Json {
  const args = ['api', '--method', method, route];
  for (const [k, v] of Object.entries(fields)) args.push('-f', `${k}=${v}`);
  const out = gh(args);
  return out.trim() ? JSON.parse(out) : {};
}

function repoSlug(): string {
  const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
    cwd: repoRoot,
    encoding: 'utf-8',
  });
  const slug = repoSlugFromUrl(url);
  if (!slug) throw new Error(`origin is not a GitHub repository: ${url.trim()}`);
  return slug;
}

type Pull = PullSnapshot & { baseRef: string; headRef: string };

function readPull(repo: string, pr: number): Pull {
  const p = ghApi('GET', `repos/${repo}/pulls/${pr}`);
  return {
    state: p.state,
    merged: !!p.merged,
    draft: !!p.draft,
    mergeableState: p.mergeable_state ?? 'unknown',
    headSha: p.head.sha,
    baseRef: p.base.ref,
    headRef: p.head.ref,
  };
}

function readCheckRuns(repo: string, sha: string): CheckRunSnapshot[] {
  const r = ghApi('GET', `repos/${repo}/commits/${sha}/check-runs?per_page=100`);
  return (r.check_runs ?? []).map((c: Json) => ({
    name: c.name,
    status: c.status,
    conclusion: c.conclusion,
  }));
}

function readReviews(repo: string, pr: number): ReviewSnapshot[] {
  const r = ghApi('GET', `repos/${repo}/pulls/${pr}/reviews?per_page=100`);
  return (Array.isArray(r) ? r : []).map((x: Json) => ({
    user: x.user?.login ?? '',
    state: x.state,
  }));
}

/** Approvals the base branch's protection requires; 0 when it is unprotected or unreadable. */
function requiredApprovals(repo: string, branch: string): number {
  try {
    const p = ghApi('GET', `repos/${repo}/branches/${branch}/protection`);
    return p.required_pull_request_reviews?.required_approving_review_count ?? 0;
  } catch {
    return 0;
  }
}

function markReady(repo: string, pr: number, policy: PrPolicy): void {
  if (policy.readyRoute === 'ccr-rest')
    ghApi('POST', `repos/${repo}/pulls/${pr}/ccr/ready_for_review`);
  else gh(['pr', 'ready', String(pr), '--repo', repo]);
}

function approve(repo: string, pr: number, sha: string): 'approved' | 'self' {
  try {
    ghApi('POST', `repos/${repo}/pulls/${pr}/reviews`, {
      event: 'APPROVE',
      commit_id: sha,
      body: 'PR Auto-Pilot: every check passed on this head commit.',
    });
    return 'approved';
  } catch (e) {
    if (isSelfApprovalRejection(errorText(e))) return 'self';
    throw e;
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function readEnvFile(name: string): Record<string, string> | null {
  const file = path.join(repoRoot, name);
  return existsSync(file) ? parseEnvFile(readFileSync(file, 'utf-8')) : null;
}

export function currentPolicy(): { resolution: AutoPilotResolution; policy: PrPolicy } {
  const resolution = resolveAutoPilot({
    env: process.env,
    dotEnv: readEnvFile('.env'),
    dotEnvExample: readEnvFile('.env.example'),
  });
  return {
    resolution,
    policy: derivePolicy(resolution.enabled, process.env.CLAUDE_CODE_REMOTE === 'true'),
  };
}

async function finish(prArg: string | undefined, flags: Set<string>): Promise<number> {
  const pr = Number(prArg);
  if (!Number.isInteger(pr) || pr <= 0) {
    console.error(USAGE);
    return 1;
  }
  const { resolution, policy } = currentPolicy();
  if (!policy.autoPilot && !flags.has('--force')) {
    console.error(
      `${AUTO_PILOT_KEY} is not enabled (source: ${resolution.source}). Merge manually, or pass --force.`,
    );
    return 1;
  }
  const dryRun = flags.has('--dry-run');
  const repo = repoSlug();
  let pull = readPull(repo, pr);

  if (pull.draft && pull.state === 'open') {
    console.log(`PR #${pr} is a draft: marking it ready for review`);
    if (!dryRun) markReady(repo, pr, policy);
  }

  // Without --wait return 2 at once: a cloud session is woken by the PR event and runs this again.
  const deadline = Date.now() + WAIT_LIMIT_MS;
  let readiness: MergeReadiness;
  for (;;) {
    pull = readPull(repo, pr);
    readiness = evaluateMergeReadiness(
      pull,
      readCheckRuns(repo, pull.headSha),
      readReviews(repo, pr),
    );
    if (readiness.state !== 'pending' || !flags.has('--wait') || Date.now() > deadline) break;
    console.log(`waiting: ${readiness.reasons.join('; ')}`);
    await new Promise((resolve) => setTimeout(resolve, WAIT_INTERVAL_MS));
  }
  if (readiness.state === 'pending') {
    console.log(`PR #${pr} is not ready yet: ${readiness.reasons.join('; ')}`);
    return 2;
  }
  if (readiness.state === 'blocked') {
    console.error(`PR #${pr} cannot be merged: ${readiness.reasons.join('; ')}`);
    return 1;
  }

  const required = requiredApprovals(repo, pull.baseRef);
  if (dryRun) {
    console.log(`(dry-run) would approve; ${pull.baseRef} requires ${required} approval(s)`);
    console.log(`(dry-run) would ${MERGE_METHOD}-merge PR #${pr} at ${pull.headSha}`);
    return 0;
  }
  if (approve(repo, pr, pull.headSha) === 'self') {
    console.log('GitHub rejected the approval: the author cannot approve their own pull request.');
    if (required > 0) {
      console.error(
        `${pull.baseRef} requires ${required} approval(s); another account must approve.`,
      );
      return 1;
    }
    console.log(`${pull.baseRef} requires 0 approvals: continuing without one.`);
  } else {
    console.log('approved');
  }

  // Merge exactly the head that was checked: a commit pushed after the check makes GitHub refuse (409).
  ghApi('PUT', `repos/${repo}/pulls/${pr}/merge`, {
    merge_method: MERGE_METHOD,
    sha: pull.headSha,
  });
  console.log(`PR #${pr} ${MERGE_METHOD}-merged into ${pull.baseRef}.`);
  console.log('The head branch is deleted by GitHub ("Automatically delete head branches").');
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const flags = new Set(rest.filter((a) => a.startsWith('--')));
  const positional = rest.filter((a) => !a.startsWith('--'));
  if (command === 'mode') {
    const { resolution, policy } = currentPolicy();
    console.log(JSON.stringify({ [AUTO_PILOT_KEY]: resolution, policy }, null, 2));
    return 0;
  }
  if (command === 'finish') return finish(positional[0], flags);
  console.error(USAGE);
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      console.error(errorText(e));
      process.exitCode = 1;
    },
  );
}
