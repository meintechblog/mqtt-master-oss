/**
 * UniFi device structure snapshot + diff.
 *
 * MAC-keyed analogue of plugins/loxone/structure-monitor.js. Pure functions:
 * no fetch, no MQTT, no timers — Plan 08-02 wires the diff result into the
 * structure-monitor lifecycle and the mqttService retain-clear loop.
 *
 * Per D-S-01..D-S-03 the diff classifies events into four buckets:
 *   - added:     present in next, absent from prev
 *   - renamed:   present in both, same MAC, different nameSlug
 *                (carries oldNameSlug + newNameSlug so caller can retain-clear
 *                 the old slug-based state topics — NEVER cmd topics)
 *   - removed:   present in prev, absent from next (carries the PREV entry)
 *   - unchanged: present in both, same MAC, same nameSlug
 *
 * MAC is the stable identity. Slug stability is a derived concern; a pure
 * model-case change with the same name does NOT trigger a rename.
 */
import { slugify, macSlug } from '../lib/slug.js';

/**
 * @typedef {Object} StructureSnapshotEntry
 * @property {string} mac          Lowercase MAC.
 * @property {string} name         Raw name from controller.
 * @property {string} nameSlug     slugify(name); falls back to macSlug(mac) when name is empty.
 * @property {string} model        UniFi model code (e.g. "UCGMAX", "USPM16P", "U6P").
 * @property {string} type         Raw type field from controller ("udm" / "usw" / "uap").
 * @property {number} portCount    port_table.length (0 for AP / non-port devices).
 * @property {string|null} _id     Mongo object-id from /stat/device. Needed for the
 *                                 port_overrides RMW path on UCG-MAX / newer firmware
 *                                 where /rest/device/{mac} 404s — only /rest/device/{_id}
 *                                 is accepted (see project_open_bug_unifi_rest_404).
 */

/**
 * @typedef {Object} StructureDiff
 * @property {Array<StructureSnapshotEntry>} added
 * @property {Array<{mac:string, oldNameSlug:string, newNameSlug:string, entry:StructureSnapshotEntry}>} renamed
 * @property {Array<StructureSnapshotEntry>} removed   Carries the PREV entry.
 * @property {number} unchanged
 */

/**
 * Build a snapshot Map<mac, StructureSnapshotEntry> from a /stat/device response array.
 *
 * Defensive: non-array input → empty Map. Entries missing the `mac` field are
 * silently skipped (the controller-side bug, not ours; structure-monitor logs).
 *
 * @param {Array<object>|null|undefined} rawDeviceList    Typically `body.data` from /stat/device.
 * @param {{logger?: object}} [opts]                      Optional logger for skip-warnings.
 * @returns {Map<string, StructureSnapshotEntry>}
 */
export function snapshotDevices(rawDeviceList, opts = {}) {
  const out = new Map();
  if (!Array.isArray(rawDeviceList)) return out;

  for (const raw of rawDeviceList) {
    if (!raw || typeof raw !== 'object') continue;
    if (typeof raw.mac !== 'string' || raw.mac.length === 0) {
      opts.logger?.warn?.(`[unifi-structure] device entry skipped — missing mac (name=${raw.name ?? '?'})`);
      continue;
    }
    const mac = raw.mac.toLowerCase();
    const name = typeof raw.name === 'string' ? raw.name : '';
    // Empty name → slug derived from mac so topics are still stable.
    const nameSlug = name ? slugify(name) : macSlug(mac);
    out.set(mac, {
      mac,
      name,
      nameSlug,
      model: typeof raw.model === 'string' ? raw.model : '',
      type: typeof raw.type === 'string' ? raw.type : '',
      portCount: Array.isArray(raw.port_table) ? raw.port_table.length : 0,
      _id: typeof raw._id === 'string' && raw._id.length > 0 ? raw._id : null,
    });
  }
  return out;
}

/**
 * Diff two snapshots by MAC.
 *
 * Renames are detected when the same MAC has a different `nameSlug` between
 * prev and next. Removals carry the OLD entry so the caller can retain-clear
 * topics keyed on the old slug. Iteration order: `added` and `renamed` follow
 * Map iteration of `next`; `removed` follows Map iteration of `prev`. This is
 * deterministic for the same inputs (Map preserves insertion order).
 *
 * @param {Map<string, StructureSnapshotEntry>|null|undefined} prev   Pass null on first call.
 * @param {Map<string, StructureSnapshotEntry>} next
 * @returns {StructureDiff}
 */
export function diffStructure(prev, next) {
  const prevMap = prev instanceof Map ? prev : new Map();
  const nextMap = next instanceof Map ? next : new Map();

  const added = [];
  const renamed = [];
  const removed = [];
  let unchanged = 0;

  // Walk `next` to classify added / renamed / unchanged.
  for (const [mac, entry] of nextMap) {
    const prevEntry = prevMap.get(mac);
    if (!prevEntry) {
      added.push(entry);
    } else if (prevEntry.nameSlug !== entry.nameSlug) {
      renamed.push({
        mac,
        oldNameSlug: prevEntry.nameSlug,
        newNameSlug: entry.nameSlug,
        entry,
      });
    } else {
      unchanged++;
    }
  }

  // Walk `prev` to find removals.
  for (const [mac, prevEntry] of prevMap) {
    if (!nextMap.has(mac)) {
      removed.push(prevEntry);
    }
  }

  return { added, renamed, removed, unchanged };
}
