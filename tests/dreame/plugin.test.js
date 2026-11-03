import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import DreamePlugin from '../../plugins/dreame/plugin.js';
import { getConfigSchema } from '../../plugins/dreame/config-schema.js';
import { makeMqtt, makeLogger, makeConfig, makeFakeCloud, allLogged, DID_EG, DID_OG } from './helpers.js';

const NOW = new Date('2026-10-27T09:00:00Z').getTime();

describe('DreamePlugin publishing', () => {
  let mqtt; let logger; let cloud; let plugin; let config;

  async function boot({ cloudOver, cfg } = {}) {
    mqtt = makeMqtt(); logger = makeLogger(); cloud = makeFakeCloud(cloudOver); plugin = new DreamePlugin();
    config = makeConfig(cfg);
    await plugin.start({
      mqttService: mqtt, configService: config, logger, pluginId: 'dreame',
      deps: { createCloud: vi.fn(() => cloud) },
    });
  }

  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); delete globalThis[Symbol.for('mqtt-master.dreame.ids')]; });
  afterEach(async () => { await plugin?.stop(); vi.useRealTimers(); });

  it('announces online=1 retained on start and online=0 retained on stop', async () => {
    await boot();
    expect(mqtt.last('haus/sauger/online')).toMatchObject({ payload: { v: 1, ts: NOW }, opts: { retain: true } });
    await plugin.stop();
    expect(mqtt.last('haus/sauger/online')).toMatchObject({ payload: { v: 0 }, opts: { retain: true } });
  });

  it('publishes zustand, akku-prozent, fehler and verbunden as retained {"v","ts"} JSON', async () => {
    await boot();
    for (const [sub, v] of [['zustand', 'laedt'], ['akku-prozent', 77], ['fehler', 0], ['verbunden', 1]]) {
      const p = mqtt.last(`haus/sauger/eg/${sub}`);
      expect(p, sub).toBeTruthy();
      expect(p.payload).toEqual({ v, ts: NOW });
      expect(p.opts).toEqual({ retain: true });
      expect(typeof p.raw).toBe('string');
    }
    expect(mqtt.last('haus/sauger/og/zustand').payload.v).toBe('laedt');
  });

  it('publishes numbers as integers', async () => {
    await boot({ cloudOver: { getProperties: vi.fn(async () => ({ reachable: true, values: { '2.1': 1, '2.2': 0, '3.1': 55.0 } })) } });
    expect(mqtt.last('haus/sauger/eg/akku-prozent').payload.v).toBe(55);
    expect(Number.isInteger(mqtt.last('haus/sauger/eg/akku-prozent').payload.v)).toBe(true);
  });

  it('publishes the error code and the fehler state', async () => {
    await boot({ cloudOver: { getProperties: vi.fn(async () => ({ reachable: true, values: { '2.1': 4, '2.2': 12, '3.1': 50 } })) } });
    expect(mqtt.last('haus/sauger/eg/zustand').payload.v).toBe('fehler');
    expect(mqtt.last('haus/sauger/eg/fehler').payload.v).toBe(12);
  });

  it('honours a configurable topic root', async () => {
    await boot({ cfg: { topicRoot: 'test/saug' } });
    expect(mqtt.last('test/saug/online')).toBeTruthy();
    expect(mqtt.last('test/saug/eg/zustand')).toBeTruthy();
    expect(mqtt.published().some((p) => p.topic.startsWith('haus/sauger'))).toBe(false);
  });

  it('only republishes on change, with a slow heartbeat', async () => {
    await boot();
    const count = () => mqtt.published().filter((p) => p.topic === 'haus/sauger/eg/zustand').length;
    expect(count()).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(count()).toBe(1);
    cloud.getProperties.mockResolvedValue({ reachable: true, values: { '2.1': 1, '2.2': 0, '3.1': 76 } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(count()).toBe(2);
    expect(mqtt.last('haus/sauger/eg/zustand').payload.v).toBe('reinigt');
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(count()).toBeGreaterThan(2); // heartbeat refreshes ts
  });

  it('polls every pollSeconds', async () => {
    await boot({ cfg: { pollSeconds: 30 } });
    const base = cloud.getProperties.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(cloud.getProperties.mock.calls.length).toBe(base + 2);
  });

  it('applies pushed property changes immediately', async () => {
    await boot();
    expect(cloud.startPush).toHaveBeenCalled();
    cloud.pushHandler(DID_EG, [{ siid: 2, piid: 1, value: 1 }, { siid: 3, piid: 1, value: 70 }]);
    expect(mqtt.last('haus/sauger/eg/zustand').payload.v).toBe('reinigt');
    expect(mqtt.last('haus/sauger/eg/akku-prozent').payload.v).toBe(70);
    expect(mqtt.last('haus/sauger/og/zustand').payload.v).toBe('laedt');
    // unknown device ids are dropped silently
    cloud.pushHandler('999', [{ siid: 2, piid: 1, value: 1 }]);
  });

  it('publishes verbunden=0 when the device is unreachable or the call fails', async () => {
    await boot({ cloudOver: { getProperties: vi.fn(async (d) => (d.did === DID_EG
      ? { reachable: false, values: {} } : (() => { throw new Error('HTTP 500'); })())) } });
    expect(mqtt.last('haus/sauger/eg/verbunden').payload.v).toBe(0);
    expect(mqtt.last('haus/sauger/og/verbunden').payload.v).toBe(0);
  });

  it('survives a failed login at start, reports verbunden=0 and retries on the next poll', async () => {
    await boot({ cloudOver: {} });
    await plugin.stop();
    mqtt = makeMqtt(); logger = makeLogger();
    cloud = makeFakeCloud();
    cloud._loggedIn = false;
    cloud.login.mockImplementation(async () => cloud._loggedIn);
    plugin = new DreamePlugin();
    await plugin.start({ mqttService: mqtt, configService: makeConfig(), logger, pluginId: 'dreame', deps: { createCloud: () => cloud } });
    expect(mqtt.last('haus/sauger/online').payload.v).toBe(1);
    expect(mqtt.last('haus/sauger/eg/verbunden').payload.v).toBe(0);
    cloud._loggedIn = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mqtt.last('haus/sauger/eg/verbunden').payload.v).toBe(1);
  });

  it('stops retrying the login after the credentials were refused', async () => {
    await boot();
    await plugin.stop();
    mqtt = makeMqtt(); logger = makeLogger();
    cloud = makeFakeCloud();
    cloud._loggedIn = false; cloud.authFailed = true;
    plugin = new DreamePlugin();
    await plugin.start({ mqttService: mqtt, configService: makeConfig(), logger, pluginId: 'dreame', deps: { createCloud: () => cloud } });
    const n = cloud.login.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(cloud.login.mock.calls.length).toBe(n);
  });

  // a device list that resolves after stop() must not open push connections.
  it('does not start push when the device list resolves after stop()', async () => {
    mqtt = makeMqtt(); logger = makeLogger(); cloud = makeFakeCloud(); plugin = new DreamePlugin();
    let release;
    cloud.listDevices.mockImplementation(() => new Promise((r) => { release = () => r(cloud.records); }));
    const starting = plugin.start({ mqttService: mqtt, configService: makeConfig(), logger, pluginId: 'dreame', deps: { createCloud: () => cloud } });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await plugin.stop();
    release();
    await starting;
    await vi.advanceTimersByTimeAsync(0);
    expect(cloud.startPush).not.toHaveBeenCalled();
  });

  it('closes the cloud client on stop (aborts calls in flight)', async () => {
    await boot({ cloudOver: { close: vi.fn() } });
    await plugin.stop();
    expect(cloud.close).toHaveBeenCalled();
  });

  // a later poll that lacks a value must not keep the old value alive.
  it('does not republish a value the latest poll no longer delivers', async () => {
    let n = 0;
    await boot({ cloudOver: { getProperties: vi.fn(async () => (++n === 1
      ? { reachable: true, values: { '2.1': 6, '2.2': 0, '3.1': 77 } }
      : { reachable: true, values: { '2.1': 6, '2.2': 0 } })) } });
    const before = mqtt.published().filter((p) => p.topic === 'haus/sauger/eg/akku-prozent').length;
    await vi.advanceTimersByTimeAsync(11 * 60_000); // past the heartbeat
    const after = mqtt.published().filter((p) => p.topic === 'haus/sauger/eg/akku-prozent').length;
    expect(after).toBe(before);
    expect(mqtt.published().filter((p) => p.topic === 'haus/sauger/eg/zustand').length).toBeGreaterThan(1);
  });

  it('never puts device ids, serials or macs into topics or payloads', async () => {
    await boot();
    cloud.pushHandler(DID_EG, [{ siid: 2, piid: 1, value: 1 }]);
    mqtt.send('loxone/sauger-eg/befehl', 0); mqtt.send('loxone/sauger-eg/befehl', 1);
    await vi.advanceTimersByTimeAsync(0);
    for (const p of mqtt.published()) {
      expect(p.topic).not.toContain(DID_EG);
      expect(p.topic).not.toContain(DID_OG);
      expect(p.raw).not.toContain(DID_EG);
      expect(p.raw).not.toContain(DID_OG);
    }
  });

  it('persists a new refresh key through the config service', async () => {
    mqtt = makeMqtt(); logger = makeLogger(); cloud = makeFakeCloud(); plugin = new DreamePlugin(); config = makeConfig();
    let opts;
    await plugin.start({ mqttService: mqtt, configService: config, logger, pluginId: 'dreame', deps: { createCloud: (o) => { opts = o; return cloud; } } });
    await opts.onRefreshToken('RT-new');
    expect(config.store.plugins.dreame.refreshToken).toBe('RT-new');
    expect(config.save).toHaveBeenCalled();
    // existing settings are kept
    expect(config.store.plugins.dreame.username).toBe('me@example.org');
    // and the stored key is handed to the cloud on the next start
    expect(opts.refreshToken).toBeUndefined();
  });

  it('refuses to start without credentials or devices', async () => {
    mqtt = makeMqtt(); logger = makeLogger(); plugin = new DreamePlugin();
    const ctx = (cfg) => ({ mqttService: mqtt, configService: makeConfig(cfg), logger, pluginId: 'dreame', deps: { createCloud: () => makeFakeCloud() } });
    await expect(plugin.start(ctx({ username: '' }))).rejects.toThrow(/username/);
    await expect(plugin.start(ctx({ password: '', refreshToken: '' }))).rejects.toThrow(/password|refresh/i);
    await expect(plugin.start(ctx({ devices: [] }))).rejects.toThrow(/devices/);
    await expect(plugin.start(ctx({ devices: [{ key: 'EG/../x', model: 'm', befehlThema: 'a/b' }] }))).rejects.toThrow(/key/);
  });

  it('warns (with the key only) about a configured device the account does not have', async () => {
    await boot({ cfg: { devices: [{ key: 'eg', did: '9999999', befehlThema: 'loxone/x/befehl' }] } });
    expect(logger.warn).toHaveBeenCalled();
    expect(allLogged(logger)).not.toContain('9999999');
  });

  it('getStatus reports running state without identifiers', async () => {
    await boot();
    const s = plugin.getStatus();
    expect(s.running).toBe(true);
    expect(JSON.stringify(s)).not.toContain(DID_EG);
    await plugin.stop();
    expect(plugin.getStatus().running).toBe(false);
  });
});

