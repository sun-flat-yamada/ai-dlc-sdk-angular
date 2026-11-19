#!/usr/bin/env bash
# One-time setup inside the AI-DLC sandbox (runs after the egress firewall is up).
set -euo pipefail
cd "$(dirname "$0")/.."

# The entrypoint applies the egress firewall as root on container start; wait for it so that
# `npm ci` (which runs third-party install scripts) already runs behind the firewall.
marker=/run/aidlc-sandbox/egress-firewall
for _ in $(seq 1 90); do
  [ -s "${marker}" ] && break
  sleep 1
done
if ! grep -qE '^(enforced|disabled) ' "${marker}" 2>/dev/null; then
  echo "[post-create] egress firewall is not active:" >&2
  cat /run/aidlc-sandbox/firewall.log >&2 2>/dev/null || true
  exit 1
fi

# The workspace is a bind mount whose owner may differ from the sandbox user (Windows / macOS hosts).
git config --global --add safe.directory "$(pwd)"
# Never use a credential helper injected from the host.
git config --global credential.helper ''

npm ci --no-audit --no-fund
npm run aidlc:sandbox-check -- --scope tool || true
cat <<'MSG'

AI-DLC sandbox is ready.
  npm run aidlc:init-check      environment check (includes the sandbox checks)
  copilot login                 once, unless COPILOT_GITHUB_TOKEN is set on the host
  npm run aidlc:run -- --max-iterations 3 --dry-run
MSG
