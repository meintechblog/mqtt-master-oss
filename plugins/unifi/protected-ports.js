/**
 * Protected-port safety allowlist for the UniFi plugin.
 *
 * SAFETY INVARIANT (verbatim from 07-CONTEXT.md `<domain>`):
 *   "niemals poe port 1 ausschalten (zumindest nicht permanent) weil da der
 *    unifi router dranhängt"
 *
 * The UniFi gateway (UCG-MAX `Gateway1`, the controller itself) is connected
 * through Main/USPM16P port 1. Switching it off — even briefly via a `cycle`
 * verb — severs the management plane mid-operation, after which no further
 * commands of any kind can be issued. Recovery requires physical access.
 *
 * This module ships in Phase 7 (auth foundation) so that Phase 9 (PoE control)
 * CANNOT regress: any `off` or `cycle` write path must consult `isProtectedPort`
 * BEFORE issuing an outbound HTTPS request. A future LLDP-based auto-detection
 * (UNIFI-21) may ADD protected entries, but never remove the hardcoded floor.
 *
 * See:
 *   - threat T-07-05 (EoP via controller-uplink off/cycle)
 */

/**
 * @typedef {Object} ProtectedPortEntry
 * @property {string} mac        Lowercase MAC address of the switch/device hosting the port.
 * @property {number} port_idx   1-based port index (matches UniFi API `port_idx` field).
 * @property {string} label      Human-readable description for UI tooltips.
 */

/** @type {ReadonlyArray<ProtectedPortEntry>} */
export const PROTECTED_PORTS = Object.freeze([
  Object.freeze({
    mac: '02:00:00:00:00:fa',
    port_idx: 1,
    label: 'Main switch — controller uplink (dev UDM)',
  }),
]);

/**
 * Returns true if the given (mac, port_idx) pair is on the protected allowlist.
 *
 * MAC comparison is case-insensitive — UI surfaces may pass uppercase forms,
 * but the underlying allowlist is stored lowercase. Both sides are normalised
 * before the comparison so this function is safe to call from any layer.
 *
 * @param {string} mac          MAC address (any case).
 * @param {number} port_idx     1-based port index.
 * @returns {boolean}           true if the pair is protected.
 */
export function isProtectedPort(mac, port_idx) {
  if (typeof mac !== 'string' || typeof port_idx !== 'number') return false;
  const needle = mac.toLowerCase();
  for (const entry of PROTECTED_PORTS) {
    if (entry.mac === needle && entry.port_idx === port_idx) {
      return true;
    }
  }
  return false;
}
