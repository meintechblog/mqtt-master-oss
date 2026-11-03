/**
 * (Befund B-geheim-1, hoch): The config service treats dots as
 * path separators, so GET /api/plugins/<plugin>.<key>/config used to return a
 * single decrypted value unmasked. Every :id route only accepts a registered
 * plugin id; PluginManager.getConfig/setConfig refuse anything else.
 *
 * Runs against the real ConfigService and PluginManager (no mock that ignores
 * the id), so the dotted path is exercised exactly as on a real host.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import apiPlugins from '../../../server/routes/api-plugins.js';
import { ConfigService } from '../../../server/services/config-service.js';
import { PluginManager } from '../../../server/services/plugin-manager.js';

const MASK = '••••••••';
const silent = { info() {}, warn() {}, error() {}, debug() {} };

describe('plugin id guard', () => {
  let dir;
  let savedSecret;
  let configService;
  let pm;
  let app;

  beforeEach(async () => {
    savedSecret = process.env.ENCRYPTION_SECRET;
    process.env.ENCRYPTION_SECRET = 'test-secret-id-guard-0123456789';
    dir = await mkdtemp(join(tmpdir(), 'mqtt-master-id-guard-'));
    configService = new ConfigService(join(dir, 'config.json'));
    configService.set('plugins.house1', {
      host: '192.0.2.5',
      user: 'mqtt-master',
      password: '0123456789',
      inputBindings: [{ id: 'b1', mqttTopic: 'a/b', targetUuid: 'u1' }],
    });
    pm = new PluginManager({ pluginDir: dir, configService, mqttService: {}, logger: silent });
    pm.plugins.set('house1', {
      id: 'house1', name: 'house1', status: 'stopped', instance: null, error: null,
      modulePath: join(dir, 'missing.js'), configSchema: { properties: { password: { type: 'string', format: 'password' } } },
    });
    app = Fastify({ logger: false });
    app.decorate('pluginManager', pm);
    app.decorate('configService', configService);
    await app.register(apiPlugins);
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
    if (savedSecret === undefined) delete process.env.ENCRYPTION_SECRET;
    else process.env.ENCRYPTION_SECRET = savedSecret;
  });

  it('GET config of a registered plugin still works and masks the password', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/plugins/house1/config' });
    expect(res.statusCode).toBe(200);
    expect(res.json().config.password).toBe(MASK);
    expect(res.body).not.toContain('0123456789');
  });

  for (const id of ['house1.password', 'house1%2Epassword', 'house1.inputBindings', 'HOUSE1', '__proto__', 'constructor', 'unbekannt']) {
    it(`GET /api/plugins/${id}/config → 404 without any value`, async () => {
      const res = await app.inject({ method: 'GET', url: `/api/plugins/${id}/config` });
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain('0123456789');
      expect(res.body).not.toMatch(/"0":"0"/);
    });
  }

  it('PUT config with a dotted id → 404, stored password untouched', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/plugins/house1.password/config', payload: { x: 1 } });
    expect(res.statusCode).toBe(404);
    expect(configService.get('plugins.house1.password')).toBe('0123456789');
  });

  it('PUT bindings with a dotted id → 404, nothing written into the plugin', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/plugins/house1.password/bindings', payload: [] });
    expect(res.statusCode).toBe(404);
    expect(configService.get('plugins.house1.password')).toBe('0123456789');
  });

  it('GET bindings with a dotted id → 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/plugins/house1.inputBindings/bindings' });
    expect(res.statusCode).toBe(404);
  });

  it('PUT config on __proto__ does not pollute Object.prototype', async () => {
    await app.inject({ method: 'PUT', url: '/api/plugins/__proto__/config', payload: { polluted: 'ja' } });
    expect({}.polluted).toBeUndefined();
  });

  describe('PluginManager', () => {
    it('getConfig refuses dotted, unknown and prototype ids', () => {
      for (const id of ['house1.password', 'unbekannt', '__proto__', 'constructor', '', undefined]) {
        expect(() => pm.getConfig(id)).toThrow(/not found/);
      }
      expect(pm.getConfig('house1').password).toBe('0123456789');
    });

    it('setConfig refuses dotted and unknown ids and writes nothing', async () => {
      await expect(pm.setConfig('house1.password', 'neu')).rejects.toThrow(/not found/);
      await expect(pm.setConfig('neu', {})).rejects.toThrow(/not found/);
      expect(configService.get('plugins.house1.password')).toBe('0123456789');
      expect(configService.get('plugins.neu')).toBeUndefined();
    });
  });
});
