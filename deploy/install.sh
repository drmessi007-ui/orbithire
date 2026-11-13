#!/usr/bin/env bash
set -Eeuo pipefail

readonly SERVICE_NAME="orbithire-agent"
readonly SERVICE_USER="orbithire"
readonly INSTALL_ROOT="/opt/orbithire-agent"
readonly APP_DIR="${INSTALL_ROOT}/app"
readonly ENV_DIR="/etc/orbithire-agent"
readonly ENV_FILE="${ENV_DIR}/agent.env"
readonly UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
readonly NODE_HOME="/opt/orbithire-runtime/node-v22.23.5"
readonly NODE_BIN="${NODE_HOME}/bin/node"
readonly NPM_BIN="${NODE_HOME}/bin/npm"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

if [[ "${EUID}" -ne 0 ]]; then
  fail "Run with sudo: sudo bash $0 /path/to/repository/agent FREE_PORT"
fi

if [[ "$#" -ne 2 ]]; then
  fail "Usage: sudo bash $0 /absolute/path/to/repository/agent FREE_PORT"
fi

SOURCE_DIR="$1"
PORT="$2"
DEPLOY_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

[[ "$SOURCE_DIR" = /* ]] || fail "The agent source path must be absolute."
[[ -d "$SOURCE_DIR" ]] || fail "Agent source directory does not exist."
SOURCE_DIR="$(cd -- "$SOURCE_DIR" && pwd)"

for required_file in package.json package-lock.json; do
  [[ -f "${SOURCE_DIR}/${required_file}" ]] ||
    fail "Missing ${required_file} in the agent source directory."
done
[[ -d "${SOURCE_DIR}/src" ]] || fail "Missing src/ in the agent source directory."
[[ -f "${DEPLOY_DIR}/orbithire-agent.service" ]] ||
  fail "Missing systemd unit beside the installer."
[[ -f "${DEPLOY_DIR}/agent.env.example" ]] ||
  fail "Missing environment template beside the installer."

[[ "$PORT" =~ ^[0-9]{1,5}$ ]] || fail "Port must be a decimal TCP port."
(( PORT >= 1024 && PORT <= 65535 )) ||
  fail "Choose an unprivileged TCP port between 1024 and 65535."

[[ -x "$NODE_BIN" ]] || fail "Node.js 22 must be installed at ${NODE_BIN}."
[[ -x "$NPM_BIN" ]] || fail "npm must be installed at ${NPM_BIN}."
[[ -x /usr/bin/systemctl ]] || fail "systemd/systemctl is required."
command -v ss >/dev/null 2>&1 || fail "The ss command is required (install iproute2)."
command -v runuser >/dev/null 2>&1 || fail "The runuser command is required."

NODE_VERSION="$("$NODE_BIN" --version)"
[[ "$NODE_VERSION" =~ ^v([0-9]+)\. ]] || fail "Unable to parse Node.js version: ${NODE_VERSION}"
(( BASH_REMATCH[1] >= 22 )) ||
  fail "Node.js 22 or newer is required; found ${NODE_VERSION}."

[[ ! -e "$INSTALL_ROOT" ]] ||
  fail "${INSTALL_ROOT} already exists. Review the existing installation; this installer will not overwrite it."
[[ ! -e "$UNIT_FILE" ]] ||
  fail "${UNIT_FILE} already exists. Review the existing service; this installer will not overwrite it."
[[ ! -e "$ENV_DIR" ]] ||
  fail "${ENV_DIR} already exists. Review it manually; this installer will not modify an existing environment directory."
if getent passwd "$SERVICE_USER" >/dev/null 2>&1; then
  fail "System user '${SERVICE_USER}' already exists. Verify it belongs to this deployment before proceeding."
fi

LISTENERS="$(ss -H -ltn "sport = :${PORT}")"
[[ -z "$LISTENERS" ]] ||
  fail "TCP port ${PORT} is already listening. Choose another port; no process was stopped."

printf 'Installing %s on loopback TCP port %s\n' "$SERVICE_NAME" "$PORT"
printf 'Application path: %s\n' "$APP_DIR"
printf 'The installer will not change firewall rules or start a reverse proxy.\n'

groupadd --system "$SERVICE_USER"
useradd \
  --system \
  --gid "$SERVICE_USER" \
  --home-dir /var/lib/orbithire-agent \
  --create-home \
  --shell /usr/sbin/nologin \
  "$SERVICE_USER"

install -d -o root -g root -m 0755 "$INSTALL_ROOT"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "${APP_DIR}/src"
install -o root -g root -m 0644 "${DEPLOY_DIR}/README-deploy.md" \
  "${INSTALL_ROOT}/README-deploy.md"
install -m 0644 "${SOURCE_DIR}/package.json" "${APP_DIR}/package.json"
install -m 0644 "${SOURCE_DIR}/package-lock.json" "${APP_DIR}/package-lock.json"
cp -a "${SOURCE_DIR}/src/." "${APP_DIR}/src/"
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"

printf 'Installing production dependencies as the unprivileged service user...\n'
runuser -u "$SERVICE_USER" -- env \
  "PATH=${NODE_HOME}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  "$NPM_BIN" ci --omit=dev --prefix "$APP_DIR"

chown -R root:root "$APP_DIR"
chmod -R a+rX,go-w "$APP_DIR"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0700 "${APP_DIR}/data"

install -d -o root -g root -m 0750 "$ENV_DIR"
TEMP_ENV="$(mktemp)"
trap 'rm -f -- "${TEMP_ENV:-}"' EXIT
sed "s/^SERVICE_PORT=.*/SERVICE_PORT=${PORT}/" "${DEPLOY_DIR}/agent.env.example" > "$TEMP_ENV"
install -o root -g root -m 0600 "$TEMP_ENV" "$ENV_FILE"
rm -f -- "$TEMP_ENV"
trap - EXIT

install -o root -g root -m 0644 \
  "${DEPLOY_DIR}/orbithire-agent.service" "$UNIT_FILE"
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}.service"

cat <<EOF

Installation prepared. The service is enabled but has NOT been started.
Next, edit the protected environment file on this server:
  sudoedit ${ENV_FILE}

Set the authorized agent private key and verify the account, contract,
frontend origin, and SERVICE_PORT=${PORT}. Do not display or copy the file.
Then start and inspect only this service:
  sudo systemctl start ${SERVICE_NAME}.service
  sudo systemctl status ${SERVICE_NAME}.service --no-pager
  curl --fail --show-error http://127.0.0.1:${PORT}/health

No firewall rules or reverse-proxy configuration were changed.
EOF