describe('config schema', () => {
  it('declares password as a secret field and sensible defaults', () => {
    const { properties } = getConfigSchema();
    expect(properties.password.format).toBe('password');
    expect(properties.country.default).toBe('eu');
    expect(properties.pollSeconds.default).toBe(60);
    expect(properties.topicRoot.default).toBe('haus/sauger');
    expect(properties.autoStart.default).toBe(false);
    // arrays of objects cannot be edited by the generic form renderer
    expect(properties.devices).toBeUndefined();
  });

  it('is exposed on the plugin instance for the loader', () => {
    expect(new DreamePlugin().getConfigSchema().properties.username).toBeDefined();
  });
});

describe('secret redaction (real cloud client, mocked transport)', () => {
  const PW = 'geheim-passwort-123';
  const PW_MD5 = createHash('md5').update(PW + 'RAylYC%fmSKp7%Tq').digest('hex');
  const AT = 'AT-secret-token-99';
  const RT = 'RT-secret-refresh-77';
  const UID = 'uid-secret-4711';
  const MAC = 'aa:bb:cc:dd:ee:ff';
  const SECRETS = [PW, PW_MD5, AT, RT, UID, MAC, DID_EG, DID_OG, 'me@example.org'];

  let mqtt; let logger; let plugin; let mode;

  const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s });
  function fetchMock(url, init) {
    const path = new URL(url).pathname;
    if (path.endsWith('/oauth/token')) {
      if (mode === 'login-refused') return json({ error_description: `bad ${PW} ${PW_MD5} me@example.org` }, 401);
      return json({ access_token: AT, refresh_token: RT, expires_in: 3600, uid: UID, region: 'eu', lang: 'de', country: 'DE' });
    }
    if (path.endsWith('/listV2')) {
      return json({ code: 0, data: { page: { records: [
        { did: DID_EG, model: 'dreame.vacuum.r2449a', masterUid: UID, mac: MAC, bindDomain: '10000.mt.eu.iot.dreame.tech:19973' },
        { did: DID_OG, model: 'dreame.vacuum.r2427a', customName: 'Mova OG', masterUid: UID, mac: MAC, bindDomain: '10000.mt.eu.iot.dreame.tech:19973' },
      ] } } });
    }
    if (mode === 'leaky-500') return new Response(`boom ${AT} ${DID_EG} ${init.body}`, { status: 500 });
    if (mode === 'leaky-throw') throw new Error(`socket hang up ${AT} ${UID} ${DID_EG} ${MAC}`);
    return json({ code: 0, data: { result: [{ siid: 2, piid: 1, code: 0, value: 6 }, { siid: 2, piid: 2, code: 0, value: 0 }, { siid: 3, piid: 1, code: 0, value: 61 }] } });
  }

  async function run(m) {
    mode = m;
    mqtt = makeMqtt(); logger = makeLogger(); plugin = new DreamePlugin();
    await plugin.start({
      mqttService: mqtt, configService: makeConfig({ devices: [
        { key: 'eg', model: 'dreame.vacuum.r2449a', befehlThema: 'loxone/sauger-eg/befehl' },
        { key: 'og', name: 'Mova OG', befehlThema: 'loxone/sauger-og/befehl' },
      ] }), logger, pluginId: 'dreame',
      deps: { fetch: vi.fn(fetchMock), sleep: async () => {} },
    });
    mqtt.send('loxone/sauger-eg/befehl', 0);
    mqtt.send('loxone/sauger-eg/befehl', 1);
    await vi.advanceTimersByTimeAsync(61_000);
    await plugin.stop();
  }

  function assertClean() {
    const logs = allLogged(logger);
    const pubs = JSON.stringify(mqtt.publish.mock.calls);
    for (const s of SECRETS) {
      expect(logs, `log leaks ${s}`).not.toContain(s);
      expect(pubs, `publish leaks ${s}`).not.toContain(s);
    }
  }

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('normal operation', async () => { await run('ok'); assertClean(); expect(mqtt.last('haus/sauger/eg/akku-prozent').payload.v).toBe(61); });
  it('login refused with an echoing error body', async () => { await run('login-refused'); assertClean(); });
  it('HTTP 500 whose body echoes secrets and the request', async () => { await run('leaky-500'); assertClean(); });
  it('network errors that embed secrets', async () => { await run('leaky-throw'); assertClean(); });
});
