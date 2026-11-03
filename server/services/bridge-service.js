import { promises as fsp } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { generateMosquittoBridgeConf } from './bridge-config-generator.js';

/**
 * BridgeService
 *
 *   - Owns the lifecycle of mosquitto-native broker bridges declared under
 *     `bridges.list` in config.json. Renders them to
 *     `/etc/mosquitto/conf.d/mqtt-master-bridges.conf` via the pure
 *     generator, writes atomically (tempfile + rename in the same
 *     directory), then `systemctl reload mosquitto`.
 *   - On reload failure, restores the previous .conf byte-for-byte and
 *     re-runs `systemctl reload`. Never leaves the broker with a half-
 *     written or invalid config — caller gets a structured failure.
 *   - Tracks per-bridge connection status from the retained MQTT topic
 *     `$SYS/broker/connection/<connection-name>/state` (payload 1/0).
 *     Subscribed once at construction.
 *
 *   - **Crash window (T-3sd-06, accepted):** if mqtt-master crashes between
 *     the rename and the rollback rename, the on-disk .conf may briefly
 *     reflect an uncommitted change. Next start re-renders the .conf from
 *     config.json (config.json is the source of truth).
 *   - **bridges.confPath override (T-3sd-03, accepted):** lives in the same
 *     trust domain as everything else mqtt-master writes. Default is
 *     hardcoded; the override only exists so the test suite can point at a
 *     tmpdir.
 */

const CONF_PATH_DEFAULT = '/etc/mosquitto/conf.d/mqtt-master-bridges.conf';
const RELOAD_TIMEOUT_MS = 10_000;
const CONNECTION_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const VALID_DIRECTIONS = new Set(['in', 'out', 'both']);
const VALID_QOS = new Set([0, 1, 2]);
const PASSWORD_MASK = '***';

export class BridgeService {
  constructor({ config, mqttService, logger }) {
    this._config = config;
    this._mqtt = mqttService;
    this._logger = logger || console;
    this._statusMap = {};

    // Subscribe to the per-bridge state topic. Mosquitto publishes this
    // retained, so a fresh app boot picks up correct state within ~2s of
    // broker connect.
    if (this._mqtt && typeof this._mqtt.subscribe === 'function') {
      this._mqtt.subscribe('$SYS/broker/connection/+/state');
    }
    if (this._mqtt && typeof this._mqtt.on === 'function') {
      this._mqtt.on('message', (msg) => this._onMessage(msg));
    }
  }

  // ── $SYS handler ────────────────────────────────────────────────
  _onMessage({ topic, payload }) {
    if (typeof topic !== 'string' || !topic.startsWith('$SYS/broker/connection/')) return;
    const parts = topic.split('/');
    // $SYS/broker/connection/<name>/state → parts[3] = name
    if (parts.length !== 5 || parts[4] !== 'state') return;
    const name = parts[3];
    if (!name) return;
    const text = String(payload);
    if (text === '1') this._statusMap[name] = 'connected';
    else if (text === '0') this._statusMap[name] = 'disconnected';
  }

  // ── Config IO helpers ──────────────────────────────────────────
  _confPath() {
    return this._config.get('bridges.confPath', CONF_PATH_DEFAULT);
  }

  _currentArray() {
    const list = this._config.get('bridges.list', []);
    return Array.isArray(list) ? list : [];
  }

  _maskPassword(bridge) {
    const copy = { ...bridge };
    // Any non-empty value, not only strings.
    if (copy.remotePassword != null && copy.remotePassword !== '') {
      copy.remotePassword = PASSWORD_MASK;
    }
    return copy;
  }

  // ── Public reads ────────────────────────────────────────────────
  /** List bridges with passwords masked. */
  listBridges() {
    return this._currentArray().map((b) => this._maskPassword(b));
  }

  /**
   * Get one bridge, password masked too: GET is readable
   * from the whole LAN. Saving the mask back keeps the stored password.
   */
  getBridge(id) {
    const found = this._currentArray().find((b) => b.id === id);
    return found ? this._maskPassword(found) : null;
  }

  /**
   * Returns { <connectionName>: 'connected' | 'disconnected' | 'unknown' }.
   * Configured bridges that have not yet published a $SYS state get
   * 'unknown' so the UI can render a grey dot.
   */
  getStatus() {
    const out = {};
    for (const b of this._currentArray()) {
      const name = b.connectionName;
      out[name] = this._statusMap[name] || 'unknown';
    }
    // Also surface state for any bridge mosquitto knows about but config
    // does not — useful for diagnosing left-over connection blocks.
    for (const name of Object.keys(this._statusMap)) {
      if (out[name] == null) out[name] = this._statusMap[name];
    }
    return out;
  }

