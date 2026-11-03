/**
 * GET /api/plugins/:id/config
 * is open to the whole LAN, so every secret goes out masked – not only the
 * schema fields with format "password", but every key the config service
 * encrypts (…password, …token, …secret, apiKey, credentials), at any depth.
 * Sending the mask back with PUT keeps the stored value.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import apiPlugins from '../../../server/routes/api-plugins.js';

const MASK = '••••••••';

function stored() {
  return {
    username: 'robot@example.org',
    password: 'kennwort',
    refreshToken: 'rt-geheim',
    country: 'eu',
    devices: [{ key: 'eg', name: 'X40', accessToken: 'at-geheim' }],
    nested: { apiKey: 'ak-geheim', clientSecret: 'cs-geheim', note: 'sichtbar' },
    emptyToken: '',
  };
}

function pluginManager(running) {
  let config = stored();
  return {
    getConfig: vi.fn(() => JSON.parse(JSON.stringify(config))),
    setConfig: vi.fn(async (_id, data) => { config = data; }),
    getInstance: vi.fn(() => (running ? {
      getConfigSchema: () => ({ properties: { username: { type: 'string' }, password: { type: 'string', format: 'password' } } }),
    } : null)),
    getSchema: vi.fn(() => ({})),
    getStatus: vi.fn(() => ({ status: running ? 'running' : 'stopped' })),
    reload: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    listAll: vi.fn(async () => []),
  };
}

describe('plugin config secrets', () => {
  let app;
  let pm;

  async function boot(running = true) {
    app = Fastify({ logger: false });
    pm = pluginManager(running);
    app.decorate('pluginManager', pm);
    app.decorate('configService', { get: (_k, f) => f, set: vi.fn(), save: vi.fn(async () => {}) });
    await app.register(apiPlugins);
    await app.ready();
  }

  afterEach(async () => { await app?.close(); });

  for (const running of [true, false]) {
    describe(running ? 'running plugin (live schema)' : 'stopped plugin (no schema)', () => {
      beforeEach(async () => { await boot(running); });

      it('GET masks every secret, also outside the schema and nested', async () => {
        const res = await app.inject({ method: 'GET', url: '/api/plugins/dreame/config' });
        expect(res.statusCode).toBe(200);
        expect(res.body).not.toMatch(/kennwort|rt-geheim|at-geheim|ak-geheim|cs-geheim/);
        const { config } = res.json();
        expect(config.password).toBe(MASK);
        expect(config.refreshToken).toBe(MASK);
        expect(config.devices[0].accessToken).toBe(MASK);
        expect(config.nested.apiKey).toBe(MASK);
        expect(config.nested.clientSecret).toBe(MASK);
        // non-secrets and empty secrets stay as they are
        expect(config.username).toBe('robot@example.org');
        expect(config.devices[0].name).toBe('X40');
        expect(config.nested.note).toBe('sichtbar');
        expect(config.emptyToken).toBe('');
      });

      it('PUT with the masks back keeps every stored secret', async () => {
        const { config } = (await app.inject({ method: 'GET', url: '/api/plugins/dreame/config' })).json();
        const res = await app.inject({ method: 'PUT', url: '/api/plugins/dreame/config', payload: { ...config, country: 'de' } });
        expect(res.statusCode).toBe(200);
        const saved = pm.setConfig.mock.calls[0][1];
        expect(saved).toMatchObject({ ...stored(), country: 'de' });
      });

      it('PUT with a new value replaces only that secret', async () => {
        const { config } = (await app.inject({ method: 'GET', url: '/api/plugins/dreame/config' })).json();
        config.nested.apiKey = 'ak-neu';
        await app.inject({ method: 'PUT', url: '/api/plugins/dreame/config', payload: config });
        const saved = pm.setConfig.mock.calls[0][1];
        expect(saved.nested.apiKey).toBe('ak-neu');
        expect(saved.refreshToken).toBe('rt-geheim');
        expect(saved.devices[0].accessToken).toBe('at-geheim');
      });
    });
  }
});
