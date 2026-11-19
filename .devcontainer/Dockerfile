# AI-DLC sandbox image: everything the SDK needs (Node.js, git, GitHub Copilot CLI, Angular toolchain
# prerequisites, Playwright Chromium) so that no command has to run on the host.
# Built by .devcontainer/devcontainer.json; versions are pinned there (build args).
ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE}

ARG PLAYWRIGHT_VERSION=1.65.1
ARG COPILOT_CLI_VERSION=1.0.114
ARG USERNAME=node

ENV DEBIAN_FRONTEND=noninteractive \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt \
    NG_CLI_ANALYTICS=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

# OS packages: git for the boundary guard, iptables/ipset/dig for the egress firewall.
# No sudo: the sandbox user has no way to become root.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git less procps jq \
      iptables ipset iproute2 dnsutils aggregate \
 && rm -rf /var/lib/apt/lists/*

# Optional extra CA certificates for TLS-inspecting corporate proxies (*.crt, never committed).
COPY certs/ /usr/local/share/ca-certificates/aidlc/
RUN update-ca-certificates

# GitHub Copilot CLI and Playwright Chromium are baked into the image: the agent never needs to
# download tools at run time, which keeps the egress allow-list short.
RUN npm install -g "@github/copilot@${COPILOT_CLI_VERSION}" \
 && npx --yes "playwright@${PLAYWRIGHT_VERSION}" install --with-deps chromium \
 && chmod -R a+rX "${PLAYWRIGHT_BROWSERS_PATH}" \
 && npm cache clean --force \
 && rm -rf /var/lib/apt/lists/* /root/.npm

# Egress firewall: root-owned scripts and allow-list, applied by the entrypoint as root on every
# container start. The sandbox user can neither edit nor run them.
COPY init-firewall.sh /usr/local/bin/aidlc-init-firewall
COPY entrypoint.sh /usr/local/bin/aidlc-entrypoint
COPY allowed-domains.txt /etc/aidlc-sandbox/allowed-domains.txt
RUN chmod 0755 /usr/local/bin/aidlc-init-firewall /usr/local/bin/aidlc-entrypoint \
 && chmod 0644 /etc/aidlc-sandbox/allowed-domains.txt

# Workspace skeleton. node_modules and the Copilot CLI state live in named volumes; creating the
# mount points here gives those volumes the right owner on first use.
RUN mkdir -p /workspace/node_modules "/home/${USERNAME}/.copilot" \
 && chown -R "${USERNAME}:${USERNAME}" /workspace "/home/${USERNAME}/.copilot"

ENV AIDLC_SANDBOX_USER=${USERNAME}
WORKDIR /workspace
# Starts as root only to apply the firewall, then drops to ${USERNAME} (see entrypoint.sh).
ENTRYPOINT ["/usr/local/bin/aidlc-entrypoint"]
CMD ["sleep", "infinity"]
