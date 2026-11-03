import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PluginManager } from '../server/services/plugin-manager.js';
import { ConfigService } from '../server/services/config-service.js';

const TMP_DIR = '/tmp/mqtt-master-plugin-test';
const PLUGINS_DIR = join(TMP_DIR, 'plugins');
const CONFIG_PATH = join(TMP_DIR, 'config.json');

function createMockMqtt() {
  return {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    publish: vi.fn(),
    isConnected: vi.fn(() => true),
    on: vi.fn(),
    removeListener: vi.fn(),
  };
}

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => createMockLogger()),
  };
}

async function writePlugin(dir, code) {
  const pluginDir = join(PLUGINS_DIR, dir);
  await mkdir(pluginDir, { recursive: true });
  await writeFile(join(pluginDir, 'plugin.js'), code);
}

/**
 * Register a plugin with the ConfigService so PluginManager.discover() picks it
 * up. As of v1.1 the discover() pass only registers plugins that have a config
 * entry under `plugins.<id>` -- filesystem presence alone is no longer enough
 * (templates without config are still tracked, but they're not in
 * pm.plugins/pm.listAll()). Tests must opt the plugin into the active set.
 */
async function registerPluginInConfig(configService, id, config = {}) {
  configService.set(`plugins.${id}`, config);
  await configService.save();
}

const GOOD_PLUGIN = `
export default class TestPlugin {
  constructor() { this.running = false; }
  async start(ctx) { this.running = true; this.ctx = ctx; }
  async stop() { this.running = false; }
  getStatus() { return { running: this.running }; }
  getConfigSchema() { return { type: 'object', properties: { foo: { type: 'string' } } }; }
}
`;

const CRASH_PLUGIN = `
export default class CrashPlugin {
  async start() { throw new Error('Plugin exploded'); }
  async stop() {}
  getStatus() { return { running: false }; }
  getConfigSchema() { return {}; }
}
`;

