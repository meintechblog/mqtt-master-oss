/**
 * health-digest — pure composition of mqtt-master's cross-plugin health snapshot.
 *
 * Used by `GET /api/health/digest` (server/routes/api-health.js). The Hub
 * (an external monitor) polls this every 60s from each
 * of the operator's mqtt-master boxes, diffs against last state, and pushes
 * notifications on severity transitions.
 *
 * Two layers contribute to the flat `issues[]`:
 *
 *  1. Plugin-liveness — emitted only for "connection-bearing" plugins
 *     (currently `loxone` and `unifi`). Bridge-style plugins (`mqtt-bridge`)
 *     have no liveness surface and contribute only via their bindings.
 *     Reasons (first-match-wins, in priority order):
 *       - start_error      (status=='error')
 *       - not_running      (autoStart && status!=='running')
 *       - connection_lost  (running, !connected, totalConnects>0 OR reconnect>0)
 *       - never_connected  (running, !connected, never connected, no reconnect)
 *
 *  2. Binding-level — passed straight through from
 *     plugins/lib/binding-health.js → aggregateHealth(stats). We enrich each
 *     issue with `plugin` (pluginId), `kind:'binding'`, and `last_event`
 *     (ISO-8601 from stat.lastReceivedAt or null).
 *
 * `ok_count` = (enabled bindings with severity=='ok' across all plugins)
 *            + (running plugins with healthy liveness AND a connection field)
 *
 * The function is pure: no Node IO, no Fastify; everything it needs is
 * injected (plugins list, getStatsForPlugin, getAutoStart, logger, now,
 * box/host metadata). All timing comes from the `now` arg so tests are
 * deterministic. Fastify glue lives in routes/api-health.js.
 *
 * One bad plugin must NOT 500 the whole endpoint — per-plugin try/catch
 * logs and skips. The Hub depends on this digest staying available.
 */

import { aggregateHealth } from '../../plugins/lib/binding-health.js';

/**
 * Plugin types that expose a `connection` object (loxone-ws, unifi-client).
 * Bridge-style plugins (mqtt-bridge) are intentionally excluded — their health
 * is fully represented by their bindings.
 */
const CONNECTION_BEARING_TYPES = new Set(['loxone', 'unifi']);

/** Cap for start_error detail to keep notification messages bounded. */
const START_ERROR_DETAIL_MAX = 200;

/** German detail strings — match the binding-health voice. */
const PLUGIN_DETAILS = {
  not_running: 'Plugin läuft nicht (autoStart=true)',
  start_error_fallback: 'Plugin-Start fehlgeschlagen',
  connection_lost: 'Verbindung verloren (Reconnect läuft)',
  never_connected: 'Noch nie verbunden — Konfiguration prüfen',
};

/**
 * Resolve the box label using a fixed precedence:
 *   1. user-set config field `box`
 *   2. env var MQTT_MASTER_BOX
 *   3. os.hostname()
 *
 * Empty strings are treated as unset so a stray empty config value doesn't
 * blank out the box name in Hub alerts.
 *
 * @param {{ configBox?: string|null, envBox?: string, hostname: string }} input
 * @returns {string}
 */
export function resolveBoxLabel({ configBox, envBox, hostname }) {
  return (configBox && String(configBox)) ||
         (envBox && String(envBox)) ||
         hostname;
}

/**
 * Decide whether plugin-liveness applies to this plugin.
 *
 * The branch is active iff:
 *  - the plugin already has a `connection` object on its listAll() entry, OR
 *  - the plugin's `type` is in CONNECTION_BEARING_TYPES (so we can still
 *    diagnose `start_error` / `not_running` when there is no live instance
 *    and therefore no connection field yet).
 *
 * Bridge plugins (`mqtt-bridge`) never pass — their health is purely binding.
 */
function isConnectionBearing(plugin) {
  if (plugin && plugin.connection && typeof plugin.connection === 'object') return true;
  return CONNECTION_BEARING_TYPES.has(plugin?.type);
}

/**
 * Compute the plugin-liveness contribution for one plugin.
 * Returns either { issue, okBump:0 } when a fault is detected,
 * or { issue:null, okBump:1 } for a healthy connected plugin,
 * or { issue:null, okBump:0 } when liveness does not apply / no fault to
 * report (e.g. running+connected on a plugin without `connection` field).
 */
