/**
 * api-health — `GET /api/health/digest`.
 *
 * Compact, cross-plugin health snapshot for Hub-side polling. The Hub
 * (an external monitor) polls this every 60s from each
 * mqtt-master box, diffs against last state, and pushes notifications
 * on severity transitions.
 *
 * Wiring is intentionally dumb glue — all logic lives in
 * server/services/health-digest.js (pure, unit-tested). This route only:
 *   1. Gathers the inputs (plugins list, stats accessor, autoStart accessor,
 *      box/host/hostname/env),
 *   2. Calls composeHealthDigest(),
 *   3. Returns the result as JSON.
 *
 * Response time target <100ms — there are no awaits, fetches, or filesystem
 * reads inside the digest. Everything is composed from already-in-memory
 * state (PluginManager + ConfigService).
 *
 * Box label resolution: configService.get('box', null) → env MQTT_MASTER_BOX
 * → os.hostname(). The `box` field is purely opt-in — there is no schema
 * entry in plugin templates; the operator sets it per box via direct config edit
 * or the existing config UI (top-level field).
 */

import { hostname, networkInterfaces } from 'node:os';
import {
  composeHealthDigest,
  resolveBoxLabel as _resolveBoxLabel,
} from '../services/health-digest.js';

// Re-import resolveBoxLabel only to fail loudly at boot if the named export
// ever disappears. composeHealthDigest already calls it internally.
void _resolveBoxLabel;

/**
 * First non-internal IPv4 across all network interfaces. Falls back to the
 * hostname when nothing useful is bound (e.g. inside a container without a
 * routable interface). Self-contained — the api-system route has its own
 * collector for richer LAN-info output; this one only needs the first IP.
 */
function firstLanIpv4() {
  const ifaces = networkInterfaces();
  for (const [, addrs] of Object.entries(ifaces || {})) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return hostname();
}

/**
 * Read `getInputBindingStats()` off the live instance if available. Returns
 * null when the plugin is stopped or doesn't expose the method (caller
 * treats null as "no binding contribution from this plugin").
 */
function makeGetStatsForPlugin(app) {
  return function getStatsForPlugin(pluginId) {
    const inst = app.pluginManager.getInstance?.(pluginId);
    if (inst && typeof inst.getInputBindingStats === 'function') {
      return inst.getInputBindingStats();
    }
    return null;
  };
}

/**
 * `plugins.<id>.autoStart` reads-through to ConfigService — same path
 * PluginManager.discover() uses. Truthy means "the user wants this plugin
 * running"; needed so we can distinguish `not_running` (auto-start wants
 * it up, it's down) from `stopped-on-purpose` (user disabled it).
 */
function makeGetAutoStart(app) {
  return function getAutoStart(pluginId) {
    return !!app.configService.get(`plugins.${pluginId}.autoStart`, false);
  };
}

export default async function apiHealth(app) {
  // GET /api/health/digest -- cross-plugin health snapshot for Hub polling.
  //
  // Returns the shape agreed with the Hub team on 2026-05-28:
  //   { box, host, checked_at, ok_count, issues:[{ plugin, kind, id,
  //     severity, label, reason, detail, last_event }, ...] }
  //
  // All timestamps are ISO-8601 with the Z suffix. Plugin-liveness is only
  // applied to connection-bearing plugins (loxone, unifi); mqtt-bridge
  // contributes only via its bindings. One bad plugin cannot 500 this
  // endpoint — composeHealthDigest catches per-plugin throws and logs via
  // app.log.warn.
  app.get('/api/health/digest', async () => {
    const now = Date.now();
    const plugins = await app.pluginManager.listAll();
    const configBox = app.configService.get('box', null);
    const envBox = process.env.MQTT_MASTER_BOX || undefined;
    return composeHealthDigest({
      plugins,
      getStatsForPlugin: makeGetStatsForPlugin(app),
      configBox,
      envBox,
      hostname: hostname(),
      host: firstLanIpv4(),
      now,
      getAutoStart: makeGetAutoStart(app),
      logger: app.log,
    });
  });
}
