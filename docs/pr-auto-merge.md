# Merging pull requests (PR Auto-Pilot)

Pull requests to `main` are merged by **rebase merge** only. With PR Auto-Pilot on (the repository default),
nobody has to press the merge button: once CI is green, `npm run pr:finish` approves and merges the pull
request. It never bypasses branch protection. The flow is modelled on the change-dev Auto-Pilot of
[github-copilot-dashboard](https://github.com/sun-flat-yamada/github-copilot-dashboard).

## Mode: `PR_AUTO_PILOT`

Resolved from the process environment, then `.env` (git-ignored), then `.env.example` (repository default:
`true`). `true` (any case) or `1` turns it on; anything else turns it off. `npm run pr:mode` prints the
resolved value and what follows from it.

| Decision point | On | Off |
| --- | --- | --- |
| Pull request when opened | Ready for review | Draft |
| After the pull request | `npm run pr:finish -- <number>` merges it once CI is green | A maintainer merges it |

To turn it off in a Claude Code cloud session, set `PR_AUTO_PILOT=false` in the cloud environment's
variables; locally, put it in `.env`.

## `npm run pr:finish -- <number> [--wait] [--dry-run] [--force]`

1. Marks the pull request ready for review if it is a draft.
2. Reads the check runs of the head commit. It waits while a check runs, while **no** check has reported
   yet (right after a push, before CI registers), or while GitHub computes mergeability. It stops on a
   failed check, a conflict, or a reviewer whose latest review requests changes.
3. Approves with the account it runs as. GitHub rejects an approval by the author
   (`422 Can not approve your own pull request`); the helper then continues only if the base branch
   requires **0** approvals, and otherwise stops and reports.
4. Rebase-merges **at the checked head SHA** (`PUT /repos/{owner}/{repo}/pulls/{n}/merge` with `sha`), so a
   commit pushed after the check is never merged unchecked.
5. GitHub deletes the head branch (_Automatically delete head branches_ is on for this repository).

Exit codes: `0` merged (or mergeable, with `--dry-run`), `2` CI still running, `1` stopped with the reason
printed. Without `--wait` it returns `2` at once; `--wait` polls every 30 seconds for up to 45 minutes.
`--force` runs it while Auto-Pilot is off.

Guardrails: never use an admin merge or bypass branch protection or rulesets; never merge with a failed or
running check, a conflict or an outstanding change request. On a failure, fix it, run the quality gate
again and push; never skip or disable a test to get green.

### Where it runs

On the **host**, not in the sandbox: it needs the maintainer's GitHub credentials, which the sandbox
deliberately never holds ([sandbox.md](sandbox.md)). It needs only Node.js and the GitHub CLI (`gh`),
talks only to the GitHub REST API through `gh api`, and never builds, tests or runs repository code — the
quality gate runs in the sandbox and in CI before it.

### Claude Code cloud sessions

The session reaches GitHub through a proxy that attaches the user's credentials and rejects GraphQL, so the
helper uses REST only (`gh pr view|ready|merge|checks` would fail). When `CLAUDE_CODE_REMOTE=true` it marks
the pull request ready through the proxy route `POST /repos/{owner}/{repo}/pulls/{n}/ccr/ready_for_review`.
A session that opened a pull request subscribes to its activity and runs `npm run pr:finish -- <number>`
again when CI completes (exit code `2` means wait for that event; do not poll with `sleep`).

## Repository settings

| Setting | Value | Why |
| --- | --- | --- |
| _Allow rebase merging_ (only merge method) | on | Linear history |
| _Automatically delete head branches_ | on | The cloud proxy rejects branch deletion from a session |
| _Allow auto-merge_ | not needed | The helper merges directly after checking CI itself |
| Branch protection / ruleset on `main`: required approvals | **0** | The agent is the pull request's author and GitHub rejects self-approval; with 1 or more, another account must approve |
| Branch protection / ruleset on `main`: required status check `Quality gate in the sandbox (app + harness + E2E)` | recommended | Makes GitHub itself refuse a merge without green CI, also for manual merges |
