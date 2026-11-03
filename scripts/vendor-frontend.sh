#!/bin/bash
# Download frontend dependencies for offline LAN operation
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENDOR_DIR="${SCRIPT_DIR}/../webapp/vendor"
ESM_BASE="https://esm.sh"
mkdir -p "$VENDOR_DIR"

# Helper: download the actual bundle, not the re-export stub.
# esm.sh returns a stub that re-exports from the real bundle path.
# We read the X-ESM-Path header to find the real bundle URL.
download_bundle() {
  local url="$1"
  local dest="$2"
  local label="$3"

  echo "Downloading ${label}..."
  local bundle_path
  bundle_path=$(curl -sI "${url}" 2>/dev/null | grep -i '^x-esm-path:' | tr -d '\r' | awk '{print $2}' || true)

  if [ -z "$bundle_path" ]; then
    echo "  WARNING: Could not resolve bundle path for ${label}, downloading stub"
    curl -sL "${url}" -o "${dest}"
  else
    curl -sL "${ESM_BASE}${bundle_path}" -o "${dest}"
  fi

  local size
  size=$(wc -c < "${dest}" | tr -d ' ')
  echo "  ${label}: ${size} bytes"
}

download_bundle "${ESM_BASE}/preact@10.29.0?bundle" \
  "$VENDOR_DIR/preact.mjs" "Preact"

download_bundle "${ESM_BASE}/preact@10.29.0/hooks?external=preact&bundle" \
  "$VENDOR_DIR/preact-hooks.mjs" "Preact Hooks"

download_bundle "${ESM_BASE}/@preact/signals@2.8.2?external=preact&bundle" \
  "$VENDOR_DIR/signals.mjs" "Preact Signals"

download_bundle "${ESM_BASE}/htm@3.1.1/preact?external=preact&bundle" \
  "$VENDOR_DIR/htm-preact.mjs" "HTM/Preact"

echo "Frontend dependencies vendored to $VENDOR_DIR"
