#!/usr/bin/env bash
# ============================================================================
# MQTT Master - back-compat install wrapper
#
# The canonical installers now live at the repo root:
#   /install.sh        — direct Debian/Ubuntu install
#   /install-lxc.sh    — Proxmox LXC install (creates a container for you)
#
# Older docs and shell history still reference scripts/install.sh, so this
# wrapper auto-detects the environment and runs the right installer:
#   - Proxmox host  → install-lxc.sh
#   - everywhere else → install.sh
#
# That way the historical command keeps working and never tries to install
# Mosquitto + Node directly on the PVE host (which silently breaks port 80
# binding and clutters the host with services that belong in a container).
# ============================================================================
set -euo pipefail

RAW_BASE="https://raw.githubusercontent.com/meintechblog/mqtt-master-oss/main"

# Colors (best-effort; ignored when the terminal doesn't support them)
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

if [ "$(id -u)" -ne 0 ]; then
    echo -e "${YELLOW}[!]${NC} This installer must run as root."
    exit 1
fi

if command -v pveversion &>/dev/null; then
    echo -e "${BLUE}[MQTT Master]${NC} Proxmox host detected — using the LXC installer."
    echo -e "${BLUE}[MQTT Master]${NC} A Debian container will be created automatically."
    echo ""
    exec bash -c "wget -qO- '${RAW_BASE}/install-lxc.sh' | bash"
fi

echo -e "${BLUE}[MQTT Master]${NC} Running direct installer..."
exec bash -c "wget -qO- '${RAW_BASE}/install.sh' | bash"
