# Claude Code configuration

@AGENTS.md

## Commands

All commands run inside the sandbox (`npm run sandbox -- up` once, then prefix with `npm run sandbox -- exec`):

- `/gate`: `npm run sandbox -- exec npm run gate`
- `/dry-run`: `npm run sandbox -- exec npm run aidlc:run -- --max-iterations 3 --dry-run`
- `/finish <pr>`: on the host (not in the sandbox), `npm run pr:finish -- <pr>`; PR Auto-Pilot, see `docs/pr-auto-merge.md`
- `/inputs`: `npm run sandbox -- exec bash -c "npm run aidlc:parse-excel && npm run aidlc:validate-inputs"`
