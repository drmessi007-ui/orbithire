# OrbitHire Agent Deployment — Ubuntu 22.04 LTS

This package installs the existing Node.js agent as an isolated `systemd` service. It does not modify the contracts or frontend, install a reverse proxy, change firewall rules, or copy any repository `.env`/credential file. The service listens on one operator-selected TCP port bound to `127.0.0.1` by default.

## What this package contains

- `install.sh` — installs the agent files, creates a dedicated unprivileged service account, prepares a protected environment file, and enables the unit without starting it.
- `orbithire-agent.service` — the dedicated systemd unit with filesystem and privilege restrictions.
- `agent.env.example` — non-secret environment template.
- `Caddyfile.example` and `nginx-site.example` — optional reverse-proxy examples; neither is installed automatically.

The installer copies only `agent/package.json`, `agent/package-lock.json`, and `agent/src/`. It never reads or copies `secrets/`, `.env`, wallet credentials, contracts, or frontend files.

## Deployment safety: inspect before changing the server

Run these checks first and review the output before choosing a port or enabling services:

```bash
lsb_release -a
/opt/orbithire-runtime/node-v22.23.5/bin/node --version
/opt/orbithire-runtime/node-v22.23.5/bin/npm --version
sudo systemctl status orbithire-agent.service --no-pager
sudo ss -ltnp
sudo ufw status verbose
```

An inactive/missing OrbitHire unit is expected on first install. Do not stop or reconfigure existing services to make room. Choose a free unprivileged TCP port (`1024`–`65535`) that is not already listening. The installer checks the chosen TCP port again immediately before setup and exits if it is occupied. Example:

```bash
PORT=18787
sudo ss -H -ltn "sport = :${PORT}"
```

No output means no TCP listener was found for that port at check time. If any listener is shown, choose another port. The service binds to loopback by default, so it is not directly reachable from other machines. The port check is a point-in-time check; systemd may still fail to start if another process claims the port later.

## Prerequisites

1. Ubuntu 22.04 LTS with systemd.
2. The isolated official Node.js `v22.23.5` runtime and its bundled npm at `/opt/orbithire-runtime/node-v22.23.5`. The installer and service use these absolute paths; they do not use or change `/usr/bin/node`, `/usr/bin/npm`, or the global `PATH`.
3. `sudo`, `systemctl`, `ss`, `runuser`, and `curl`.
4. Repository checkout containing this `deploy/` folder and the `agent/` package.
5. The OrbitHire testnet contract already deployed and the agent account authorized by that contract.

## Prepare the isolated Node.js runtime

The server's system Node installation is intentionally left unchanged. This package expects Node.js `v22.23.5` under `/opt`; its installer will fail early if either binary is missing. Download the Linux x64 archive only for an x86_64 host; choose the matching official archive for another architecture. Verify the archive against the official release checksum before extracting it:

```bash
set -euo pipefail
NODE_VERSION=v22.23.5
NODE_ARCH=linux-x64
NODE_FILE="node-${NODE_VERSION}-${NODE_ARCH}.tar.xz"
NODE_URL="https://nodejs.org/dist/${NODE_VERSION}"
WORKDIR="$(mktemp -d)"
cd "$WORKDIR"
curl --fail --location --show-error "${NODE_URL}/${NODE_FILE}" -o "$NODE_FILE"
curl --fail --location --show-error "${NODE_URL}/SHASUMS256.txt" -o SHASUMS256.txt
grep -E "  ${NODE_FILE}$" SHASUMS256.txt | sha256sum --check -
sudo install -d -o root -g root -m 0755 "/opt/orbithire-runtime/node-${NODE_VERSION}"
sudo tar --no-same-owner --strip-components=1 -xJf "$NODE_FILE" \
  -C "/opt/orbithire-runtime/node-${NODE_VERSION}"
sudo chown -R root:root "/opt/orbithire-runtime/node-${NODE_VERSION}"
test "$("/opt/orbithire-runtime/node-${NODE_VERSION}/bin/node" --version)" = "$NODE_VERSION"
"/opt/orbithire-runtime/node-${NODE_VERSION}/bin/npm" --version
```

The currently pinned archive is `node-v22.23.5-linux-x64.tar.xz` with SHA-256 `cdeb8670a0c81f51b4dc4ac61919f9b1ad917b304bf8221eb939570663d240f8`. Keep the runtime root-owned and non-writable by the service account. Do not create a symlink under `/usr/bin`, run `update-alternatives`, or alter the system `PATH`; existing applications, including PM2, continue to use their existing Node installation.

## Install the service

From the repository root, select and check a free port. Then pass the **agent package directory**, not the repository root, to the installer:

```bash
PORT=18787
sudo ss -H -ltn "sport = :${PORT}"
sudo bash ./deploy/install.sh "$PWD/agent" "$PORT"
```

The installer refuses to overwrite an existing `/opt/orbithire-agent` installation or unit. It creates:

- Application: `/opt/orbithire-agent/app`
- Persistent JSONL data: `/opt/orbithire-agent/app/data`
- Protected service environment: `/etc/orbithire-agent/agent.env`
- Service account: `orbithire`
- systemd unit: `/etc/systemd/system/orbithire-agent.service`

The environment template is installed with mode `0600`; the service manager reads it before dropping privileges. Edit it locally on the server without printing it or copying its values into chat, shell history, or a repository:

```bash
sudoedit /etc/orbithire-agent/agent.env
```

Set `AGENT_PRIVATE_KEY` using the dedicated agent account key only, and set `ORBIT_HIRE_CONTRACT_ID`, `AGENT_ACCOUNT_ID`, and the exact HTTPS `FRONTEND_ORIGIN`. Enter the real `JEV_API_KEY` if Jev is to run in production; an empty key selects simulation and is **not a security filter**. Do not use the owner's key. Keep the environment file root-owned with mode `0600`.

