#!/usr/bin/env bash
# Default-deny egress firewall of the AI-DLC sandbox.
#
# Installed as /usr/local/bin/aidlc-init-firewall (root-owned) and run as root by the container
# entrypoint (aidlc-entrypoint) on every container start, before the sandbox user gets a shell.
# The sandbox user cannot run it (no sudo in the image, no-new-privileges). It reads its settings
# from sources the agent cannot change: the baked-in allow-list and the environment of the
# container's PID 1 (containerEnv in devcontainer.json).
#
#   AIDLC_FIREWALL=enforce|off            off writes a "disabled" marker (the harness then refuses
#                                         to run while sandbox.requireEgressFirewall is true)
#   AIDLC_FIREWALL_EXTRA_DOMAINS=a,b      additional allowed host names
#   HTTPS_PROXY / HTTP_PROXY              the proxy host is allowed (the proxy's own policy applies)
#
# On success it writes /run/aidlc-sandbox/egress-firewall: "<state> <pid1-starttime> <utc>".
set -euo pipefail
IFS=$'\n\t'

MARKER_DIR=/run/aidlc-sandbox
MARKER="${MARKER_DIR}/egress-firewall"
ALLOW_LIST=/etc/aidlc-sandbox/allowed-domains.txt
IPSET=aidlc-allowed

if [ "$(id -u)" -ne 0 ]; then
  echo "aidlc-init-firewall must run as root (it is started by the container entrypoint)" >&2
  exit 77
fi

log() { echo "[aidlc-firewall] $*"; }
pid1_env() { tr '\0' '\n' </proc/1/environ | sed -n "s/^$1=//p" | head -n 1; }
pid1_start() { sed 's/.*) //' /proc/1/stat | cut -d' ' -f20; }
write_marker() {
  install -d -m 0755 "${MARKER_DIR}"
  printf '%s %s %s\n' "$1" "$(pid1_start)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"${MARKER}"
  chmod 0644 "${MARKER}"
}

install -d -m 0755 "${MARKER_DIR}"
rm -f "${MARKER}"
trap 'write_marker failed' ERR

mode="$(pid1_env AIDLC_FIREWALL)"
mode="${mode:-enforce}"
if [ "${mode}" = "off" ]; then
  log "AIDLC_FIREWALL=off — egress is NOT restricted"
  write_marker disabled
  exit 0
fi

