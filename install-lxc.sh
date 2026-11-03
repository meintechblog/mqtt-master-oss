#!/bin/bash
# ============================================================================
# MQTT Master - Proxmox LXC Installer
# Creates a Debian LXC container on Proxmox and installs MQTT Master inside.
#
# Usage (run on Proxmox host as root):
#   wget -qO- https://raw.githubusercontent.com/meintechblog/mqtt-master-oss/main/install-lxc.sh | bash
#   or:  bash install-lxc.sh
#
# Options (environment variables):
#   CTID=200              - Container ID (default: next available)
#   CT_HOSTNAME=mqtt      - Container hostname (default: mqtt-master)
#   CT_MEMORY=1024        - Memory in MB (default: 1024)
#   CT_SWAP=512           - Swap in MB (default: 512)
#   CT_DISK=8             - Disk size in GB (default: 8)
#   CT_BRIDGE=vmbr0       - Network bridge (default: vmbr0)
#   CT_STORAGE=local-lvm  - Storage backend (default: local-lvm)
# ============================================================================
set -euo pipefail

# --- Configuration (override via environment) ---
CT_HOSTNAME="${CT_HOSTNAME:-mqtt-master}"
CT_MEMORY="${CT_MEMORY:-1024}"
CT_SWAP="${CT_SWAP:-512}"
CT_DISK="${CT_DISK:-8}"
CT_BRIDGE="${CT_BRIDGE:-vmbr0}"
CT_STORAGE="${CT_STORAGE:-local-lvm}"
TEMPLATE_STORAGE="local"
INSTALL_SCRIPT_URL="https://raw.githubusercontent.com/meintechblog/mqtt-master-oss/main/install.sh"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${BLUE}[MQTT Master LXC]${NC} $1"; }
ok()   { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }

# ---------------------------------------------------------------------------
# Pre-checks
# ---------------------------------------------------------------------------
if [ "$(id -u)" -ne 0 ]; then
    err "This script must be run as root on a Proxmox host."
fi

if ! command -v pveversion &>/dev/null; then
    err "This is not a Proxmox host. Use install.sh for direct Debian installation."
fi

PVE_VER=$(pveversion | grep -oP 'pve-manager/\K[0-9]+\.[0-9]+')
log "Detected Proxmox VE ${PVE_VER}"

# ---------------------------------------------------------------------------
# Find next available CTID
# ---------------------------------------------------------------------------
if [ -z "${CTID:-}" ]; then
    CTID=200
    while pct status "$CTID" &>/dev/null; do
        CTID=$((CTID + 1))
    done
fi

if pct status "$CTID" &>/dev/null; then
    err "Container ID ${CTID} already exists. Set CTID=<id> to use a different ID."
fi

log "Using Container ID: ${CTID}"

# ---------------------------------------------------------------------------
# Download Debian template
# ---------------------------------------------------------------------------
log "Checking for Debian template..."
TEMPLATE=$(pveam list "${TEMPLATE_STORAGE}" 2>/dev/null | grep -oP 'debian-12-standard_[^\s]+' | sort -V | tail -1 || true)

if [ -z "${TEMPLATE}" ]; then
    log "No local template found. Downloading Debian 12..."
    pveam update >/dev/null 2>&1 || true
    TEMPLATE_NAME=$(pveam available --section system 2>/dev/null | grep -oP 'debian-12-standard_[^\s]+' | sort -V | tail -1 || true)
    if [ -z "${TEMPLATE_NAME}" ]; then
        err "No Debian 12 template found. Download one manually via Proxmox web UI."
    fi
    log "Downloading ${TEMPLATE_NAME}..."
    pveam download "${TEMPLATE_STORAGE}" "${TEMPLATE_NAME}"
    TEMPLATE="${TEMPLATE_NAME}"
fi

ok "Template: ${TEMPLATE}"

# ---------------------------------------------------------------------------
# Create LXC container
# ---------------------------------------------------------------------------
log "Creating LXC container ${CTID} (${CT_HOSTNAME})..."

pct create "${CTID}" "${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE}" \
    --hostname "${CT_HOSTNAME}" \
    --memory "${CT_MEMORY}" \
    --swap "${CT_SWAP}" \
    --rootfs "${CT_STORAGE}:${CT_DISK}" \
    --net0 "name=eth0,bridge=${CT_BRIDGE},ip=dhcp" \
    --ostype debian \
    --unprivileged 1 \
    --features nesting=1 \
    --onboot 1 \
    --start 0

ok "Container created"

# ---------------------------------------------------------------------------
# Start container
# ---------------------------------------------------------------------------
log "Starting container..."
pct start "${CTID}"

# Wait for network (DHCP)
log "Waiting for network..."
for i in $(seq 1 30); do
    CT_IP=$(pct exec "${CTID}" -- hostname -I 2>/dev/null | awk '{print $1}')
    if [ -n "${CT_IP}" ]; then
        break
    fi
    sleep 1
done

if [ -z "${CT_IP:-}" ]; then
    warn "Could not detect container IP. Container is running but DHCP may still be pending."
    CT_IP="<pending>"
fi

ok "Container started (IP: ${CT_IP})"

# ---------------------------------------------------------------------------
# Install MQTT Master inside the container
# ---------------------------------------------------------------------------
log "Installing MQTT Master inside container..."

pct exec "${CTID}" -- bash -c "apt-get update -qq && apt-get install -y -qq wget >/dev/null 2>&1"
pct exec "${CTID}" -- bash -c "wget -qO- '${INSTALL_SCRIPT_URL}' | bash"

ok "MQTT Master installed inside container"

# ---------------------------------------------------------------------------
# Get final IP (DHCP might have resolved by now)
# ---------------------------------------------------------------------------
CT_IP=$(pct exec "${CTID}" -- hostname -I 2>/dev/null | awk '{print $1}')

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  MQTT Master LXC Container ready!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  Container ID:  ${BLUE}${CTID}${NC}"
echo -e "  Hostname:      ${BLUE}${CT_HOSTNAME}${NC}"
echo -e "  IP Address:    ${BLUE}${CT_IP}${NC}"
echo ""
echo -e "  Dashboard:     ${BLUE}http://${CT_IP}${NC}"
echo -e "  MQTT Broker:   ${BLUE}mqtt://${CT_IP}:1883${NC}"
echo -e "  WebSocket:     ${BLUE}ws://${CT_IP}:9001${NC}"
echo ""
echo -e "  Container:     ${YELLOW}pct enter ${CTID}${NC}"
echo -e "  Logs:          ${YELLOW}pct exec ${CTID} -- journalctl -u mqtt-master -f${NC}"
echo -e "  Stop:          ${YELLOW}pct stop ${CTID}${NC}"
echo -e "  Destroy:       ${YELLOW}pct stop ${CTID} && pct destroy ${CTID}${NC}"
echo ""
