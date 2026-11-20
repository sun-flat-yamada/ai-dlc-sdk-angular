# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | ✅ |

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub private vulnerability reporting:
**Security** tab → **Report a vulnerability**
(<https://github.com/sun-flat-yamada/ai-dlc-sdk-angular/security/advisories/new>).
Include reproduction steps and the impact. You will get an answer within a few business days.

## Security model of the harness

The harness starts **GitHub Copilot CLI in non-interactive mode with tool permissions**. Understand the
following before running `npm run aidlc:run` without `--dry-run`.

1. **Tool permissions** are set in `.ai-dlc/config/aidlc.config.yaml` → `copilot.args`.
   The default allows file writes and `npm` / `npx` / `node` / read-only `git` commands, and denies
   `git push`, `git commit`, `git reset`, `git checkout`, `git clean` and `git rebase`. Deny rules win over
   allow rules. Review them for your environment; do not replace them with `--allow-all` / `--yolo`.
2. **`--trust-folder`** trusts the repository configuration (skills, instructions) for that one session.
   Run the harness only on repositories whose `.github/` and `AGENTS.md` you control.
3. **Sandbox**: every SDK operation runs in the bundled dev container ([docs/sandbox.md](docs/sandbox.md)):
   non-root user without sudo, `no-new-privileges`, all capabilities dropped except those the root
   entrypoint needs, a default-deny egress firewall applied before any user process, only the
   repository mounted, no host credentials. `npm` scripts run by the agent execute arbitrary code from
   `package.json` and dependencies — inside the sandbox. The harness refuses to run outside it
   (`sandbox.enforce: strict`); do not lower that setting for real runs.
4. **Boundary guard** reverts changes to protected paths after each iteration, including the sandbox
   definition (`.devcontainer/**`), so the agent cannot weaken its own sandbox for the next run.
   It is a safety net for the code base; the sandbox is what contains the commands. Git-ignored
   dependencies (`node_modules/`) are fingerprinted in memory before the agent runs; any change fails
   Gate 1 and they are reinstalled from `package-lock.json` (`loop.dependencyGuard`).
5. **Confidential inputs**: requirements, device API specifications and test specifications are sent to
   the model as context. Check your organization's Copilot policies (content exclusion, data retention)
   before using real documents. Generated outputs are git-ignored by default.
6. **Secrets**: never place tokens in the inputs or configuration. Authenticate Copilot CLI inside the
   sandbox with `copilot login`, or pass a fine-grained token with the _Copilot Requests_ permission
   only via `COPILOT_GITHUB_TOKEN`. Do not forward SSH agents or git credential helpers into the
   sandbox (the harness refuses to run when it detects them).

## Repository safeguards

- `npm run secret-scan` (local and CI) and Gitleaks on the full history.
- CodeQL (`security-and-quality`) and dependency review on pull requests.
- Dependabot for npm and GitHub Actions.