describe('PluginManager', () => {
  let configService;
  let mqttService;
  let logger;

  beforeEach(async () => {
    await mkdir(PLUGINS_DIR, { recursive: true });
    await writeFile(CONFIG_PATH, JSON.stringify({}));
    configService = new ConfigService(CONFIG_PATH);
    await configService.load();
    mqttService = createMockMqtt();
    logger = createMockLogger();
  });

  afterEach(async () => {
    await rm(TMP_DIR, { recursive: true, force: true });
  });

  describe('discover()', () => {
    it('finds plugin directories that contain plugin.js (and have a config entry)', async () => {
      await writePlugin('alpha', GOOD_PLUGIN);
      await writePlugin('beta', GOOD_PLUGIN);
      // directory without plugin.js should be ignored
      await mkdir(join(PLUGINS_DIR, 'no-plugin'), { recursive: true });
      await writeFile(join(PLUGINS_DIR, 'no-plugin', 'readme.txt'), 'nothing');

      // v1.1 contract: discover() only registers plugins that have a config entry.
      await registerPluginInConfig(configService, 'alpha');
      await registerPluginInConfig(configService, 'beta');

      const pm = new PluginManager({ pluginDir: PLUGINS_DIR, configService, mqttService, logger });
      await pm.discover();

      const list = await pm.listAll();
      expect(list).toHaveLength(2);
      const ids = list.map((p) => p.id).sort();
      expect(ids).toEqual(['alpha', 'beta']);
    });

    it('returns empty list when no plugins exist', async () => {
      const pm = new PluginManager({ pluginDir: PLUGINS_DIR, configService, mqttService, logger });
      await pm.discover();
      expect(await pm.listAll()).toEqual([]);
    });
  });

  describe('start()', () => {
    it('calls plugin.start(context) and status becomes running', async () => {
      await writePlugin('test-plug', GOOD_PLUGIN);
      await registerPluginInConfig(configService, 'test-plug');
      const pm = new PluginManager({ pluginDir: PLUGINS_DIR, configService, mqttService, logger });
      await pm.discover();
      await pm.start('test-plug');

      const status = pm.getStatus('test-plug');
      expect(status.status).toBe('running');
      expect(status.error).toBeNull();
    });

    it('throws on unknown plugin', async () => {
      const pm = new PluginManager({ pluginDir: PLUGINS_DIR, configService, mqttService, logger });
      await pm.discover();
      await expect(pm.start('nonexistent')).rejects.toThrow(/not found/i);
    });

    it('sets status to error with message when plugin crashes on start', async () => {
      await writePlugin('crasher', CRASH_PLUGIN);
      await registerPluginInConfig(configService, 'crasher');
      const pm = new PluginManager({ pluginDir: PLUGINS_DIR, configService, mqttService, logger });
      await pm.discover();
      await pm.start('crasher');

      const status = pm.getStatus('crasher');
      expect(status.status).toBe('error');
      expect(status.error).toContain('Plugin exploded');
    });
  });

  describe('stop()', () => {
    it('calls plugin.stop() and status becomes stopped', async () => {
      await writePlugin('stoppable', GOOD_PLUGIN);
      await registerPluginInConfig(configService, 'stoppable');
      const pm = new PluginManager({ pluginDir: PLUGINS_DIR, configService, mqttService, logger });
      await pm.discover();
      await pm.start('stoppable');
      expect(pm.getStatus('stoppable').status).toBe('running');

      await pm.stop('stoppable');
      expect(pm.getStatus('stoppable').status).toBe('stopped');
    });
  });

  describe('reload()', () => {
    it('stops then re-imports and starts the plugin', async () => {
      await writePlugin('reloadable', GOOD_PLUGIN);
      await registerPluginInConfig(configService, 'reloadable');
      const pm = new PluginManager({ pluginDir: PLUGINS_DIR, configService, mqttService, logger });
      await pm.discover();
      await pm.start('reloadable');
      expect(pm.getStatus('reloadable').status).toBe('running');

      await pm.reload('reloadable');
      expect(pm.getStatus('reloadable').status).toBe('running');
    });
  });

  describe('config', () => {
    it('getConfig returns config from configService under plugins.<id>', async () => {
      configService.set('plugins.myplug', { host: 'example.com' });
      await configService.save();
      await writePlugin('myplug', GOOD_PLUGIN);
      const pm = new PluginManager({ pluginDir: PLUGINS_DIR, configService, mqttService, logger });
      await pm.discover();

      const cfg = pm.getConfig('myplug');
      expect(cfg).toEqual({ host: 'example.com' });
    });

    it('setConfig persists config via configService', async () => {
      await writePlugin('cfgplug', GOOD_PLUGIN);
      await registerPluginInConfig(configService, 'cfgplug');
      const pm = new PluginManager({ pluginDir: PLUGINS_DIR, configService, mqttService, logger });
      await pm.discover();

      await pm.setConfig('cfgplug', { greeting: 'Hi' });
      expect(configService.get('plugins.cfgplug')).toEqual({ greeting: 'Hi' });

      // Verify persisted to disk
      const raw = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
      expect(raw.plugins.cfgplug).toEqual({ greeting: 'Hi' });
    });

    it('getConfig/setConfig refuse a template that is not a configured instance', async () => {
      await writePlugin('nurvorlage', GOOD_PLUGIN);
      const pm = new PluginManager({ pluginDir: PLUGINS_DIR, configService, mqttService, logger });
      await pm.discover();

      expect(() => pm.getConfig('nurvorlage')).toThrow(/not found/);
      await expect(pm.setConfig('nurvorlage', { greeting: 'Hi' })).rejects.toThrow(/not found/);
      expect(configService.get('plugins.nurvorlage')).toBeUndefined();
    });
  });

  describe('listAll()', () => {
    it('returns array of {id, name, status, error}', async () => {
      await writePlugin('one', GOOD_PLUGIN);
      await writePlugin('two', GOOD_PLUGIN);
      await registerPluginInConfig(configService, 'one');
      await registerPluginInConfig(configService, 'two');
      const pm = new PluginManager({ pluginDir: PLUGINS_DIR, configService, mqttService, logger });
      await pm.discover();

      const list = await pm.listAll();
      expect(list).toHaveLength(2);
      for (const item of list) {
        expect(item).toHaveProperty('id');
        expect(item).toHaveProperty('name');
        expect(item).toHaveProperty('status', 'stopped');
        expect(item).toHaveProperty('error', null);
      }
    });
  });

  describe('getInstancesByType()', () => {
    it('returns the running instances of a type, including additional instances', async () => {
      await writePlugin('dreame', GOOD_PLUGIN);
      await writePlugin('alpha', GOOD_PLUGIN);
      await registerPluginInConfig(configService, 'dreame');
      await registerPluginInConfig(configService, 'alpha');
      const pm = new PluginManager({ pluginDir: PLUGINS_DIR, configService, mqttService, logger });
      await pm.discover();
      await pm.createInstance('dreame', 'dreame-og');
      await pm.start('dreame');
      await pm.start('dreame-og');
      await pm.start('alpha');

      const found = pm.getInstancesByType('dreame');
      expect(found).toHaveLength(2);
      expect(found).toContain(pm.getInstance('dreame'));
      expect(found).toContain(pm.getInstance('dreame-og'));

      await pm.stop('dreame-og');
      expect(pm.getInstancesByType('dreame')).toEqual([pm.getInstance('dreame')]);
    });
  });

  describe('createInstance() — config preservation', () => {
    it('preserves existing inputBindings when re-creating an instance whose dir was removed', async () => {
      // Pre-seed: an existing plugins.house1 config block with bindings + prefix.
      const priorConfig = {
        displayName: 'House1',
        prefix: 'house1',
        inputBindings: [
          { id: 'b-1', enabled: true, mqttTopic: 't', jsonField: 'f', targetUuid: 'u-1' },
        ],
      };
      configService.set('plugins.house1', priorConfig);
      await configService.save();

      // Register a loxone template so createInstance can find it.
      await writePlugin('loxone', GOOD_PLUGIN);

      const pm = new PluginManager({ pluginDir: PLUGINS_DIR, configService, mqttService, logger });
      await pm.discover();

      // Sanity: house1 is NOT yet registered (no plugin.js dir exists for it).
      expect(pm.plugins.has('house1')).toBe(false);

      await pm.createInstance('loxone', 'house1');

      // Config must be untouched.
      const after = configService.get('plugins.house1');
      expect(after).toEqual(priorConfig);
      expect(after.inputBindings).toHaveLength(1);
      expect(after.inputBindings[0].id).toBe('b-1');
      expect(after.prefix).toBe('house1');

      // Re-export file must have been written.
      const reExport = await readFile(join(PLUGINS_DIR, 'house1', 'plugin.js'), 'utf-8');
      expect(reExport).toContain("export { default } from");
      expect(reExport).toContain('loxone');
    });

    it('seeds default config when no prior config exists', async () => {
      await writePlugin('loxone', GOOD_PLUGIN);

      const pm = new PluginManager({ pluginDir: PLUGINS_DIR, configService, mqttService, logger });
      await pm.discover();

      // Sanity: no prior config for fresh-instance.
      expect(configService.get('plugins.fresh-instance', undefined)).toBeUndefined();

      await pm.createInstance('loxone', 'fresh-instance');

      const cfg = configService.get('plugins.fresh-instance');
      expect(cfg).toEqual({ displayName: '' });
    });

    it('discover() logs an error when a configured plugin has no dir', async () => {
      // Provide a real loxone template so it's not the missing one.
      await writePlugin('loxone', GOOD_PLUGIN);

      // Configure an orphan plugin with no corresponding plugin.js anywhere.
      configService.set('plugins.orphan', { displayName: 'Orphan', prefix: 'orphan' });
      await configService.save();

      const pm = new PluginManager({ pluginDir: PLUGINS_DIR, configService, mqttService, logger });
      await pm.discover();

      // Error logged about orphan.
      const errorCalls = logger.error.mock.calls.map((args) => args.join(' '));
      const matched = errorCalls.find(
        (msg) => msg.includes('orphan') && (msg.includes('missing') || msg.includes('will not be loaded'))
      );
      expect(matched).toBeTruthy();

      // Orphan is NOT in listAll().
      const list = await pm.listAll();
      const ids = list.map((p) => p.id);
      expect(ids).not.toContain('orphan');
    });
  });
});

