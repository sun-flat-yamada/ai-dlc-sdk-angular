import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AUTO_PILOT_KEY,
  CheckRunSnapshot,
  PullSnapshot,
  derivePolicy,
  evaluateMergeReadiness,
  isEnabledValue,
  isSelfApprovalRejection,
  outstandingChangeRequests,
  parseEnvFile,
  repoSlugFromUrl,
  resolveAutoPilot,
} from '../../../scripts/pr-autopilot.js';
import { REPO_ROOT } from './helpers.js';

const OPEN: PullSnapshot = {
  state: 'open',
  merged: false,
  draft: false,
  mergeableState: 'clean',
  headSha: 'abc',
};
const GREEN: CheckRunSnapshot = { name: 'verify', status: 'completed', conclusion: 'success' };

describe('PR Auto-Pilot mode', () => {
  it('parses the .env format', () => {
    const env = parseEnvFile('# c\nexport A=1\nB = "x # y"\nC=z # note\nnot a line\n');
    expect(env).toEqual({ A: '1', B: 'x # y', C: 'z' });
  });

  it('accepts only true (any case) and 1', () => {
    expect(['true', 'TRUE', ' 1 '].map(isEnabledValue)).toEqual([true, true, true]);
    expect(['false', 'yes', '', null, undefined].map(isEnabledValue)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it('resolves process env, then .env, then .env.example', () => {
    const k = AUTO_PILOT_KEY;
    expect(resolveAutoPilot({ env: { [k]: 'false' }, dotEnv: { [k]: 'true' } })).toMatchObject({
      enabled: false,
      source: 'process-env',
    });
    expect(
      resolveAutoPilot({ env: {}, dotEnv: { [k]: '' }, dotEnvExample: { [k]: 'true' } }),
    ).toMatchObject({
      enabled: true,
      source: '.env.example',
    });
    expect(resolveAutoPilot({ env: {} })).toEqual({ enabled: false, source: 'unset', raw: null });
  });

  it('is enabled by the repository default', () => {
    const example = parseEnvFile(readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf-8'));
    expect(resolveAutoPilot({ env: {}, dotEnvExample: example }).enabled).toBe(true);
  });

  it('derives the PR policy', () => {
    expect(derivePolicy(true, true)).toEqual({
      autoPilot: true,
      cloud: true,
      prDraft: false,
      afterPr: 'auto-merge',
      readyRoute: 'ccr-rest',
    });
    expect(derivePolicy(false, false)).toMatchObject({
      prDraft: true,
      afterPr: 'manual',
      readyRoute: 'gh-cli',
    });
  });
});

describe('PR Auto-Pilot merge readiness', () => {
  it('is ready when every check passed', () => {
    const skipped = { name: 'docs', status: 'completed', conclusion: 'skipped' };
    expect(evaluateMergeReadiness(OPEN, [GREEN, skipped])).toEqual({ state: 'ready', reasons: [] });
  });

  it('waits for running checks, a missing CI run and mergeability', () => {
    expect(
      evaluateMergeReadiness(OPEN, [{ name: 'verify', status: 'in_progress', conclusion: null }])
        .state,
    ).toBe('pending');
    expect(evaluateMergeReadiness(OPEN, []).reasons).toEqual([
      'no check has reported on the head commit yet',
    ]);
    expect(evaluateMergeReadiness(OPEN, [], [], { allowNoChecks: true }).state).toBe('ready');
    expect(evaluateMergeReadiness({ ...OPEN, mergeableState: 'unknown' }, [GREEN]).state).toBe(
      'pending',
    );
  });

  it('blocks failed checks, conflicts, closed PRs and requested changes', () => {
    const failed = { name: 'verify', status: 'completed', conclusion: 'failure' };
    expect(evaluateMergeReadiness(OPEN, [failed])).toEqual({
      state: 'blocked',
      reasons: ['check failed: verify (failure)'],
    });
    expect(evaluateMergeReadiness({ ...OPEN, mergeableState: 'dirty' }, [GREEN]).state).toBe(
      'blocked',
    );
    expect(evaluateMergeReadiness({ ...OPEN, state: 'closed' }, [GREEN]).state).toBe('blocked');
    expect(evaluateMergeReadiness({ ...OPEN, merged: true }, [GREEN]).reasons).toEqual([
      'already merged',
    ]);
    const reviews = [{ user: 'reviewer', state: 'CHANGES_REQUESTED' }];
    expect(evaluateMergeReadiness(OPEN, [GREEN], reviews).reasons).toEqual([
      'changes requested by reviewer',
    ]);
  });

  it('keeps only the latest decisive review per user', () => {
    expect(
      outstandingChangeRequests([
        { user: 'a', state: 'CHANGES_REQUESTED' },
        { user: 'a', state: 'COMMENTED' },
        { user: 'b', state: 'CHANGES_REQUESTED' },
        { user: 'b', state: 'APPROVED' },
        { user: 'c', state: 'CHANGES_REQUESTED' },
        { user: 'c', state: 'DISMISSED' },
      ]),
    ).toEqual(['a']);
  });

  it('recognises the self-approval rejection', () => {
    expect(
      isSelfApprovalRejection(
        'Unprocessable Entity: Can not approve your own pull request (HTTP 422)',
      ),
    ).toBe(true);
    expect(isSelfApprovalRejection('Not Found (HTTP 404)')).toBe(false);
  });

  it('reads the repository from origin URLs', () => {
    expect(repoSlugFromUrl('https://github.com/owner/repo.git\n')).toBe('owner/repo');
    expect(repoSlugFromUrl('ssh://github.com/owner/repo')).toBe('owner/repo');
    expect(repoSlugFromUrl('http://127.0.0.1:8080/git/owner/repo')).toBe('owner/repo');
    expect(repoSlugFromUrl('https://example.invalid/x')).toBeNull();
  });
});