The installer only enables the service; it deliberately does not start it before you review and configure the environment file. After checking that configuration without displaying its contents:

```bash
sudo systemctl start orbithire-agent.service
sudo systemctl is-active orbithire-agent.service
sudo systemctl status orbithire-agent.service --no-pager
sudo journalctl -u orbithire-agent.service -n 100 --no-pager
```

The unit starts automatically on boot. To stop or disable only this service:

```bash
sudo systemctl stop orbithire-agent.service
sudo systemctl disable orbithire-agent.service
```

## Verify without disturbing other services

Read the selected port from the value you chose above; do not assume `8787` if another port was configured:

```bash
PORT=18787
curl --fail --show-error "http://127.0.0.1:${PORT}/health"
```

Expected response:

```json
{"ok":true,"network":"testnet"}
```

Check a real request ID through the read-only API:

```bash
PORT=18787
REQUEST_ID=550e8400-e29b-41d4-a716-446655440000
curl --include "http://127.0.0.1:${PORT}/api/requests/${REQUEST_ID}"
```

An HTTP 404 with `{"status":"waiting_for_event"}` means the service has not discovered a result for that ID yet; it is not by itself a health failure. Do not use an actual customer's request ID in public logs or messages.

Inspect only the OrbitHire listener when troubleshooting:

```bash
sudo ss -ltnp "sport = :${PORT}"
sudo journalctl -u orbithire-agent.service --since "15 minutes ago" --no-pager
```

Do not kill another process or change another service's configuration to free a port.

## Firewall guidance

The default listener is `127.0.0.1`, intended for a same-host reverse proxy. **Do not add a public UFW rule for the agent port in this mode.** The agent's API should be served to the static HTTPS frontend through HTTPS; exposing the raw HTTP listener is not an acceptable production substitute.

If an operator deliberately changes the service to bind a public interface for a temporary controlled diagnostic, first confirm the security impact and firewall policy. Change only `SERVICE_HOST` in the protected environment file, use a specific trusted source CIDR, and allow only the selected TCP port:

```bash
PORT=18787
sudoedit /etc/orbithire-agent/agent.env
# Change SERVICE_HOST=127.0.0.1 to SERVICE_HOST=0.0.0.0, then save.
sudo systemctl restart orbithire-agent.service
sudo ufw allow from 198.51.100.0/24 to any port "${PORT}" proto tcp
sudo ufw status numbered
```

Replace the example CIDR with the actual trusted source range; `198.51.100.0/24` is documentation-only and is not a real allowlist. Direct HTTP exposure is for controlled diagnostics only, not for the public frontend. Production browser traffic requires HTTPS through a reverse proxy. Do not run `ufw enable`, reset UFW, or alter existing firewall rules as part of this package. The deployment operator must confirm any firewall change before applying it. Remove a rule by its exact rule number only after verifying it belongs to this deployment.

## Optional HTTPS reverse proxy

The frontend requires an HTTPS agent URL and an exact HTTPS `FRONTEND_ORIGIN`. Prefer adding a site to the server's **existing** reverse proxy. Do not install or enable a second Caddy/Nginx instance if ports 80/443 are already used; doing so could disrupt existing websites. Inspect listeners and active services first:

```bash
sudo ss -ltnp '( sport = :80 or sport = :443 )'
sudo systemctl --type=service --state=running --no-pager
```

### Caddy example

Review `Caddyfile.example`, replace `agent.example.com` with the controlled domain, and set its upstream port to the selected `PORT`. Merge the site block into the existing Caddy configuration and validate/reload using that installation's normal procedure. Caddy must be able to obtain a certificate and the domain's DNS must point to this server.

### Nginx example

Review `nginx-site.example`, replace the domain and upstream port, and add it as a site using the existing Nginx layout. Validate with `sudo nginx -t` before reloading Nginx. Configure TLS through the server's established certificate process; do not replace unrelated site configuration.

Only a proxy that is intentionally serving this new domain should expose the corresponding HTTPS virtual host. When using an existing proxy, its firewall and ports are managed at the host level; do not add an extra firewall rule for the loopback agent port.

After HTTPS is working, set `AGENT_API_URL` in the static frontend to the exact HTTPS origin, publish the frontend, and verify CORS with the configured GitHub Pages origin. Do not put keys or tokens in the frontend.

## Safe handoff checklist for the next Copilot instance

Before any server-side deployment, the next operator should:

1. Confirm they are on the intended Ubuntu 22.04 server and inspect existing services, listeners, firewall policy, disk space, the isolated Node runtime, and whether an OrbitHire service already exists. Confirm `/usr/bin/node` remains unchanged.
2. Confirm deployment authorization, the selected free TCP port, and the intended installation directory. Do not stop or repurpose existing services.
3. Review this package and the installer before running it. Run the installer only for a fresh `/opt/orbithire-agent` installation; it intentionally refuses to overwrite an existing one.
4. Obtain the agent private key and Jev API key through the operator's approved secret-handling process. Enter them only with `sudoedit` in `/etc/orbithire-agent/agent.env`. Never display, copy into a prompt, or upload the environment file.
5. Confirm the configured account IDs, testnet contract authorization, frontend origin, and selected port before starting the unit.
6. Start and verify only `orbithire-agent.service`. Configure an HTTPS virtual host only after checking the existing proxy and obtaining approval for DNS/certificate/firewall changes.
7. Verify `/health`, the agent logs, and CORS/result retrieval; then update and publish the frontend's HTTPS `AGENT_API_URL` only after the agent endpoint is ready.

This package prepares files and instructions only. No server, DNS, firewall, systemd service, or secret is modified by preparing it.