describe('ConfigService set/save', () => {
  const TMP = '/tmp/mqtt-master-cfg-setsave';
  const CFG_PATH = join(TMP, 'config.json');

  beforeEach(async () => {
    await mkdir(TMP, { recursive: true });
    await writeFile(CFG_PATH, JSON.stringify({ existing: 'value' }));
  });

  afterEach(async () => {
    await rm(TMP, { recursive: true, force: true });
  });

  it('set() writes a dot-notation key into config', async () => {
    const svc = new ConfigService(CFG_PATH);
    await svc.load();
    svc.set('plugins.example.host', 'localhost');
    expect(svc.get('plugins.example.host')).toBe('localhost');
  });

  it('set() creates nested objects as needed', async () => {
    const svc = new ConfigService(CFG_PATH);
    await svc.load();
    svc.set('a.b.c', 42);
    expect(svc.get('a.b.c')).toBe(42);
  });

  it('set() with non-dot key sets top-level', async () => {
    const svc = new ConfigService(CFG_PATH);
    await svc.load();
    svc.set('topLevel', 'yes');
    expect(svc.get('topLevel')).toBe('yes');
  });

  it('save() persists config to disk', async () => {
    const svc = new ConfigService(CFG_PATH);
    await svc.load();
    svc.set('plugins.test', { foo: 'bar' });
    await svc.save();

    const raw = JSON.parse(await readFile(CFG_PATH, 'utf-8'));
    expect(raw.plugins.test).toEqual({ foo: 'bar' });
    expect(raw.existing).toBe('value');
  });
});
