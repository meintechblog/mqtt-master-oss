#!/usr/bin/env bash
# ============================================================================
# MQTT Master - Direct Installer (Debian/Ubuntu)
# Installs MQTT Master directly on this machine.
#
# Usage:
#   wget -qO- https://raw.githubusercontent.com/meintechblog/mqtt-master-oss/main/install.sh | bash
#   or:  bash install.sh
#
# For Proxmox (creates an LXC container automatically):
#   wget -qO- https://raw.githubusercontent.com/meintechblog/mqtt-master-oss/main/install-lxc.sh | bash
# ============================================================================
set -euo pipefail

APP_NAME="mqtt-master"
APP_DIR="/opt/mqtt-master"
REPO_URL="https://github.com/meintechblog/mqtt-master-oss.git"
BRANCH="main"
SERVICE_NAME="mqtt-master"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
APP_USER="mqtt-master"
APP_PORT=80
NODE_MAJOR=20

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${BLUE}[MQTT Master]${NC} $1"; }
ok()   { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }

# ---------------------------------------------------------------------------
# Pre-checks
# ---------------------------------------------------------------------------
if [ "$(id -u)" -ne 0 ]; then
    err "This script must be run as root."
fi

# --- Proxmox host detection ---
if command -v pveversion &>/dev/null; then
    echo ""
    echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${RED}  WARNING: This is a Proxmox host!${NC}"
    echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    echo -e "  You should NOT install directly on a Proxmox host."
    echo -e "  Use the LXC installer instead — it creates a container for you:"
    echo ""
    echo -e "  ${GREEN}wget -qO- https://raw.githubusercontent.com/meintechblog/mqtt-master-oss/main/install-lxc.sh | bash${NC}"
    echo ""
    echo -e "  To force direct install anyway, set: ${YELLOW}FORCE_HOST_INSTALL=1${NC}"
    echo ""
    if [ "${FORCE_HOST_INSTALL:-0}" != "1" ]; then
        exit 1
    fi
    warn "FORCE_HOST_INSTALL is set — installing directly on Proxmox host..."
fi

IS_UPDATE=false
if [ -d "${APP_DIR}/.git" ]; then
    IS_UPDATE=true
    log "Existing installation detected — running update..."
else
    log "Starting fresh installation of MQTT Master..."
fi

# ---------------------------------------------------------------------------
# Install Node.js (if needed)
# ---------------------------------------------------------------------------
install_node() {
    if command -v node &>/dev/null; then
        NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
        if [ "${NODE_VER}" -ge "${NODE_MAJOR}" ]; then
            ok "Node.js $(node -v) already installed"
            return
        fi
        log "Node.js $(node -v) is too old, upgrading..."
    fi

    log "Installing Node.js ${NODE_MAJOR}.x..."
    apt-get update -qq
    apt-get install -y -qq ca-certificates curl gnupg > /dev/null 2>&1
    mkdir -p /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg 2>/dev/null
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
    apt-get update -qq
    apt-get install -y -qq nodejs > /dev/null 2>&1
    ok "Node.js $(node -v) installed"
}

# ---------------------------------------------------------------------------
# Install system dependencies
# ---------------------------------------------------------------------------
log "Installing system dependencies..."
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq mosquitto mosquitto-clients git avahi-daemon avahi-utils libnss-mdns > /dev/null 2>&1
# Avahi normally auto-starts on Debian after install; ensure it's enabled for cases
# where a hardened image disables units by default.
systemctl enable --now avahi-daemon >/dev/null 2>&1 || true
ok "System dependencies installed"

install_node

# ---------------------------------------------------------------------------
# Configure Mosquitto (only on fresh install)
# ---------------------------------------------------------------------------
MOSQUITTO_CONF="/etc/mosquitto/conf.d/mqtt-master.conf"
if [ ! -f "${MOSQUITTO_CONF}" ]; then
    log "Configuring Mosquitto for open LAN access..."
    cat > "${MOSQUITTO_CONF}" << 'MQTTEOF'
# MQTT Master - Open LAN Configuration
allow_anonymous true

# MQTT listener on all interfaces
listener 1883 0.0.0.0

# WebSocket listener for web dashboard
listener 9001 0.0.0.0
protocol websockets
MQTTEOF
    systemctl restart mosquitto
    systemctl enable mosquitto
    ok "Mosquitto configured and started"
else
    ok "Mosquitto configuration already exists"
fi

# ---------------------------------------------------------------------------
# Create service user
# ---------------------------------------------------------------------------
if ! id "${APP_USER}" &>/dev/null; then
    useradd --system --no-create-home --shell /usr/sbin/nologin "${APP_USER}"
    ok "Created service user: ${APP_USER}"
fi

# ---------------------------------------------------------------------------
# Clone or update repository
# ---------------------------------------------------------------------------
if [ "${IS_UPDATE}" = true ]; then
    log "Updating from GitHub..."
    cd "${APP_DIR}"
    # The repo is owned by APP_USER (chown happens further down), so root's
    # git refuses to run by default. Mark it safe rather than running git
    # as the service user — the latter requires a usable shell + HOME.
    git config --global --add safe.directory "${APP_DIR}" >/dev/null 2>&1 || true
    git fetch origin "${BRANCH}" --quiet
    git reset --hard "origin/${BRANCH}" --quiet
    ok "Repository updated"