# Proxy for the firewall's own HTTPS requests (sudo resets the environment).
proxy_url="$(pid1_env HTTPS_PROXY)"
proxy_url="${proxy_url:-$(pid1_env https_proxy)}"
if [[ "${proxy_url}" =~ ://(localhost|127\.|\[?::1) ]]; then
  log "WARN ignoring loopback proxy ${proxy_url} (the host's loopback is not reachable from the container)"
  proxy_url=""
fi
curl_proxy=(--noproxy '*')
[ -n "${proxy_url}" ] && curl_proxy=(--proxy "${proxy_url}")

# Keep Docker's embedded DNS (127.0.0.11) NAT rules across the flush.
docker_dns_rules="$(iptables-save -t nat | grep '127\.0\.0\.11' || true)"

iptables -F
iptables -X
iptables -t nat -F
iptables -t nat -X
iptables -t mangle -F
iptables -t mangle -X
ipset destroy "${IPSET}" 2>/dev/null || true

if [ -n "${docker_dns_rules}" ]; then
  iptables -t nat -N DOCKER_OUTPUT 2>/dev/null || true
  iptables -t nat -N DOCKER_POSTROUTING 2>/dev/null || true
  while read -r rule; do
    [[ "${rule}" == -A* ]] || continue
    eval "iptables -t nat ${rule}"
  done <<<"${docker_dns_rules}"
fi

# Loopback (local dev server, Playwright, Docker's embedded DNS at 127.0.0.11).
iptables -A INPUT -i lo -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT

# DNS: only to the resolvers the container is configured with, never to any host on port 53
# (otherwise 53/tcp is a plain TCP channel to any server). Docker's embedded DNS lists the upstream
# servers it forwards to in an "# ExtServers: [...]" comment; they are allowed as well.
resolvers="$(
  {
    sed -n 's/^[[:space:]]*nameserver[[:space:]]\+\([0-9.]\+\)[[:space:]]*$/\1/p' /etc/resolv.conf
    grep -i '^# *ExtServers:' /etc/resolv.conf | grep -oE '[0-9]+(\.[0-9]+){3}' || true
  } | grep -vE '^127\.' | sort -u || true
)"
for ns in ${resolvers}; do
  iptables -A OUTPUT -d "${ns}" -p udp --dport 53 -j ACCEPT
  iptables -A OUTPUT -d "${ns}" -p tcp --dport 53 -j ACCEPT
  log "allow DNS ${ns}"
done
[ -n "${resolvers}" ] || log "no external resolver in /etc/resolv.conf (loopback DNS only)"

ipset create "${IPSET}" hash:net

add_host() {
  local host="$1" ips ip
  ips="$(dig +short +time=3 +tries=2 A "${host}" | grep -E '^[0-9]+(\.[0-9]+){3}$' || true)"
  if [ -z "${ips}" ]; then
    log "WARN could not resolve ${host}"
    return 0
  fi
  for ip in ${ips}; do ipset add -exist "${IPSET}" "${ip}"; done
  log "allow ${host}"
}

# GitHub address ranges (web, api, git) — fetched before the default-deny policy is set.
meta="$(curl "${curl_proxy[@]}" -fsS --max-time 15 https://api.github.com/meta || true)"
if [ -n "${meta}" ] && echo "${meta}" | jq -e '.web and .api' >/dev/null; then
  while read -r cidr; do
    ipset add -exist "${IPSET}" "${cidr}"
  done < <(echo "${meta}" | jq -r '(.web + .api + .git)[]' | grep -v ':' | aggregate -q)
  log "allow GitHub meta ranges"
else
  log "WARN could not fetch https://api.github.com/meta — resolving GitHub host names only"
fi

while read -r line; do
  host="${line%%#*}"
  host="$(echo "${host}" | tr -d '[:space:]')"
  [ -n "${host}" ] && add_host "${host}"
done <"${ALLOW_LIST}"

extra="$(pid1_env AIDLC_FIREWALL_EXTRA_DOMAINS)"
for host in $(echo "${extra}" | tr ',' '\n'); do
  host="$(echo "${host}" | tr -d '[:space:]')"
  [ -n "${host}" ] && add_host "${host}"
done

for var in HTTPS_PROXY https_proxy HTTP_PROXY http_proxy; do
  proxy="$(pid1_env "${var}")"
  [ -n "${proxy}" ] || continue
  [[ "${proxy}" =~ ://(localhost|127\.|\[?::1) ]] && continue
  proxy_host="$(echo "${proxy}" | sed -E 's#^[a-zA-Z]+://##; s#^[^@]*@##; s#[:/].*$##')"
  if [[ "${proxy_host}" =~ ^[0-9]+(\.[0-9]+){3}$ ]]; then
    ipset add -exist "${IPSET}" "${proxy_host}"
  elif [ -n "${proxy_host}" ]; then
    add_host "${proxy_host}"
  fi
done

iptables -P INPUT DROP
iptables -P FORWARD DROP
iptables -P OUTPUT DROP
iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m set --match-set "${IPSET}" dst -j ACCEPT
# Reject (not drop) so that blocked requests fail fast instead of timing out.
iptables -A OUTPUT -j REJECT --reject-with icmp-admin-prohibited

# IPv6: loopback only.
if ip6tables -L >/dev/null 2>&1; then
  ip6tables -F || true
  ip6tables -A INPUT -i lo -j ACCEPT
  ip6tables -A OUTPUT -o lo -j ACCEPT
  ip6tables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
  ip6tables -P INPUT DROP
  ip6tables -P FORWARD DROP
  ip6tables -P OUTPUT DROP
fi

# Verify: a direct connection outside the allow-list must be blocked, GitHub must be reachable.
if curl --noproxy '*' -fsS --max-time 5 -o /dev/null https://example.com 2>/dev/null; then
  log "ERROR https://example.com is reachable — firewall verification failed"
  write_marker failed
  exit 1
fi
# Port 53 must not be a way out either: a TCP connection to a host that is not a resolver must fail.
for probe in 1.1.1.1 9.9.9.9 208.67.222.222; do
  grep -qxF "${probe}" <<<"${resolvers}" && continue
  if timeout 5 bash -c "exec 3<>/dev/tcp/${probe}/53" 2>/dev/null; then
    log "ERROR ${probe}:53/tcp is reachable — firewall verification failed"
    write_marker failed
    exit 1
  fi
  break
done
# Any HTTP status counts as reachable (api.github.com answers 403 when rate-limited).
status="$(curl "${curl_proxy[@]}" -sS --max-time 10 -o /dev/null -w '%{http_code}' https://api.github.com/zen || true)"
if [ "${status:-000}" = "000" ]; then
  log "ERROR https://api.github.com is not reachable — check the allow-list / proxy settings"
  write_marker failed
  exit 1
fi

write_marker enforced
log "egress firewall enforced"