  // ── Validation ──────────────────────────────────────────────────
  _validate(bridge, { existingNames = new Set() } = {}) {
    if (!bridge || typeof bridge !== 'object') {
      return { ok: false, error: 'bridge must be an object' };
    }
    const name = bridge.connectionName;
    if (typeof name !== 'string' || !CONNECTION_NAME_RE.test(name)) {
      return { ok: false, error: `invalid connection name: "${name}"` };
    }
    if (existingNames.has(name)) {
      return { ok: false, error: `duplicate connection name: "${name}"` };
    }
    if (typeof bridge.remoteHost !== 'string' || bridge.remoteHost.length === 0) {
      return { ok: false, error: 'remoteHost must be a non-empty string' };
    }
    if (!Number.isInteger(bridge.remotePort) || bridge.remotePort < 1 || bridge.remotePort > 65535) {
      return { ok: false, error: `remotePort must be 1..65535 (got ${bridge.remotePort})` };
    }
    for (const field of ['remoteUsername', 'remotePassword']) {
      if (bridge[field] != null && typeof bridge[field] !== 'string') {
        return { ok: false, error: `${field} must be a string` };
      }
    }
    if (!Array.isArray(bridge.topics) || bridge.topics.length === 0) {
      return { ok: false, error: 'topics must be a non-empty array' };
    }
    for (const t of bridge.topics) {
      if (!t || typeof t.pattern !== 'string' || t.pattern.length === 0) {
        return { ok: false, error: 'topic.pattern must be a non-empty string' };
      }
      if (!VALID_DIRECTIONS.has(t.direction)) {
        return { ok: false, error: `invalid topic direction: "${t.direction}"` };
      }
      if (!VALID_QOS.has(t.qos)) {
        return { ok: false, error: `invalid topic qos: ${t.qos}` };
      }
    }
    return { ok: true };
  }