else
    log "Cloning repository..."
    git clone --branch "${BRANCH}" --depth 1 "${REPO_URL}" "${APP_DIR}" --quiet
    # Same reason as the update branch above: the service runs as root but the
    # repo is chown'd to APP_USER, so root's git refuses without this entry.
    git config --global --add safe.directory "${APP_DIR}" >/dev/null 2>&1 || true
    ok "Repository cloned"
fi

# ---------------------------------------------------------------------------
# Install Node.js dependencies
# ---------------------------------------------------------------------------
log "Installing dependencies..."
cd "${APP_DIR}"
npm install --production --quiet 2>&1 | tail -3
ok "Dependencies installed"

# ---------------------------------------------------------------------------
# Write default config (only if missing)
# ---------------------------------------------------------------------------
if [ ! -f "${APP_DIR}/config.json" ]; then
    cat > "${APP_DIR}/config.json" << 'CFGEOF'
{
  "mqtt": { "broker": "mqtt://localhost:1883" },
  "web": { "port": 80 },
  "logLevel": "info"
}
CFGEOF
    ok "Default config created"
else
    # Migrate legacy default port 3000 → 80. Only touches the value when it's
    # exactly the previous default — a customised port (e.g. 8080) is preserved.
    if grep -Eq '"port"[[:space:]]*:[[:space:]]*3000' "${APP_DIR}/config.json"; then
        log "Migrating legacy web.port 3000 → 80..."
        sed -i -E 's/("port"[[:space:]]*:[[:space:]]*)3000/\180/' "${APP_DIR}/config.json"
        ok "Web port migrated to 80"
    fi
fi

# ---------------------------------------------------------------------------
# Set permissions
# ---------------------------------------------------------------------------
chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"

# ---------------------------------------------------------------------------
# Allow Node.js to bind to port 80
# ---------------------------------------------------------------------------
NODE_BIN=$(command -v node)
if [ -n "${NODE_BIN}" ]; then
    setcap cap_net_bind_service=+ep "${NODE_BIN}"
    ok "Node.js allowed to bind port 80"
fi

# ---------------------------------------------------------------------------
# Encryption secret for stored passwords
# ---------------------------------------------------------------------------
# The service refuses to start without ENCRYPTION_SECRET. Created once,
# readable by root only; never overwritten (stored passwords depend on it).
# An existing install with encrypted values stops here instead of getting a
# secret that does not fit them.
bash "${APP_DIR}/scripts/ensure-secret.sh" anlegen "${APP_DIR}/config.json" /etc/mqtt-master/env \
    || err "Encryption secret missing for an existing config - see README.md (section Encryption secret)"
ok "Encryption secret ready"

# ---------------------------------------------------------------------------
# Install / update systemd service
# ---------------------------------------------------------------------------
log "Configuring systemd service..."
cp "${APP_DIR}/scripts/mqtt-master.service" "${SERVICE_FILE}"
# Sibling self-updater unit (triggered on-demand, never enabled).
if [ -f "${APP_DIR}/scripts/update/mqtt-master-updater.service" ]; then
    cp "${APP_DIR}/scripts/update/mqtt-master-updater.service" "/etc/systemd/system/mqtt-master-updater.service"
    chmod +x "${APP_DIR}/scripts/update/run-update.sh" 2>/dev/null || true
    ok "Self-updater unit installed"
fi
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"
ok "Service installed and started"

# ---------------------------------------------------------------------------
# Wait for startup & verify
# ---------------------------------------------------------------------------
sleep 2
if systemctl is-active --quiet "${SERVICE_NAME}"; then
    ok "MQTT Master is running!"
else
    warn "Service may still be starting... check: systemctl status ${SERVICE_NAME}"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
if [ "${IS_UPDATE}" = true ]; then
    echo -e "${GREEN}  MQTT Master updated successfully!${NC}"
else
    echo -e "${GREEN}  MQTT Master installed successfully!${NC}"
fi
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
IP=$(hostname -I | awk '{print $1}')
if [ "${APP_PORT}" = "80" ]; then
    echo -e "  Dashboard:   ${BLUE}http://${IP}${NC}"
else
    echo -e "  Dashboard:   ${BLUE}http://${IP}:${APP_PORT}${NC}"
fi
echo -e "  MQTT Broker: ${BLUE}mqtt://${IP}:1883${NC}"
echo -e "  WebSocket:   ${BLUE}ws://${IP}:9001${NC}"
echo ""
echo -e "  Manage:  ${YELLOW}systemctl {start|stop|restart|status} ${SERVICE_NAME}${NC}"
echo -e "  Logs:    ${YELLOW}journalctl -u ${SERVICE_NAME} -f${NC}"
echo -e "  Config:  ${YELLOW}/opt/mqtt-master/config.json${NC}"
echo ""
echo -e "  Update:  ${YELLOW}wget -qO- https://raw.githubusercontent.com/meintechblog/mqtt-master-oss/main/install.sh | bash${NC}"
echo ""
