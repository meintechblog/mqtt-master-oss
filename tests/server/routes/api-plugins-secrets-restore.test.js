/**
 * 
 *  2. bindings GET and /api/bindings/export mask secrets in inputBindings,
 *     PUT and import put the stored secret back by binding id;
 *  3. masked array elements are matched by identity (id/key/uuid), not index;
 *  4. a mask at a secret path without a stored value is refused (400),
 *     instead of silently saving an empty secret;
 *  5. a mask in a non-secret field is an ordinary text value.
 * Uses a mock that keeps the config per plugin id, so a wrong id cannot pass.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import apiPlugins from '../../../server/routes/api-plugins.js';

const MASK = '••••••••';
const clone = (v) => JSON.parse(JSON.stringify(v));

function pluginManager(initial, { instance = null } = {}) {
  const configs = clone(initial);
  return {
    configs,
    getConfig: vi.fn((id) => {
      if (!Object.hasOwn(configs, id)) throw new Error(`Plugin '${id}' not found`);
      return clone(configs[id]);
    }),
    setConfig: vi.fn(async (id, data) => {
      if (!Object.hasOwn(configs, id)) throw new Error(`Plugin '${id}' not found`);
      configs[id] = clone(data);
    }),
    getInstance: vi.fn(() => instance),
    getSchema: vi.fn(() => ({})),
    getStatus: vi.fn(() => ({ status: 'running' })),
    reload: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    listAll: vi.fn(async () => Object.keys(configs).map((id) => ({ id, type: id }))),
  };
}

let app;
async function boot(pm) {
  app = Fastify({ logger: false });
  app.decorate('pluginManager', pm);
  await app.register(apiPlugins);
  await app.ready();
}
afterEach(async () => { await app?.close(); app = null; });

describe('restoreMasked by identity (Befund 3)', () => {
  const devices = [
    { key: 'eg', name: 'X40', accessToken: 'TA' },
    { key: 'og', name: 'E30', accessToken: 'TB' },
  ];

  it('reordered devices keep their own token', async () => {
    const pm = pluginManager({ dreame: { devices } });
    await boot(pm);
    const { config } = (await app.inject({ method: 'GET', url: '/api/plugins/dreame/config' })).json();
    config.devices.reverse();
    const res = await app.inject({ method: 'PUT', url: '/api/plugins/dreame/config', payload: config });
    expect(res.statusCode).toBe(200);
    expect(pm.configs.dreame.devices).toEqual([devices[1], devices[0]]);
  });

  it('removing the first device leaves the second with its own token', async () => {
    const pm = pluginManager({ dreame: { devices } });
    await boot(pm);
    const { config } = (await app.inject({ method: 'GET', url: '/api/plugins/dreame/config' })).json();
    config.devices.shift();
    await app.inject({ method: 'PUT', url: '/api/plugins/dreame/config', payload: config });
    expect(pm.configs.dreame.devices).toEqual([devices[1]]);
  });

  it('elements without identity are matched by index only when the length is unchanged', async () => {
    const pm = pluginManager({ p: { list: [{ token: 'T1' }, { token: 'T2' }] } });
    await boot(pm);
    const same = await app.inject({ method: 'PUT', url: '/api/plugins/p/config', payload: { list: [{ token: MASK }, { token: MASK }] } });
    expect(same.statusCode).toBe(200);
    expect(pm.configs.p.list).toEqual([{ token: 'T1' }, { token: 'T2' }]);

    const shorter = await app.inject({ method: 'PUT', url: '/api/plugins/p/config', payload: { list: [{ token: MASK }] } });
    expect(shorter.statusCode).toBe(400);
    expect(pm.configs.p.list).toEqual([{ token: 'T1' }, { token: 'T2' }]);
  });
});

describe('mask without stored value (Befund 4)', () => {
  it('a mask at a renamed secret key is refused and nothing is saved', async () => {
    const pm = pluginManager({ p: { nested: { refreshToken: 'rt-geheim' } } });
    await boot(pm);
    const res = await app.inject({ method: 'PUT', url: '/api/plugins/p/config', payload: { nested: { accessToken: MASK } } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('masked_secret_without_value');
    expect(pm.setConfig).not.toHaveBeenCalled();
    expect(pm.configs.p.nested.refreshToken).toBe('rt-geheim');
  });

  it('a mask for an empty stored secret is refused as well', async () => {
    const pm = pluginManager({ p: { password: '' } });
    await boot(pm);
    const res = await app.inject({ method: 'PUT', url: '/api/plugins/p/config', payload: { password: MASK } });
    expect(res.statusCode).toBe(400);
  });
});

describe('mask in a non-secret field (Befund 5)', () => {
  it('is stored as ordinary text', async () => {
    const pm = pluginManager({ p: { note: 'alt' } });
    await boot(pm);
    const res = await app.inject({ method: 'PUT', url: '/api/plugins/p/config', payload: { note: MASK } });
    expect(res.statusCode).toBe(200);
    expect(pm.configs.p.note).toBe(MASK);
  });
});

describe('config PUT edge cases (Befund 6)', () => {
  it('null values pass through, the mask still restores', async () => {
    const pm = pluginManager({ p: { password: 'pw', extra: 'x' } });
    await boot(pm);
    const res = await app.inject({ method: 'PUT', url: '/api/plugins/p/config', payload: { password: MASK, extra: null } });
    expect(res.statusCode).toBe(200);
    expect(pm.configs.p.password).toBe('pw');
    expect(pm.configs.p.extra).toBeNull();
  });

  it('__proto__/constructor.prototype in the body never reach the config or Object.prototype', async () => {
    const pm = pluginManager({ p: { password: 'pw' } });
    await boot(pm);
    for (const body of [
      '{"password":"••••••••","__proto__":{"polluted":"ja"}}',
      '{"nested":{"constructor":{"prototype":{"polluted":"ja"}}}}',
    ]) {
      const res = await app.inject({ method: 'PUT', url: '/api/plugins/p/config', headers: { 'content-type': 'application/json' }, payload: body });
      expect(res.statusCode).toBeLessThan(500);
    }
    expect({}.polluted).toBeUndefined();
    expect(JSON.stringify(pm.configs.p)).not.toMatch(/polluted|__proto__|constructor/);
  });

  it('form roundtrip keeps inputBindings, disabledControls and topicRoutes', async () => {
    const stored = {
      password: 'pw', host: 'h',
      inputBindings: [{ id: 'b1', mqttTopic: 't', token: 'bt' }],
      disabledControls: ['u1'],
      topicRoutes: { a: 'b' },
    };
    const pm = pluginManager({ p: stored });
    await boot(pm);
    const { config } = (await app.inject({ method: 'GET', url: '/api/plugins/p/config' })).json();
    expect(config.inputBindings).toBeUndefined();
    await app.inject({ method: 'PUT', url: '/api/plugins/p/config', payload: { ...config, host: 'neu' } });
    expect(pm.configs.p).toEqual({ ...stored, host: 'neu' });
  });
});

describe('secrets in inputBindings (Befund 2)', () => {
  const bindings = [
    { id: 'b1', mqttTopic: 'a', targetUuid: 'u1', refreshToken: 'rt-geheim' },
    { id: 'b2', mqttTopic: 'b', targetUuid: 'u2' },
  ];

  it('GET bindings (config fallback) masks secrets', async () => {
    await boot(pluginManager({ p: { inputBindings: bindings } }));
    const res = await app.inject({ method: 'GET', url: '/api/plugins/p/bindings' });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('rt-geheim');
    expect(res.json()[0].refreshToken).toBe(MASK);
    expect(res.json()[0].mqttTopic).toBe('a');
  });

  it('GET bindings (live instance) masks secrets', async () => {
    const instance = { getInputBindings: () => clone(bindings) };
    await boot(pluginManager({ p: {} }, { instance }));
    const res = await app.inject({ method: 'GET', url: '/api/plugins/p/bindings' });
    expect(res.body).not.toContain('rt-geheim');
  });

  it('export masks secrets', async () => {
    await boot(pluginManager({ p: { inputBindings: bindings } }));
    const res = await app.inject({ method: 'GET', url: '/api/bindings/export' });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('rt-geheim');
    expect(res.json().plugins.p.bindings[0].refreshToken).toBe(MASK);
  });

  it('PUT bindings with the mask keeps the stored secret, matched by id', async () => {
    const pm = pluginManager({ p: { inputBindings: bindings } });
    await boot(pm);
    const got = (await app.inject({ method: 'GET', url: '/api/plugins/p/bindings' })).json();
    const res = await app.inject({ method: 'PUT', url: '/api/plugins/p/bindings', payload: got.reverse() });
    expect(res.statusCode).toBe(200);
    expect(pm.configs.p.inputBindings).toEqual([bindings[1], bindings[0]]);
  });

  it('PUT bindings to a live instance hands over the restored secret', async () => {
    let live = clone(bindings);
    const instance = { getInputBindings: () => clone(live), setInputBindings: vi.fn(async (b) => { live = b; }) };
    await boot(pluginManager({ p: {} }, { instance }));
    const got = (await app.inject({ method: 'GET', url: '/api/plugins/p/bindings' })).json();
    await app.inject({ method: 'PUT', url: '/api/plugins/p/bindings', payload: got });
    expect(instance.setInputBindings.mock.calls[0][0]).toEqual(bindings);
  });

  it('PUT bindings with a mask for an unknown binding id → 400, nothing saved', async () => {
    const pm = pluginManager({ p: { inputBindings: bindings } });
    await boot(pm);
    const res = await app.inject({ method: 'PUT', url: '/api/plugins/p/bindings', payload: [{ id: 'neu', refreshToken: MASK }] });
    expect(res.statusCode).toBe(400);
    expect(pm.configs.p.inputBindings).toEqual(bindings);
  });

  it('PUT bindings never matches by index: reordered identity-less masks → 400', async () => {
    const stored = [{ mqttTopic: 'a', token: 'TA' }, { mqttTopic: 'b', token: 'TB' }];
    const pm = pluginManager({ p: { inputBindings: stored } });
    await boot(pm);
    const res = await app.inject({
      method: 'PUT', url: '/api/plugins/p/bindings',
      payload: [{ mqttTopic: 'b', token: MASK }, { mqttTopic: 'a', token: MASK }],
    });
    expect(res.statusCode).toBe(400);
    expect(pm.configs.p.inputBindings).toEqual(stored);
  });

  it('import replace of a masked export restores secrets by id', async () => {
    const pm = pluginManager({ p: { inputBindings: bindings } });
    await boot(pm);
    const payload = (await app.inject({ method: 'GET', url: '/api/bindings/export' })).json();
    const res = await app.inject({ method: 'POST', url: '/api/bindings/import', payload: { mode: 'replace', payload } });
    expect(res.statusCode).toBe(200);
    expect(pm.configs.p.inputBindings).toEqual(bindings);
  });

  it('import copy clones keep the secret of their original', async () => {
    const pm = pluginManager({ p: { inputBindings: bindings } });
    await boot(pm);
    const payload = (await app.inject({ method: 'GET', url: '/api/bindings/export' })).json();
    await app.inject({ method: 'POST', url: '/api/bindings/import', payload: { mode: 'copy', payload } });
    const saved = pm.configs.p.inputBindings;
    expect(saved).toHaveLength(4);
    expect(saved[2].refreshToken).toBe('rt-geheim');
    expect(JSON.stringify(saved)).not.toContain(MASK);
  });

  it('import with a mask that has no stored counterpart → 400, nothing saved', async () => {
    const pm = pluginManager({ p: { inputBindings: [] } });
    await boot(pm);
    const payload = {
      type: 'mqtt-master-bindings-export', version: 1, scope: 'all',
      plugins: { p: { bindings: [{ id: 'x', refreshToken: MASK }] } },
    };
    const res = await app.inject({ method: 'POST', url: '/api/bindings/import', payload: { mode: 'merge', payload } });
    expect(res.statusCode).toBe(400);
    expect(pm.configs.p.inputBindings).toEqual([]);
  });

  it('import checks every plugin before the first write: valid change for a + bad mask for b → 400, a unchanged', async () => {
    const pm = pluginManager({ a: { inputBindings: bindings }, b: { inputBindings: [] } });
    await boot(pm);
    const payload = {
      type: 'mqtt-master-bindings-export', version: 1, scope: 'all',
      plugins: {
        a: { bindings: [{ id: 'b3', mqttTopic: 'neu', targetUuid: 'u3' }] },
        b: { bindings: [{ id: 'x', refreshToken: MASK }] },
      },
    };
    const res = await app.inject({ method: 'POST', url: '/api/bindings/import', payload: { mode: 'replace', payload } });
    expect(res.statusCode).toBe(400);
    expect(pm.configs.a.inputBindings).toEqual(bindings);
    expect(pm.configs.b.inputBindings).toEqual([]);
    expect(pm.setConfig).not.toHaveBeenCalled();
  });
});
