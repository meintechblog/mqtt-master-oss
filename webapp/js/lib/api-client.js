/**
 * REST API client helpers for plugin management.
 * Thin fetch wrappers around /api/plugins endpoints.
 */

async function request(url, options = {}) {
  const headers = {};
  // Only set JSON content-type when there's actually a body to send
  if (options.body) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, {
    headers,
    ...options,
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return body;
}

/** GET /api/plugins -- list all plugins with status */
export function fetchPlugins() {
  return request('/api/plugins');
}

/** GET /api/system/info -- LAN connection info (hostname, IPs, broker URLs) */
export function fetchSystemInfo() {
  return request('/api/system/info');
}

/** GET /api/bindings -- flat list of every input binding across plugins */
export function fetchAllBindings() {
  return request('/api/bindings');
}

/**
 * GET /api/bindings/health -- per-plugin binding-health rollup.
 * Returns a map keyed by plugin id; running plugins with zero bindings and
 * stopped plugins are omitted. Used by the sidebar dot + page summary banner.
 */
export function fetchBindingsHealth() {
  return request('/api/bindings/health');
}

/**
 * GET /api/health/digest -- cross-plugin health snapshot for Hub-side polling.
 *
 * Returns { box, host, checked_at, ok_count, issues:[...] }. Combines
 * binding-level findings with plugin-liveness (connection state, auto-start
 * status) into one flat issues list. All timestamps ISO-8601 with Z suffix.
 * Designed for an external monitor to poll every 60s.
 */
export function fetchHealthDigest() {
  return request('/api/health/digest');
}

/** GET /api/update/status -- current version + GitHub-poll state + auto-update settings */
export function fetchUpdateStatus() {
  return request('/api/update/status');
}

/** POST /api/update/check -- force a fresh GitHub /commits/main check */
export function triggerUpdateCheck() {
  return request('/api/update/check', { method: 'POST', body: JSON.stringify({}) });
}

/** POST /api/plugins/:id/start */
export function startPlugin(id) {
  return request(`/api/plugins/${encodeURIComponent(id)}/start`, { method: 'POST' });
}

/** POST /api/plugins/:id/stop */
export function stopPlugin(id) {
  return request(`/api/plugins/${encodeURIComponent(id)}/stop`, { method: 'POST' });
}

/** DELETE /api/plugins/:id -- delete a plugin instance */
export function deletePlugin(id) {
  return request(`/api/plugins/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** POST /api/plugins/:id/reload */
export function reloadPlugin(id) {
  return request(`/api/plugins/${encodeURIComponent(id)}/reload`, { method: 'POST' });
}

/** GET /api/plugins/:id/config -- returns { config, schema } */
export function getPluginConfig(id) {
  return request(`/api/plugins/${encodeURIComponent(id)}/config`);
}

/** PUT /api/plugins/:id/config -- save config object */
export function savePluginConfig(id, config) {
  return request(`/api/plugins/${encodeURIComponent(id)}/config`, {
    method: 'PUT',
    body: JSON.stringify(config),
  });
}

// --- MQTT publish ---

/** POST /api/mqtt/publish -- publish a message to the broker */
export function publishMqtt(topic, payload, { retain = false, qos = 0 } = {}) {
  return request('/api/mqtt/publish', {
    method: 'POST',
    body: JSON.stringify({ topic, payload, retain, qos }),
  });
}

// --- Plugin control endpoints (dynamic pluginId) ---

/** GET /api/plugins/:id/controls */
export function fetchLoxoneControls(pluginId = 'loxone') {
  return request(`/api/plugins/${encodeURIComponent(pluginId)}/controls`);
}

/** GET /api/plugins/:id/controls/detailed */
export function fetchLoxoneControlsDetailed(pluginId = 'loxone') {
  return request(`/api/plugins/${encodeURIComponent(pluginId)}/controls/detailed`);
}

/** PUT /api/plugins/:id/controls/:uuid */
export function toggleLoxoneControl(uuid, enabled, pluginId = 'loxone') {
  return request(`/api/plugins/${encodeURIComponent(pluginId)}/controls/${encodeURIComponent(uuid)}`, {
    method: 'PUT',
    body: JSON.stringify({ enabled }),
  });
}

/** POST /api/plugins/:id/controls/:uuid/cmd */
export function sendLoxoneCommand(uuid, command, pluginId = 'loxone') {
  return request(`/api/plugins/${encodeURIComponent(pluginId)}/controls/${encodeURIComponent(uuid)}/cmd`, {
    method: 'POST',
    body: JSON.stringify({ command }),
  });
}

/** GET /api/plugins/:id/elements */
export function fetchBridgeElements(pluginId) {
  return request(`/api/plugins/${encodeURIComponent(pluginId)}/elements`);
}

/** GET /api/plugins/:id/bindings -- list MQTT input bindings for a plugin */
export function fetchInputBindings(pluginId = 'loxone') {
  return request(`/api/plugins/${encodeURIComponent(pluginId)}/bindings`);
}

/** PUT /api/plugins/:id/bindings -- save MQTT input bindings for a plugin */
export function saveInputBindings(pluginId = 'loxone', bindings) {
  return request(`/api/plugins/${encodeURIComponent(pluginId)}/bindings`, {
    method: 'PUT',
    body: JSON.stringify(bindings),
  });
}

/** GET /api/bindings/export -- aggregate snapshot of every plugin's bindings */
export function fetchBindingsExport() {
  return request('/api/bindings/export');
}

/**
 * POST /api/bindings/import -- restore an aggregate snapshot.
 * @param {'merge'|'replace'} mode
 * @param {object} payload — the export-file JSON object
 */
export function applyBindingsImport(mode, payload) {
  return request('/api/bindings/import', {
    method: 'POST',
    body: JSON.stringify({ mode, payload }),
  });
}

/** GET /api/plugins/:id/structure/raw -- aggregate LoxAPP3.json parse summary */
export function getStructureRaw(pluginId) {
  return request(`/api/plugins/${encodeURIComponent(pluginId)}/structure/raw`);
}

/** POST /api/plugins/:id/structure/refresh -- force re-fetch + return new summary */
export function refreshStructure(pluginId) {
  return request(`/api/plugins/${encodeURIComponent(pluginId)}/structure/refresh`, {
    method: 'POST',
  });
}

// ── Mosquitto-native broker bridges ────────────────────────────────
// These wrap /api/bridges (the in-process Mosquitto bridge manager, NOT the
// `mqtt-bridge` plugin under /api/plugins/...). The mqtt-master backend
// regenerates /etc/mosquitto/conf.d/mqtt-master-bridges.conf and calls
// `systemctl reload mosquitto` server-side.

/** GET /api/bridges -- list bridges (passwords masked to "***") */
export function fetchBridges() {
  return request('/api/bridges');
}

/** GET /api/bridges/:id -- single bridge, password masked ("***" sent back = unchanged) */
export function fetchBridge(id) {
  return request(`/api/bridges/${encodeURIComponent(id)}`);
}

/** GET /api/bridges/status -- { <connectionName>: 'connected'|'disconnected'|'unknown' } */
export function fetchBridgesStatus() {
  return request('/api/bridges/status');
}

/** POST /api/bridges -- create */
export function createBridge(bridge) {
  return request('/api/bridges', { method: 'POST', body: JSON.stringify(bridge) });
}

/** PUT /api/bridges/:id -- update */
export function updateBridge(id, bridge) {
  return request(`/api/bridges/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(bridge),
  });
}

/** DELETE /api/bridges/:id -- delete */
export function deleteBridge(id) {
  return request(`/api/bridges/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** POST /api/bridges/apply -- regenerate+reload from current config */
export function applyBridges() {
  return request('/api/bridges/apply', { method: 'POST', body: JSON.stringify({}) });
}