function evaluatePluginLiveness(plugin, getAutoStart) {
  if (!isConnectionBearing(plugin)) {
    return { issue: null, okBump: 0 };
  }

  const label = plugin.displayName || plugin.name || plugin.id;

  // (a) start_error — first-match wins.
  if (plugin.status === 'error') {
    const raw = plugin.error || PLUGIN_DETAILS.start_error_fallback;
    const detail = raw.length > START_ERROR_DETAIL_MAX
      ? raw.slice(0, START_ERROR_DETAIL_MAX)
      : raw;
    return {
      issue: {
        plugin: plugin.id,
        kind: 'plugin',
        id: plugin.id,
        severity: 'error',
        label,
        reason: 'start_error',
        detail,
        last_event: null,
      },
      okBump: 0,
    };
  }

  // (b) not_running — autoStart wants it up, but it isn't.
  if (getAutoStart(plugin.id) === true && plugin.status !== 'running') {
    return {
      issue: {
        plugin: plugin.id,
        kind: 'plugin',
        id: plugin.id,
        severity: 'error',
        label,
        reason: 'not_running',
        detail: PLUGIN_DETAILS.not_running,
        last_event: null,
      },
      okBump: 0,
    };
  }

  // (c) / (d) — connection branch: running, but we have a connection object
  // and it tells us we're down.
  if (plugin.status === 'running' && plugin.connection) {
    const c = plugin.connection;
    if (c.connected === false) {
      const totalConnects = Number(c.totalConnects) || 0;
      const reconnect = Number(c.currentReconnectAttempt) || 0;
      if (totalConnects > 0 || reconnect > 0) {
        // (c) connection_lost — was up at some point, now reconnecting.
        const lastDisconnect = (typeof c.lastDisconnectAt === 'number' && c.lastDisconnectAt > 0)
          ? new Date(c.lastDisconnectAt).toISOString()
          : null;
        return {
          issue: {
            plugin: plugin.id,
            kind: 'plugin',
            id: plugin.id,
            severity: 'error',
            label,
            reason: 'connection_lost',
            detail: PLUGIN_DETAILS.connection_lost,
            last_event: lastDisconnect,
          },
          okBump: 0,
        };
      }
      // (d) never_connected — running, but no successful connect ever.
      return {
        issue: {
          plugin: plugin.id,
          kind: 'plugin',
          id: plugin.id,
          severity: 'warn',
          label,
          reason: 'never_connected',
          detail: PLUGIN_DETAILS.never_connected,
          last_event: null,
        },
        okBump: 0,
      };
    }
    if (c.connected === true) {
      // Healthy at the liveness layer — counts toward ok_count.
      return { issue: null, okBump: 1 };
    }
  }

  // Stopped-on-purpose (autoStart!==true, status='stopped', not in error),
  // or connection-bearing type with no connection object yet and not in error:
  // contributes nothing.
  return { issue: null, okBump: 0 };
}

/**
 * Compose mqtt-master's cross-plugin health digest. Pure: every external
 * dependency is injected.
 *
 * @param {object} input
 * @param {Array<object>} input.plugins        listAll()-shaped entries
 * @param {(pluginId:string) => (object[]|null)} input.getStatsForPlugin
 * @param {string|null|undefined} input.configBox
 * @param {string|undefined} input.envBox
 * @param {string} input.hostname
 * @param {string} input.host                  first non-internal IPv4 or hostname
 * @param {number} input.now                   epoch ms
 * @param {(pluginId:string) => boolean} input.getAutoStart
 * @param {{ warn: (msg:string) => void }} input.logger
 * @returns {{ box:string, host:string, checked_at:string, ok_count:number, issues:object[] }}
 */
export function composeHealthDigest({
  plugins,
  getStatsForPlugin,
  configBox,
  envBox,
  hostname,
  host,
  now,
  getAutoStart,
  logger,
}) {
  const box = resolveBoxLabel({ configBox, envBox, hostname });
  const checked_at = new Date(now).toISOString();

  const issues = [];
  let ok_count = 0;

  const list = Array.isArray(plugins) ? plugins : [];

  for (const plugin of list) {
    // Stage this plugin's contribution in locals so a throw anywhere in the
    // block discards the WHOLE plugin (no half-counted state). The Hub treats
    // a missing plugin as "skipped this cycle" — much safer than partial data.
    let pluginIssues = [];
    let pluginOk = 0;
    try {
      // Plugin-liveness branch (no-op for bridge-style plugins).
      const live = evaluatePluginLiveness(plugin, getAutoStart);
      if (live.issue) pluginIssues.push(live.issue);
      pluginOk += live.okBump;

      // Binding branch — applies to every plugin id regardless of type.
      const stats = getStatsForPlugin(plugin.id);
      if (Array.isArray(stats) && stats.length > 0) {
        const health = aggregateHealth(stats, now);
        pluginOk += health.counts.ok || 0;
        for (const i of health.issues) {
          // Linear scan — bindings per plugin stay small.
          const stat = stats.find((s) => s && s.id === i.id) || null;
          const lastEvent = stat && typeof stat.lastReceivedAt === 'number' && stat.lastReceivedAt > 0
            ? new Date(stat.lastReceivedAt).toISOString()
            : null;
          pluginIssues.push({
            plugin: plugin.id,
            kind: 'binding',
            id: i.id,
            severity: i.severity,
            label: i.label,
            reason: i.reason,
            detail: i.detail,
            last_event: lastEvent,
          });
        }
      }
    } catch (err) {
      // One bad plugin must not take down the Hub's status feed.
      logger.warn(`health/digest: skipped plugin '${plugin?.id ?? '?'}': ${err.message}`);
      continue; // drop staged contribution
    }
    // Commit staged contribution only after the whole block succeeded.
    for (const i of pluginIssues) issues.push(i);
    ok_count += pluginOk;
  }

  // Stable ordering: error before warn; within same severity, plugin before
  // binding (the whole connection dying is more actionable than one
  // individual stat). Then by plugin id for determinism across boxes.
  issues.sort((a, b) => {
    const sa = a.severity === 'error' ? 0 : 1;
    const sb = b.severity === 'error' ? 0 : 1;
    if (sa !== sb) return sa - sb;
    const ka = a.kind === 'plugin' ? 0 : 1;
    const kb = b.kind === 'plugin' ? 0 : 1;
    if (ka !== kb) return ka - kb;
    return String(a.plugin).localeCompare(String(b.plugin));
  });

  return { box, host, checked_at, ok_count, issues };
}
