import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import apiPlugins from '../server/routes/api-plugins.js';

function createMockPluginManager(entries = [{ id: 'example', name: 'example', status: 'stopped', error: null, instance: null }]) {
  const plugins = new Map();
  for (const entry of entries) {
    plugins.set(entry.id, {
      id: entry.id,
      name: entry.name || entry.id,
      type: entry.type,
      displayName: entry.displayName,
      status: entry.status || 'stopped',
      error: entry.error || null,
      instance: entry.instance || null,
      // Bindings storage for the export/import tests. Lives on the meta so
      // getConfig() can return it as the config-fallback inputBindings.
      bindings: Array.isArray(entry.bindings) ? entry.bindings.slice() : [],
      // Per-binding stats for the /api/bindings/health tests. `bindingStats`
      // is an array; `bindingStatsThrows` makes getInputBindingStats() throw
      // so the route's per-plugin try/catch can be exercised.
      bindingStats: Array.isArray(entry.bindingStats) ? entry.bindingStats.slice() : null,
      bindingStatsThrows: !!entry.bindingStatsThrows,
    });
  }

  return {
    listAll: vi.fn(() => {
      const result = [];
      for (const p of plugins.values()) {
        const e = { id: p.id, name: p.name, status: p.status, error: p.error };
        if (p.type) e.type = p.type;
        if (p.displayName) e.displayName = p.displayName;
        result.push(e);
      }
      return result;
    }),
    start: vi.fn(async (id) => {
      if (!plugins.has(id)) throw new Error(`Plugin '${id}' not found`);
      plugins.get(id).status = 'running';
    }),
    stop: vi.fn(async (id) => {
      if (!plugins.has(id)) throw new Error(`Plugin '${id}' not found`);
      plugins.get(id).status = 'stopped';
    }),
    reload: vi.fn(async (id) => {
      if (!plugins.has(id)) throw new Error(`Plugin '${id}' not found`);
    }),
    getConfig: vi.fn((id) => {
      if (!plugins.has(id)) throw new Error(`Plugin '${id}' not found`);
      const cfg = { greeting: 'Hello' };
      // Only surface inputBindings when an entry actually carried some — keeps
      // older tests (`PUT /api/plugins/:id/config`) asserting the pristine
      // {greeting:'Hi'} merge shape untouched, while still letting the new
      // export/import paths read bindings via the config fallback.
      const b = plugins.get(id).bindings;
      if (Array.isArray(b) && b.length > 0) cfg.inputBindings = b;
      return cfg;
    }),
    setConfig: vi.fn(async (id, data) => {
      if (!plugins.has(id)) throw new Error(`Plugin '${id}' not found`);
      if (Array.isArray(data?.inputBindings)) {
        plugins.get(id).bindings = data.inputBindings.slice();
      }
    }),
    getStatus: vi.fn((id) => {
      if (!plugins.has(id)) throw new Error(`Plugin '${id}' not found`);
      return { status: plugins.get(id).status, error: null };
    }),
    getInstance: vi.fn((id) => {
      if (!plugins.has(id)) return null;
      const p = plugins.get(id);
      if (p.status === 'running') {
        const instance = {
          getConfigSchema: () => ({
            type: 'object',
            properties: { greeting: { type: 'string' } },
          }),
        };
        // Only running plugins that opted in expose getInputBindingStats —
        // mirrors the real loxone / mqtt-bridge plugins. A null bindingStats
        // means "no binding support" so the health route skips the plugin.
        if (p.bindingStatsThrows) {
          instance.getInputBindingStats = () => {
            throw new Error('boom');
          };
        } else if (Array.isArray(p.bindingStats)) {
          instance.getInputBindingStats = () => p.bindingStats.slice();
        }
        return instance;
      }
      return null;
    }),
    // Routes fall back to manager.getSchema() when getInstance() returns null
    // (i.e. plugin not running). Returning {} mirrors the discovery-time
    // schema cache being empty — same shape the real manager produces.
    getSchema: vi.fn(() => ({})),
    plugins,
  };
}

function mockConfigService(map = {}) {
  return {
    get: (key, fallback) => (key in map ? map[key] : fallback),
    set: vi.fn(),
    save: vi.fn(async () => {}),
  };
}