  // ── Atomic write + reload primitives ───────────────────────────
  /**
   * Read the current .conf or null if it doesn't exist.
   * Captured BEFORE a write so we can restore on rollback.
   */
  async _readPrevious() {
    try {
      return await fsp.readFile(this._confPath(), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  /**
   * Atomic write: tempfile in the SAME directory, then rename. POSIX-atomic
   * on the same filesystem. Sets mode 0600 (T-3sd-04) so the cleartext
   * remote_password lines are not world-readable.
   */
  async _atomicWriteConf(content) {
    const target = this._confPath();
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    // Ensure parent dir exists (test scratch dirs sometimes don't, prod
    // /etc/mosquitto/conf.d always does).
    await fsp.mkdir(dirname(target), { recursive: true });
    await fsp.writeFile(tmp, content, { encoding: 'utf8', mode: 0o600 });
    try {
      await fsp.rename(tmp, target);
    } catch (err) {
      // Best-effort cleanup of the leftover tempfile.
      try { await fsp.unlink(tmp); } catch { /* ignore */ }
      throw err;
    }
    // chmod after rename in case the umask or an existing file's mode
    // ended up looser than 0600.
    try { await fsp.chmod(target, 0o600); } catch { /* ignore */ }
  }

  /**
   * Restore a previously captured .conf content. `null` means "no file
   * existed before" → unlink the current one.
   */
  async _restorePrevious(previous) {
    const target = this._confPath();
    if (previous == null) {
      try { await fsp.unlink(target); } catch { /* ignore */ }
      return;
    }
    // Same atomic-write dance for the restore so a partial write here
    // doesn't leave us worse off than before.
    const tmp = `${target}.tmp-rb-${process.pid}-${Date.now()}`;
    await fsp.writeFile(tmp, previous, { encoding: 'utf8', mode: 0o600 });
    await fsp.rename(tmp, target);
  }

  /**
   * spawn `systemctl reload mosquitto`. Returns { code, stderr }. 10s
   * timeout — past that we kill the process and treat it as failure.
   */
  async _reloadMosquitto() {
    return new Promise((resolve) => {
      let stderr = '';
      let settled = false;
      const child = spawn('systemctl', ['reload', 'mosquitto']);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        resolve({ code: -1, stderr: stderr + '\n[timeout after 10s]' });
      }, RELOAD_TIMEOUT_MS);
      child.stderr?.on('data', (d) => { stderr += d.toString('utf8'); });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code: code ?? 0, stderr });
      });
      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code: -1, stderr: `${stderr}spawn failed: ${err.message}` });
      });
    });
  }

  // ── Write + reload with rollback ───────────────────────────────
  /**
   * Render the array, write atomically, reload mosquitto. On non-zero
   * exit, restore the previous .conf (or unlink if there was none) and
   * re-run reload before returning the structured failure.
   */
  async _writeAndReload(newArray) {
    let content;
    try {
      content = generateMosquittoBridgeConf(newArray);
    } catch (err) {
      return { ok: false, error: err.message };
    }
    const previous = await this._readPrevious();
    try {
      await this._atomicWriteConf(content);
    } catch (err) {
      return { ok: false, error: `write_failed: ${err.message}` };
    }
    const { code, stderr } = await this._reloadMosquitto();
    if (code === 0) {
      return { ok: true, reloadStderr: stderr };
    }
    // Failure path → rollback.
    this._logger.warn?.(`[bridges] systemctl reload mosquitto exited ${code}: ${stderr}`);
    try {
      await this._restorePrevious(previous);
      await this._reloadMosquitto();
    } catch (err) {
      this._logger.error?.(`[bridges] rollback failed: ${err.message}`);
    }
    return { ok: false, error: 'reload_failed', stderr };
  }

  // ── Public writes ───────────────────────────────────────────────
  /**
   * Insert or update a bridge by id (= connectionName). The id field is
   * auto-derived from connectionName if missing. On reload success, the
   * new array is persisted via config.save().
   */
  async upsertBridge(bridge) {
    if (!bridge || typeof bridge !== 'object') {
      return { ok: false, error: 'bridge must be an object' };
    }
    const incoming = { ...bridge };

    // Lookup slot by explicit id. A missing id means "new bridge" — so a
    // collision with any existing connectionName is a duplicate (validation
    // failure). An explicit id present means "edit in place" — collisions
    // are evaluated against OTHER bridges only.
    const current = this._currentArray();
    const hasExplicitId = typeof incoming.id === 'string' && incoming.id.length > 0;
    const existingIdx = hasExplicitId ? current.findIndex((b) => b.id === incoming.id) : -1;

    const otherNames = new Set(
      current
        .filter((_, idx) => idx !== existingIdx)
        .map((b) => b.connectionName),
    );
    const v = this._validate(incoming, { existingNames: otherNames });
    if (!v.ok) return v;

    // The edit form only ever sees the mask; sending it back means "unchanged".
    if (incoming.remotePassword === PASSWORD_MASK) {
      if (existingIdx < 0) return { ok: false, error: 'remotePassword must not be the mask "***"' };
      incoming.remotePassword = current[existingIdx].remotePassword;
    }

    // After validation, auto-derive id from connectionName when missing so
    // the persisted shape is stable.
    if (!incoming.id) incoming.id = incoming.connectionName;

    const newArray = current.slice();
    if (existingIdx >= 0) newArray[existingIdx] = incoming;
    else newArray.push(incoming);

    const res = await this._writeAndReload(newArray);
    if (!res.ok) return res;

    // Persist the new array.
    this._config.set('bridges.list', newArray);
    try { await this._config.save(); }
    catch (err) {
      this._logger.warn?.(`[bridges] config.save() failed: ${err.message}`);
    }
    return { ok: true, bridge: this._maskPassword(incoming), reloadStderr: res.reloadStderr };
  }

  /** Delete a bridge by id. Rollback semantics identical to upsert. */
  async deleteBridge(id) {
    const current = this._currentArray();
    const idx = current.findIndex((b) => b.id === id);
    if (idx < 0) return { ok: false, error: 'not_found' };
    const removed = current[idx];
    const newArray = current.slice();
    newArray.splice(idx, 1);
    const res = await this._writeAndReload(newArray);
    if (!res.ok) return res;
    this._config.set('bridges.list', newArray);
    try { await this._config.save(); }
    catch (err) {
      this._logger.warn?.(`[bridges] config.save() failed: ${err.message}`);
    }
    // Prune the stale $SYS status entry so getStatus() stops reporting a
    // phantom connection for the now-deleted bridge (mosquitto's retained
    // state topic otherwise lingers in _statusMap forever).
    if (removed && removed.connectionName) {
      delete this._statusMap[removed.connectionName];
    }
    return { ok: true };
  }

  /**
   * Re-render + reload the current array without changing it. Used by the
   * "Reload mosquitto" button to re-sync after an out-of-band edit.
   */
  async applyNow() {
    const res = await this._writeAndReload(this._currentArray());
    return res;
  }
}
