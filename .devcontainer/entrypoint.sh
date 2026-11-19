#!/usr/bin/env bash
# Entrypoint of the AI-DLC sandbox container. Runs as root on every container start:
#   1. applies the default-deny egress firewall (aidlc-init-firewall),
#   2. drops to the unprivileged sandbox user for the container's main process.
# The firewall log is readable at /run/aidlc-sandbox/firewall.log.
set -uo pipefail

install -d -m 0755 /run/aidlc-sandbox
if ! /usr/local/bin/aidlc-init-firewall >/run/aidlc-sandbox/firewall.log 2>&1; then
  echo "[aidlc-entrypoint] egress firewall setup FAILED — see /run/aidlc-sandbox/firewall.log" >&2
fi
chmod 0644 /run/aidlc-sandbox/firewall.log

if [ "$#" -eq 0 ]; then
  set -- sleep infinity
fi
exec setpriv --reuid="${AIDLC_SANDBOX_USER:-node}" --regid="${AIDLC_SANDBOX_USER:-node}" \
  --init-groups --no-new-privs -- "$@"