describe('API Plugins Routes', () => {
  let app;
  let mockPm;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    mockPm = createMockPluginManager();
    app.decorate('pluginManager', mockPm);
    app.decorate('configService', mockConfigService());
    await app.register(apiPlugins);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /api/plugins returns array of plugins with status', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/plugins' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(body[0]).toHaveProperty('id', 'example');
    expect(body[0]).toHaveProperty('status', 'stopped');
  });

  it('GET /api/plugins/example returns single plugin with topicPrefix', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/plugins/example' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('id', 'example');
    expect(body).toHaveProperty('status', 'stopped');
    // No `type` on this mock entry so topicPrefix stays null — the contract is
    // simply that the field exists so the WAN / Clients pages can read it.
    expect(body).toHaveProperty('topicPrefix');
  });

  it('GET /api/plugins/nonexistent returns 404 JSON (not SPA fallback)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/plugins/nonexistent' });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('error');
  });

  it('POST /api/plugins/example/start returns 200 and starts plugin', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/plugins/example/start' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(mockPm.start).toHaveBeenCalledWith('example');
  });

  it('POST /api/plugins/example/stop returns 200 and stops plugin', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/plugins/example/stop' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(mockPm.stop).toHaveBeenCalledWith('example');
  });

  it('POST /api/plugins/example/reload returns 200', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/plugins/example/reload' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(mockPm.reload).toHaveBeenCalledWith('example');
  });

  it('GET /api/plugins/example/config returns config object + schema', async () => {
    // Start plugin first so getInstance returns something with getConfigSchema
    await app.inject({ method: 'POST', url: '/api/plugins/example/start' });

    const res = await app.inject({ method: 'GET', url: '/api/plugins/example/config' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('config');
    expect(body).toHaveProperty('schema');
    expect(body.config).toEqual({ greeting: 'Hello' });
  });

  it('GET /api/plugins/example/config returns empty schema when not running', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/plugins/example/config' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.config).toEqual({ greeting: 'Hello' });
    expect(body.schema).toEqual({});
  });

  it('PUT /api/plugins/example/config saves config and returns 200', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/plugins/example/config',
      payload: { greeting: 'Hi' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(mockPm.setConfig).toHaveBeenCalledWith('example', { greeting: 'Hi' });
  });

  it('PUT /api/plugins/:id/config reloads a running plugin after config change', async () => {
    // Bring the plugin into the 'running' state so the handler takes the reload branch.
    await app.inject({ method: 'POST', url: '/api/plugins/example/start' });
    mockPm.start.mockClear();
    mockPm.reload.mockClear();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/plugins/example/config',
      payload: { greeting: 'Servus' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ ok: true, reloaded: true, status: 'running' });
    expect(mockPm.reload).toHaveBeenCalledTimes(1);
    expect(mockPm.reload).toHaveBeenCalledWith('example');
    expect(mockPm.start).not.toHaveBeenCalled();
  });

  it('PUT /api/plugins/:id/config auto-starts a stopped plugin (existing behavior preserved)', async () => {
    // Default mock status is 'stopped' — confirm we still take the auto-start branch.
    const res = await app.inject({
      method: 'PUT',
      url: '/api/plugins/example/config',
      payload: { greeting: 'Servus' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ ok: true, autoStarted: true, status: 'running' });
    expect(mockPm.start).toHaveBeenCalledTimes(1);
    expect(mockPm.start).toHaveBeenCalledWith('example');
    expect(mockPm.reload).not.toHaveBeenCalled();
  });

  it('POST /api/plugins/nonexistent/start returns 404', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/plugins/nonexistent/start' });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('error');
  });

  it('POST /api/plugins/nonexistent/stop returns 404', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/plugins/nonexistent/stop' });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('error');
  });

  it('GET /api/plugins/nonexistent/config returns 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/plugins/nonexistent/config' });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('error');
  });

  it('GET /api/plugins includes topicPrefix derived from plugin config', async () => {
    // Fresh app with multi-entry plugin manager and configured prefixes
    await app.close();
    app = Fastify({ logger: false });
    const multiPm = createMockPluginManager([
      { id: 'house1', type: 'loxone', status: 'running' },
      { id: 'loxone-default', type: 'loxone', status: 'stopped' },
      { id: 'venus-bridge', type: 'mqtt-bridge', status: 'running' },
      { id: 'mystery', type: 'unknown-type', status: 'stopped' },
    ]);
    app.decorate('pluginManager', multiPm);
    app.decorate('configService', mockConfigService({
      'plugins.house1': { prefix: 'loxone-house1' },
      'plugins.loxone-default': {},
      'plugins.venus-bridge': { localPrefix: 'venus' },
      'plugins.mystery': {},
    }));
    await app.register(apiPlugins);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/plugins' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    const house1 = body.find(p => p.id === 'house1');
    expect(house1).toBeDefined();
    expect(house1.topicPrefix).toBe('loxone-house1');

    const loxDefault = body.find(p => p.id === 'loxone-default');
    expect(loxDefault).toBeDefined();
    expect(loxDefault.topicPrefix).toBe('loxone');

    const venus = body.find(p => p.id === 'venus-bridge');
    expect(venus).toBeDefined();
    expect(venus.topicPrefix).toBe('venus');

    const mystery = body.find(p => p.id === 'mystery');
    expect(mystery).toBeDefined();
    expect(mystery.topicPrefix).toBeNull();
  });

  // ── Bindings export / import (aggregate) ─────────────────────────────
  describe('aggregate bindings export/import', () => {
    async function buildApp(entries) {
      const a = Fastify({ logger: false });
      const pm = createMockPluginManager(entries);
      a.decorate('pluginManager', pm);
      a.decorate('configService', mockConfigService());
      await a.register(apiPlugins);
      await a.ready();
      return { a, pm };
    }

    it('GET /api/bindings/export returns version:1 + scope:all + plugins map', async () => {
      const { a } = await buildApp([
        {
          id: 'gateway1', type: 'loxone', displayName: 'Gateway1', status: 'stopped',
          bindings: [
            { id: 'b1', enabled: true, mqttTopic: 't/1', jsonField: 'value', targetUuid: 'u1', transform: '', label: 'B1' },
            { id: 'b2', enabled: true, mqttTopic: 't/2', jsonField: '',      targetUuid: 'u2', transform: '', label: 'B2' },
          ],
        },
        {
          id: 'venus', type: 'mqtt-bridge', displayName: 'Venus OS', status: 'stopped',
          bindings: [
            { id: 'b3', enabled: true, mqttTopic: 't/3', jsonField: 'p', targetUuid: 'u3', transform: 'd10', label: 'B3' },
          ],
        },
      ]);

      const res = await a.inject({ method: 'GET', url: '/api/bindings/export' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.type).toBe('mqtt-master-bindings-export');
      expect(body.version).toBe(1);
      expect(body.scope).toBe('all');
      expect(typeof body.exportedAt).toBe('string');
      expect(body.plugins.gateway1.pluginType).toBe('loxone');
      expect(body.plugins.gateway1.displayName).toBe('Gateway1');
      expect(body.plugins.gateway1.bindings).toHaveLength(2);
      expect(body.plugins.gateway1.bindings[0]).toMatchObject({ id: 'b1', mqttTopic: 't/1' });
      expect(body.plugins.venus.bindings).toHaveLength(1);
      await a.close();
    });

    it('POST /api/bindings/import with replace mode swaps bindings for known plugins', async () => {
      const { a, pm } = await buildApp([
        {
          id: 'gateway1', type: 'loxone', status: 'stopped',
          bindings: [{ id: 'old1', mqttTopic: 'old/1', jsonField: 'v', targetUuid: 'uo' }],
        },
      ]);

      const payload = {
        type: 'mqtt-master-bindings-export',
        version: 1,
        scope: 'all',
        exportedAt: '2026-05-20T17:50:00.000Z',
        plugins: {
          gateway1: {
            pluginType: 'loxone',
            displayName: 'Gateway1',
            bindings: [
              { id: 'new1', mqttTopic: 'new/1', jsonField: 'v', targetUuid: 'un1' },
              { id: 'new2', mqttTopic: 'new/2', jsonField: '',  targetUuid: 'un2' },
            ],
          },
          // ghost plugin not present in pluginManager — must be reported as skipped
          'gone-plugin': {
            pluginType: 'loxone', displayName: 'gone', bindings: [],
          },
        },
      };
      const res = await a.inject({
        method: 'POST',
        url: '/api/bindings/import',
        payload: { mode: 'replace', payload },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.ok).toBe(true);
      expect(body.applied).toEqual([{ pluginId: 'gateway1', count: 2 }]);
      expect(body.skipped).toEqual([{ pluginId: 'gone-plugin', reason: 'plugin_not_found' }]);

      // Confirm the stored bindings match the incoming list exactly (replace
      // wiped the old single binding).
      expect(pm.plugins.get('gateway1').bindings).toHaveLength(2);
      expect(pm.plugins.get('gateway1').bindings[0].id).toBe('new1');
      await a.close();
    });

    it('POST /api/bindings/import with merge mode preserves existing bindings and adds non-duplicates', async () => {
      const { a, pm } = await buildApp([
        {
          id: 'gateway1', type: 'loxone', status: 'stopped',
          bindings: [
            { id: 'keep1', mqttTopic: 'k/1', jsonField: 'v', targetUuid: 'uk1' },
            { id: 'keep2', mqttTopic: 'k/2', jsonField: 'v', targetUuid: 'uk2' },
          ],
        },
      ]);

      const payload = {
        type: 'mqtt-master-bindings-export',
        version: 1,
        scope: 'all',
        plugins: {
          gateway1: {
            pluginType: 'loxone',
            bindings: [
              // Same id as existing → must be skipped (duplicate_id).
              { id: 'keep1', mqttTopic: 'k/1', jsonField: 'v', targetUuid: 'uk1' },
              // Fresh id but same topic+field+uuid triple as keep2 → duplicate_target.
              { id: 'fresh-but-dup', mqttTopic: 'k/2', jsonField: 'v', targetUuid: 'uk2' },
              // Genuinely new → must be appended.
              { id: 'add1', mqttTopic: 'k/3', jsonField: 'v', targetUuid: 'uk3' },
            ],
          },
        },
      };

      const res = await a.inject({
        method: 'POST',
        url: '/api/bindings/import',
        payload: { mode: 'merge', payload },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.ok).toBe(true);
      expect(body.applied).toEqual([{ pluginId: 'gateway1', count: 1 }]);
      expect(body.conflicts).toEqual([
        { pluginId: 'gateway1', bindingId: 'keep1', reason: 'duplicate_id' },
        { pluginId: 'gateway1', bindingId: 'fresh-but-dup', reason: 'duplicate_target' },
      ]);

      // 2 kept + 1 added = 3
      const stored = pm.plugins.get('gateway1').bindings;
      expect(stored).toHaveLength(3);
      expect(stored.map(b => b.id)).toEqual(['keep1', 'keep2', 'add1']);
      await a.close();
    });

    it('POST /api/bindings/import with copy mode appends every binding as a fresh clone', async () => {
      const { a, pm } = await buildApp([
        {
          id: 'gateway1', type: 'loxone', status: 'stopped',
          bindings: [
            { id: 'keep1', mqttTopic: 'k/1', jsonField: 'v', targetUuid: 'uk1', label: 'Keep One' },
            { id: 'keep2', mqttTopic: 'k/2', jsonField: 'v', targetUuid: 'uk2', label: 'Keep Two' },
          ],
        },
      ]);

      const payload = {
        type: 'mqtt-master-bindings-export',
        version: 1,
        scope: 'all',
        plugins: {
          gateway1: {
            pluginType: 'loxone',
            bindings: [
              // Same id AND identical wiring as keep1 — copy mode must still
              // append it (the inverse of merge mode's duplicate skipping).
              { id: 'keep1', mqttTopic: 'k/1', jsonField: 'v', targetUuid: 'uk1', label: 'Keep One' },
              // Genuinely new.
              { id: 'add1', mqttTopic: 'k/3', jsonField: 'v', targetUuid: 'uk3', label: 'Add One' },
            ],
          },
        },
      };

      const res = await a.inject({
        method: 'POST',
        url: '/api/bindings/import',
        payload: { mode: 'copy', payload },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.ok).toBe(true);
      expect(body.applied).toEqual([{ pluginId: 'gateway1', count: 2 }]);
      // Copy mode never reports conflicts.
      expect(body.conflicts).toEqual([]);

      // 2 existing + 2 copied = 4 stored.
      const stored = pm.plugins.get('gateway1').bindings;
      expect(stored).toHaveLength(4);

      // All stored ids are unique — the duplicate 'keep1' incoming got a fresh id.
      const ids = stored.map(b => b.id);
      expect(new Set(ids).size).toBe(4);

      // The two existing bindings are untouched.
      expect(stored[0]).toMatchObject({ id: 'keep1', label: 'Keep One', mqttTopic: 'k/1' });
      expect(stored[1]).toMatchObject({ id: 'keep2', label: 'Keep Two', mqttTopic: 'k/2' });

      // The two copied bindings carry a ' (copy)' label suffix and fresh ids.
      expect(stored[2].label).toBe('Keep One (copy)');
      expect(stored[2].id).not.toBe('keep1');
      expect(stored[3].label).toBe('Add One (copy)');
      expect(stored[3].id).not.toBe('add1');
      await a.close();
    });

    it('POST /api/bindings/import accepts mode "copy" (not rejected by the invalid_mode guard)', async () => {
      const { a } = await buildApp([
        { id: 'gateway1', type: 'loxone', status: 'stopped', bindings: [] },
      ]);
      const res = await a.inject({
        method: 'POST', url: '/api/bindings/import',
        payload: {
          mode: 'copy',
          payload: { type: 'mqtt-master-bindings-export', version: 1, scope: 'all', plugins: {} },
        },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).ok).toBe(true);
      await a.close();
    });

    it('POST /api/bindings/import rejects payload without correct type/version', async () => {
      const { a } = await buildApp([
        { id: 'gateway1', type: 'loxone', status: 'stopped', bindings: [] },
      ]);
      // Missing type
      let res = await a.inject({
        method: 'POST', url: '/api/bindings/import',
        payload: { mode: 'replace', payload: { version: 1, scope: 'all', plugins: {} } },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('invalid_export_file');

      // Wrong version
      res = await a.inject({
        method: 'POST', url: '/api/bindings/import',
        payload: { mode: 'replace', payload: { type: 'mqtt-master-bindings-export', version: 99, scope: 'all', plugins: {} } },
      });
      expect(res.statusCode).toBe(400);

      // Wrong scope (single-plugin file given to aggregate endpoint)
      res = await a.inject({
        method: 'POST', url: '/api/bindings/import',
        payload: { mode: 'replace', payload: { type: 'mqtt-master-bindings-export', version: 1, scope: 'plugin', bindings: [] } },
      });
      expect(res.statusCode).toBe(400);

      // Bad mode
      res = await a.inject({
        method: 'POST', url: '/api/bindings/import',
        payload: { mode: 'overwrite', payload: { type: 'mqtt-master-bindings-export', version: 1, scope: 'all', plugins: {} } },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('invalid_mode');
      await a.close();
    });
  });

  // ── Bindings health rollup ───────────────────────────────────────────
  describe('GET /api/bindings/health', () => {
    async function buildApp(entries) {
      const a = Fastify({ logger: false });
      const pm = createMockPluginManager(entries);
      a.decorate('pluginManager', pm);
      a.decorate('configService', mockConfigService());
      await a.register(apiPlugins);
      await a.ready();
      return { a };
    }

    it('returns a per-plugin map; a send_error stat yields severity error with populated issues', async () => {
      const { a } = await buildApp([
        {
          id: 'house1', type: 'loxone', status: 'running',
          bindingStats: [
            {
              id: 'b-1', label: 'SolarEdge ac power w', enabled: true,
              mqttTopic: 't/1', jsonField: '', targetUuid: 'u1',
              sendCount: 0, recvCount: 4, lastReason: 'send_error',
              lastReceivedAt: Date.now() - 1000, lastSentAt: null,
              lastError: 'target unreachable',
            },
          ],
        },
      ]);

      const res = await a.inject({ method: 'GET', url: '/api/bindings/health' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.house1).toBeDefined();
      expect(body.house1.severity).toBe('error');
      expect(body.house1.total).toBe(1);
      expect(body.house1.counts).toEqual({ ok: 0, warn: 0, error: 1, disabled: 0 });
      expect(body.house1.issues).toHaveLength(1);
      expect(body.house1.issues[0]).toMatchObject({
        id: 'b-1', label: 'SolarEdge ac power w',
        severity: 'error', reason: 'send_error',
      });
      await a.close();
    });

    it('a stopped plugin (no instance) is absent from the response', async () => {
      const { a } = await buildApp([
        {
          id: 'running-one', type: 'loxone', status: 'running',
          bindingStats: [
            {
              id: 'b-ok', label: 'OK binding', enabled: true,
              mqttTopic: 't/ok', jsonField: '', targetUuid: 'u-ok',
              sendCount: 3, recvCount: 3, lastReason: 'changed',
              lastReceivedAt: Date.now() - 500, lastSentAt: Date.now() - 500,
            },
          ],
        },
        { id: 'stopped-one', type: 'loxone', status: 'stopped' },
      ]);

      const res = await a.inject({ method: 'GET', url: '/api/bindings/health' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body['running-one']).toBeDefined();
      expect(body['stopped-one']).toBeUndefined();
      await a.close();
    });

    it('a plugin whose getInputBindingStats throws does not 500 the endpoint', async () => {
      const { a } = await buildApp([
        { id: 'bad-plugin', type: 'loxone', status: 'running', bindingStatsThrows: true },
        {
          id: 'good-plugin', type: 'mqtt-bridge', status: 'running',
          bindingStats: [
            {
              id: 'b-good', label: 'Good binding', enabled: true,
              mqttTopic: 't/g', jsonField: '', targetUuid: 'u-g',
              sendCount: 7, recvCount: 7, lastReason: 'changed',
              lastReceivedAt: Date.now() - 200, lastSentAt: Date.now() - 200,
            },
          ],
        },
      ]);

      const res = await a.inject({ method: 'GET', url: '/api/bindings/health' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // The throwing plugin is skipped; the healthy one still comes back.
      expect(body['bad-plugin']).toBeUndefined();
      expect(body['good-plugin']).toBeDefined();
      expect(body['good-plugin'].severity).toBe('ok');
      await a.close();
    });
  });
});
