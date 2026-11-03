/**
 * Pure logic helpers for the UnifiPorts page.
 *
 * Lives in its own file (separate from unifi-ports.js) so the unit-test
 * harness can import these helpers WITHOUT pulling the Preact runtime —
 * the webapp resolves `htm/preact` via a browser import map, which is
 * unavailable in Node/vitest. Keeping the helpers Preact-free is the
 * cleanest split: the view layer stays a thin renderer over pure data
 * transforms.
 *
 * Test suite: tests/webapp/unifi-ports-logic.test.js
 *
 * Critical invariants pinned here:
 *   - D-GRID-02:  wattage badge thresholds
 *   - T-10-05:    isProtectedKey case-insensitive matcher (Off/Cycle gate)
 *   - T-10-08:    buildCmdTopic by-mac topic shape
 *   - D-TOAST-02: derivePendingTimedOut 10 s threshold
 */

/**
 * D-GRID-02 wattage badge colour:
 *   green  — 0 < W < 25
 *   amber  — W >= 25
 *   grey   — link_up && W === 0       (port up, no PoE draw)
 *   red    — !link_up && poe_mode === 'auto'  (PoE on, no link — possibly tripped)
 *   none   — non-PoE / unknown
 */
export function wattageBadgeClass({ power_w, link_up, poe_mode } = {}) {
  // No poe_mode → not a PoE-capable port. The badge is suppressed visually
  // (no colour). Tests pin this branch.
  if (poe_mode === undefined || poe_mode === null) return 'unifi-ports-badge-none';
  const w = typeof power_w === 'number' ? power_w : NaN;
  if (Number.isFinite(w) && w >= 25) return 'unifi-ports-badge-amber';
  if (Number.isFinite(w) && w > 0)  return 'unifi-ports-badge-green';
  if (link_up === true && (!Number.isFinite(w) || w === 0)) return 'unifi-ports-badge-grey';
  if (link_up === false && poe_mode === 'auto')              return 'unifi-ports-badge-red';
  return 'unifi-ports-badge-none';
}

/**
 * Filter the flat per-port list by the active filter state. Each port carries
 * a `device: { mac, name, nameSlug }` back-reference so the device dropdown
 * can filter without re-walking the device tree.
 *
 * PoE detection signal: presence of `poe_mode` field (the backend's
 * `normalizePort` adds it only on PoE-capable ports — see
 * plugins/unifi/unifi-telemetry.js).
 */
export function applyFilter(ports, filter = {}) {
  const { device = 'all', hasPoE = false, linkUp = false, poeOn = false, q = '' } = filter;
  const qLower = (q || '').toLowerCase();
  return ports.filter((p) => {
    if (device && device !== 'all' && p.device?.name !== device) return false;
    if (hasPoE  && p.poe_mode === undefined) return false;
    if (linkUp  && p.link_up !== true) return false;
    if (poeOn   && p.poe_mode !== 'auto') return false;
    if (qLower) {
      const name = (p.port_name || '').toLowerCase();
      const conn = (p.connected_device || '').toLowerCase();
      if (!name.includes(qLower) && !conn.includes(qLower)) return false;
    }
    return true;
  });
}

/**
 * T-10-05 safety pin: returns true iff (mac, port_idx) is on the
 * getStatus().protectedPorts list. Mac compare is case-insensitive — the
 * hardcoded floor is stored lowercase but LLDP-augmented runtime entries
 * may carry whatever case the controller served (defensive).
 */
export function isProtectedKey(protectedPorts, mac, port_idx) {
  if (!Array.isArray(protectedPorts) || protectedPorts.length === 0) return false;
  const macLower = String(mac || '').toLowerCase();
  const idx = Number(port_idx);
  for (const entry of protectedPorts) {
    if (!entry || typeof entry !== 'object') continue;
    if (String(entry.mac || '').toLowerCase() === macLower && Number(entry.port_idx) === idx) {
      return true;
    }
  }
  return false;
}

/**
 * T-10-08 topic-construction pin. macSlug = lowercased hex with `-` between
 * every byte — matches `macSlug()` in plugins/lib/slug.js so the topic shape
 * is identical to what unifi-poll.js publishes and what the plugin's cmd
 * dispatcher reverses back to a colon-separated MAC.
 *
 *   buildCmdTopic('unifi/', '02:00:00:00:00:FA', 1)
 *     → 'unifi/by-mac/02-00-00-00-00-fa/port/1/cmd'
 *
 * The compact (no-dash) slug looks valid to the plugin's outer regex but
 * its inner `replace(/-/g, ':')` produces a 12-char string with no colons,
 * which then fails the `/^[0-9a-f:]{17}$/` MAC validation and the dispatch
 * short-circuits to status:'unknown_device'. That was the root cause of
 * every "Command sent but no result confirmation received" toast since
 * Phase 10 — fixed here.
 */
export function buildCmdTopic(prefix, mac, port_idx) {
  const hex = String(mac || '').replace(/[:.\-\s]/g, '').toLowerCase();
  if (hex.length !== 12) return `${prefix}by-mac/unknown-mac/port/${port_idx}/cmd`;
  const macSlug = [
    hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6),
    hex.slice(6, 8), hex.slice(8, 10), hex.slice(10, 12),
  ].join('-');
  return `${prefix}by-mac/${macSlug}/port/${port_idx}/cmd`;
}

/**
 * Cmd payload — emits a plain string so the plugin's parsePayload returns
 * the verb directly. Previously this wrapped it as `{verb}` but the plugin
 * only accepts `{action}` or plain-string — `{verb}` returned `null` from
 * parsePayload → status:'invalid_payload'. Plain strings sidestep that
 * envelope mismatch entirely and travel a single code path. Rename uses a
 * dedicated JSON envelope (`{action:'rename', name:'X'}`) published from
 * the page directly, so this helper is on/off/cycle only.
 */
export function buildCmdPayload(verb) {
  return String(verb);
}

/**
 * Maximum time we'll wait for a controller-side write result to land on the
 * MQTT result topic before showing the yellow "no confirmation received"
 * toast. Bumped from 10s after observing UniFi controllers occasionally
 * queue port_overrides RMW writes for 10–20s when the controller is busy
 * (e.g. mid-`Vorbereitung läuft`). 60s comfortably covers the worst case
 * we've seen while still surfacing real failures within a session.
 */
export const PORT_RESULT_TIMEOUT_MS = 60_000;

/**
 * D-TOAST-02 — returns the keys whose `startedAt + PORT_RESULT_TIMEOUT_MS
 * <= nowMs`. Pure function so unit test can pin the boundary (exactly
 * PORT_RESULT_TIMEOUT_MS counts as timed out).
 */
export function derivePendingTimedOut(pending, nowMs) {
  const out = [];
  if (!(pending instanceof Map)) return out;
  for (const [key, val] of pending) {
    if (val && typeof val.startedAt === 'number' && (val.startedAt + PORT_RESULT_TIMEOUT_MS) <= nowMs) {
      out.push(key);
    }
  }
  return out;
}
