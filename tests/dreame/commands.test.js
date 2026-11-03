import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseCommandValue, CommandGate } from '../../plugins/dreame/dreame-commands.js';
import DreamePlugin from '../../plugins/dreame/plugin.js';
import { makeMqtt, makeLogger, makeConfig, makeFakeCloud, makePluginManager, allLogged, DID_EG, DEVICES_CFG } from './helpers.js';

// process-wide id memory of the plugin; cleared per test so ids do not leak between tests
const ID_STORE = Symbol.for('mqtt-master.dreame.ids');

describe('parseCommandValue', () => {
  it('reads plain numbers, numeric strings and JSON with "value"', () => {
    expect(parseCommandValue('1')).toBe(1);
    expect(parseCommandValue(' 2 ')).toBe(2);
    expect(parseCommandValue('0.0')).toBe(0);
    expect(parseCommandValue('{"value":1}')).toBe(1);
    expect(parseCommandValue('{"value":"2"}')).toBe(2);
    expect(parseCommandValue('{"v":1,"ts":1}')).toBeNull();
    expect(parseCommandValue('abc')).toBeNull();
    expect(parseCommandValue('')).toBeNull();
    expect(parseCommandValue('NaN')).toBeNull();
    expect(parseCommandValue('{"value":null}')).toBeNull();
  });
});

describe('CommandGate', () => {
  it('ignores retained messages entirely', () => {
    const g = new CommandGate();
    expect(g.accept('1', true)).toBeNull();
    // retained did not count as the first value either
    expect(g.accept('2', false)).toBeNull();
    expect(g.accept('1', false)).toBe('start');
  });

  it('ignores the first value, acts on changes only', () => {
    const g = new CommandGate();
    expect(g.accept('1', false)).toBeNull();
    expect(g.accept('1', false)).toBeNull();
    expect(g.accept('0', false)).toBe('stop');
    expect(g.accept('2', false)).toBe('pause');
    expect(g.accept('1', false)).toBe('start');
  });

  it('ignores unknown values without disturbing the baseline', () => {
    const g = new CommandGate();
    g.accept('1', false);
    expect(g.accept('7', false)).toBeNull();
    expect(g.accept('abc', false)).toBeNull();
    expect(g.accept('1', false)).toBeNull(); // still the same as the baseline
    expect(g.accept('2', false)).toBe('pause');
  });

  it('an unknown first value does not count as the initial sync', () => {
    const g = new CommandGate();
    expect(g.accept('9', false)).toBeNull();
    expect(g.accept('1', false)).toBeNull(); // this one is the first valid value
    expect(g.accept('2', false)).toBe('pause');
  });

  // a late duplicate of an earlier command must never act again.
  // Payloads with an "id" (P3 steuer/ path, QoS1) are de-duplicated by id.
  it('ignores a repeated id even when it is not the direct predecessor (0,1,2,1-dup)', () => {
    const g = new CommandGate();
    const p = (value, id) => `{"value":${value},"ts":${Date.now()},"id":"${id}"}`;
    expect(g.accept(p(0, 'a1'), false)).toBe('stop'); // an id command acts without an initial sync
    expect(g.accept(p(1, 'a2'), false)).toBe('start');
    expect(g.accept(p(2, 'a3'), false)).toBe('pause');
    expect(g.accept(p(1, 'a2'), false)).toBeNull(); // late QoS1 duplicate
    expect(g.accept(p(1, 'a4'), false)).toBe('start'); // a real new press
  });

  // de-duplication by time, not by count. A duplicate is either still remembered or too old.
  describe('id de-duplication by time', () => {
    const NOW = 1_800_000_000_000;
    const msg = (v, id, ts = NOW) => JSON.stringify({ v, ts, id });
    let log;
    beforeEach(() => { log = vi.fn(); });

    it('a duplicate of the start id is refused after 64+ other ids', () => {
      const g = new CommandGate({ log });
      expect(g.accept(msg(0, 'init'), false, NOW)).toBe('stop'); // acts, no initial sync for id commands
      expect(g.accept(msg(1, 'a'), false, NOW)).toBe('start');
      for (let i = 0; i < 70; i++) g.accept(msg(i % 2 ? 1 : 2, `x${i}`), false, NOW);
      g.accept(msg(2, 'z'), false, NOW);
      expect(g.accept(msg(1, 'a'), false, NOW)).toBeNull(); // no second start
    });

    it('refuses a command whose ts is older than 120 s', () => {
      const g = new CommandGate({ log });
      g.accept(msg(0, 'i'), false, NOW);
      expect(g.accept(msg(1, 'old', NOW - 121_000), false, NOW)).toBeNull();
      expect(g.accept(msg(1, 'fresh', NOW - 119_000), false, NOW)).toBe('start');
    });

    it('refuses a command whose ts lies more than 30 s in the future', () => {
      const g = new CommandGate({ log });
      g.accept(msg(0, 'i'), false, NOW);
      expect(g.accept(msg(1, 'fut', NOW + 31_000), false, NOW)).toBeNull();
      expect(g.accept(msg(1, 'ok', NOW + 29_000), false, NOW)).toBe('start');
    });

    it('refuses an id without a usable ts (fail closed)', () => {
      const g = new CommandGate({ log });
      g.accept(msg(0, 'i'), false, NOW);
      expect(g.accept('{"value":1,"id":"n1"}', false, NOW)).toBeNull();
      expect(g.accept('{"v":1,"ts":"x","id":"n2"}', false, NOW)).toBeNull();
    });

    it('keeps an id for 120 s and cleans expired ids on insert', () => {
      const g = new CommandGate({ log });
      g.accept(msg(0, 'i'), false, NOW);
      expect(g.accept(msg(1, 'a'), false, NOW)).toBe('start');
      g.accept(msg(2, 'b', NOW + 10_000), false, NOW + 10_000);
      expect(g.accept(msg(2, 'a'), false, NOW + 119_000)).toBeNull(); // still remembered
      expect(g.accept(msg(1, 'a'), false, NOW + 121_000)).toBeNull(); // forgotten, but too old now
      g.accept(msg(1, 'c', NOW + 200_000), false, NOW + 200_000);
      expect(g._ids.size).toBe(1); // only 'c' is left
    });

    it('refuses new commands (fail closed) when 1024 ids are remembered and none has expired', () => {
      const g = new CommandGate({ log });
      g.accept(msg(0, 'i'), false, NOW);
      for (let i = 0; i < 1023; i++) g.accept(msg(0, `f${i}`), false, NOW);
      expect(g.accept(msg(1, 'late'), false, NOW)).toBeNull();
      expect(log).toHaveBeenCalled();
      // once the old ids expired there is room again
      expect(g.accept(msg(1, 'later', NOW + 150_000), false, NOW + 150_000)).toBe('start');
    });

    it('keeps the behaviour without an id (bare Loxone value)', () => {
      const g = new CommandGate({ log });
      expect(g.accept('0', false, NOW)).toBeNull();
      expect(g.accept('1', false, NOW + 999_999_999)).toBe('start');
    });
  });

  // a command with a valid id is a single command, not a standing value.
  describe('id commands act without an initial sync', () => {
    const NOW = 1_800_000_000_000;
    const msg = (v, id, ts = NOW) => JSON.stringify({ v, ts, id });

    it('after reset(): duplicate start id a is refused, fresh stop id b acts', () => {
      const g = new CommandGate();
      g.accept('0', false, NOW); // initial sync
      expect(g.accept(msg(1, 'a'), false, NOW)).toBe('start');
      g.reset(); // reconnect
      expect(g.accept(msg(1, 'a'), false, NOW)).toBeNull(); // QoS 1 redelivery
      expect(g.accept(msg(0, 'b'), false, NOW)).toBe('stop');
    });

    it('an id command stores the baseline: a bare value of the same size does not act again', () => {
      const g = new CommandGate();
      g.reset();
      expect(g.accept(msg(1, 'a'), false, NOW)).toBe('start');
      expect(g.accept('1', false, NOW)).toBeNull();
      expect(g.accept('2', false, NOW)).toBe('pause');
    });

    // an id command must not end the initial sync, so a standing bare value after it stays a baseline.
    it('after reset() an id stop does not turn a following bare standing value into a start', () => {
      const g = new CommandGate();
      g.accept('0', false, NOW); // initial sync
      g.reset(); // reconnect
      expect(g.accept(msg(0, 'b'), false, NOW)).toBe('stop');
      expect(g.accept('1', false, NOW)).toBeNull(); // Loxone repeats its standing value
    });

    it('a bare value without an id is still only an initial sync', () => {
      const g = new CommandGate();
      expect(g.accept('1', false, NOW)).toBeNull();
    });
  });

  // an id property of the wrong type must not bypass the ts window and the id memory.
  describe('invalid id types are refused', () => {
    const NOW = 1_800_000_000_000;
    it('refuses null, boolean, object, empty, fractional and over-long ids', () => {
      const g = new CommandGate();
      g.accept('0', false, NOW); // initial sync
      const bad = [null, true, {}, '', 1.5, 'x'.repeat(129), [], 1e300];
      for (const id of bad) {
        expect(g.accept(JSON.stringify({ v: 1, id, ts: 0 }), false, NOW), String(JSON.stringify(id)).slice(0, 20)).toBeNull();
        expect(g.accept(JSON.stringify({ v: 1, id, ts: NOW }), false, NOW), String(JSON.stringify(id)).slice(0, 20)).toBeNull();
      }
      expect(g.accept(JSON.stringify({ v: 1, id: 'x'.repeat(128), ts: NOW }), false, NOW)).toBe('start');
    });

    it('a Loxone {"value":1} without an id property keeps working', () => {
      const g = new CommandGate();
      g.accept('{"value":0}', false, NOW);
      expect(g.accept('{"value":1}', false, NOW)).toBe('start');
    });
  });

  it('accepts "v" as the value key of the P3 payload {v, ts, id}', () => {
    expect(parseCommandValue('{"v":2,"ts":1,"id":"x"}')).toBe(2);
  });

  it('reset() makes the next value an initial sync again', () => {
    const g = new CommandGate();
    g.accept('1', false);
    g.reset();
    expect(g.accept('2', false)).toBeNull();
    expect(g.accept('1', false)).toBe('start');
  });
});

describe('plugin command handling', () => {
  let mqtt; let logger; let cloud; let plugin;
  const T_EG = 'loxone/sauger-eg/befehl';
  const T_OG = 'loxone/sauger-og/befehl';
  const ACK_EG = 'haus/sauger/eg/ereignis/befehl';

  let pm;
  async function boot(cloudOver = {}, loxoneValues) {
    mqtt = makeMqtt();
    logger = makeLogger();
    cloud = makeFakeCloud(cloudOver);
    pm = makePluginManager(mqtt, loxoneValues);
    plugin = new DreamePlugin();
    await plugin.start({
      mqttService: mqtt, configService: makeConfig(), logger, pluginId: 'dreame', pluginManager: pm,
      deps: { createCloud: () => cloud },
    });
  }
  /** let pending promises settle without advancing timers */
  const settle = () => vi.advanceTimersByTimeAsync(0);

  beforeEach(() => { vi.useFakeTimers(); delete globalThis[ID_STORE]; });
  afterEach(async () => { await plugin?.stop(); vi.useRealTimers(); });

  it('subscribes to the configured command topic of each device', async () => {
    await boot();
    expect(mqtt.subscribe).toHaveBeenCalledWith(T_EG);
    expect(mqtt.subscribe).toHaveBeenCalledWith(T_OG);
  });

  // the Loxone plugin refuses writes to these topics' controls
  it('names its command topics for the Loxone plugin while running, none after stop', async () => {
    await boot();
    expect(plugin.commandSourceTopics()).toEqual([T_EG, T_OG]);
    await plugin.stop();
    expect(plugin.commandSourceTopics()).toEqual([]);
  });

  // N1: Loxone inputs that feed the command control
  it('names the configured feeding uuids for the Loxone plugin while running, valid uuids only', async () => {
    const PAUSE = '1a2b3c4d-0000-0000-ffff00000000c003';
    const TASTER = '1a2b3c4d-0000-0000-ffff00000000c004';
    mqtt = makeMqtt(); logger = makeLogger(); cloud = makeFakeCloud(); plugin = new DreamePlugin();
    const devices = [
      { ...DEVICES_CFG[0], befehlVorlaeufer: [PAUSE, 'Dreame EG Pause', PAUSE.toUpperCase()] },
      { ...DEVICES_CFG[1], befehlVorlaeufer: [TASTER, PAUSE] },
    ];
    await plugin.start({
      mqttService: mqtt, configService: makeConfig({ devices }), logger, pluginId: 'dreame',
      pluginManager: makePluginManager(mqtt), deps: { createCloud: () => cloud },
    });
    expect(plugin.commandSourceUuids()).toEqual([PAUSE, TASTER]);
    // a typo would leave the input unprotected, so it is reported at start
    const warned = logger.warn.mock.calls.map(([t]) => t).filter((t) => /befehlVorlaeufer/.test(t));
    expect(warned).toEqual([expect.stringMatching(/device 'eg'.*2 .*ignored/)]);
    await plugin.stop();
    expect(plugin.commandSourceUuids()).toEqual([]);
  });

  it('ignores retained messages (no cloud call)', async () => {
    await boot();
    mqtt.send(T_EG, 1, true);
    mqtt.send(T_EG, 2, true);
    await settle();
    expect(cloud.action).not.toHaveBeenCalled();
  });

  it('ignores the first value after start, acts on a change', async () => {
    await boot();
    mqtt.send(T_EG, 0);
    await settle();
    expect(cloud.action).not.toHaveBeenCalled();
    mqtt.send(T_EG, 1);
    await settle();
    expect(cloud.action).toHaveBeenCalledTimes(1);
    expect(cloud.action.mock.calls[0].slice(1)).toEqual([2, 1]);
  });

  it('maps 1/2 to start/pause with the MIOT action ids and acks them non-retained', async () => {
    await boot();
    mqtt.send(T_EG, 0);
    mqtt.send(T_EG, 1);
    await settle();
    mqtt.send(T_EG, 2);
    await settle();
    expect(cloud.action.mock.calls.map((c) => c.slice(1, 3))).toEqual([[2, 1], [2, 2]]);
    const acks = mqtt.published().filter((p) => p.topic === ACK_EG);
    expect(acks.map((a) => [a.payload.v, a.payload.ergebnis])).toEqual([['start', 'ok'], ['pause', 'ok']]);
    for (const a of acks) {
      expect(a.opts?.retain).toBeFalsy();
      expect(typeof a.payload.ts).toBe('number');
    }
  });

  it('accepts JSON {"value":n} payloads', async () => {
    await boot();
    mqtt.send(T_EG, '{"value":0}');
    mqtt.send(T_EG, '{"value":1}');
    await settle();
    expect(cloud.action).toHaveBeenCalledTimes(1);
  });

  it('ignores unknown values', async () => {
    await boot();
    mqtt.send(T_EG, 0);
    for (const v of [3, 7, -1, 'abc', '']) mqtt.send(T_EG, v);
    await settle();
    expect(cloud.action).not.toHaveBeenCalled();
    expect(mqtt.published().filter((p) => p.topic === ACK_EG)).toHaveLength(0);
  });

  it('never acts when the cloud is not logged in, and logs a warning', async () => {
    await boot();
    mqtt.send(T_EG, 0);
    cloud._loggedIn = false;
    mqtt.send(T_EG, 1);
    await settle();
    expect(cloud.action).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
    expect(mqtt.published().filter((p) => p.topic === ACK_EG)).toHaveLength(0);
  });

  it('treats a (re)connect as a new initial sync and resubscribes', async () => {
    await boot();
    mqtt.send(T_EG, 0);
    mqtt.subscribe.mockClear();
    mqtt.emit('connected');
    expect(mqtt.subscribe).toHaveBeenCalledWith(T_EG);
    mqtt.send(T_EG, 1); // first value after reconnect -> ignored
    await settle();
    expect(cloud.action).not.toHaveBeenCalled();
    mqtt.send(T_EG, 2);
    await settle();
    expect(cloud.action).toHaveBeenCalledTimes(1);
  });

  it('keeps the devices independent', async () => {
    await boot();
    mqtt.send(T_EG, 0);
    mqtt.send(T_OG, 0);
    mqtt.send(T_OG, 1);
    await settle();
    expect(cloud.action).toHaveBeenCalledTimes(1);
    expect(cloud.action.mock.calls[0][0].model).toBe('dreame.vacuum.r2427a');
  });

  // the bare Loxone value has no id. It is only safe because the
  // subscription is QoS 0 on a clean session: the broker never redelivers.
  it('subscribes the command topics with QoS 0 (at most once, no redelivery)', async () => {
    await boot();
    const call = mqtt.subscribe.mock.calls.find(([t]) => t === T_EG);
    expect(call[1] === undefined || call[1].qos === 0).toBe(true);
  });

  // "2" arrives while the stop call is still in flight.
  it('a command that arrives while stop is still running cancels the return-to-base', async () => {
    let releaseStop;
    const action = vi.fn(async (_d, siid, aiid) => {
      if (siid === 4 && aiid === 2) await new Promise((r) => { releaseStop = r; });
      return { ok: true };
    });
    await boot({ action });
    mqtt.send(T_EG, 1);
    mqtt.send(T_EG, 0);
    await settle();
    mqtt.send(T_EG, 2); // pause while stop is pending
    await settle();
    releaseStop();
    await vi.advanceTimersByTimeAsync(5000);
    const calls = action.mock.calls.map((c) => c.slice(1, 3));
    expect(calls).toEqual([[4, 2], [2, 2]]); // no dock after the pause
  });

  it('stop: stops now, returns to base after 2 s, then acks', async () => {
    await boot();
    mqtt.send(T_EG, 1);
    mqtt.send(T_EG, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(cloud.action.mock.calls.map((c) => c.slice(1, 3))).toEqual([[4, 2]]);
    // the stop is acknowledged as soon as the cloud accepted it
    expect(mqtt.published().filter((p) => p.topic === ACK_EG).map((a) => a.payload.ergebnis)).toEqual(['ok']);
    await vi.advanceTimersByTimeAsync(1999);
    expect(cloud.action).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(cloud.action.mock.calls.map((c) => c.slice(1, 3))).toEqual([[4, 2], [3, 1]]);
    const acks = mqtt.published().filter((p) => p.topic === ACK_EG);
    expect(acks).toHaveLength(1);
    expect(acks[0].payload).toMatchObject({ v: 'stop', ergebnis: 'ok' });
  });

  it('a new command cancels a pending return-to-base', async () => {
    await boot();
    mqtt.send(T_EG, 1);
    mqtt.send(T_EG, 0);
    await vi.advanceTimersByTimeAsync(500);
    mqtt.send(T_EG, 1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(cloud.action.mock.calls.map((c) => c.slice(1, 3))).toEqual([[4, 2], [2, 1]]);
  });

  // the receipt of an executed stop must not depend on the station timer.
  it('stop ok, then start within 2 s: both receipts appear, no return-to-base', async () => {
    await boot();
    mqtt.send(T_EG, 1);
    mqtt.send(T_EG, 0);
    await vi.advanceTimersByTimeAsync(500);
    mqtt.send(T_EG, 1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(cloud.action.mock.calls.map((c) => c.slice(1, 3))).toEqual([[4, 2], [2, 1]]);
    expect(mqtt.published().filter((p) => p.topic === ACK_EG).map((a) => [a.payload.v, a.payload.ergebnis]))
      .toEqual([['stop', 'ok'], ['start', 'ok']]);
  });

  it('a failing return-to-base is logged, not acknowledged a second time', async () => {
    await boot({ action: vi.fn(async (_d, siid) => ({ ok: siid !== 3 })) });
    mqtt.send(T_EG, 1);
    mqtt.send(T_EG, 0);
    await vi.advanceTimersByTimeAsync(2500);
    expect(mqtt.published().filter((p) => p.topic === ACK_EG)).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalled();
  });

  // a chain queued before stop() must never send after a restart of the same instance.
  it('a queued command of the old run is dropped after stop() and start()', async () => {
    let releaseFirst;
    const oldCloud = makeFakeCloud({
      action: vi.fn(async () => { await new Promise((r) => { releaseFirst = r; }); return { ok: true }; }),
    });
    const newCloud = makeFakeCloud();
    mqtt = makeMqtt(); logger = makeLogger(); plugin = new DreamePlugin();
    const ctx = (c) => ({ mqttService: mqtt, configService: makeConfig(), logger, pluginId: 'dreame', pluginManager: makePluginManager(mqtt), deps: { createCloud: () => c } });
    await plugin.start(ctx(oldCloud));
    mqtt.send(T_EG, 0); // initial sync
    mqtt.send(T_EG, 2); // pause hangs in the old cloud (retry/backoff)
    await settle();
    mqtt.send(T_EG, 1); // start waits behind it
    await settle();
    await plugin.stop();
    await plugin.start(ctx(newCloud));
    mqtt.send(T_EG, 0); // initial sync of the new run
    releaseFirst();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(newCloud.action).not.toHaveBeenCalled();
    expect(oldCloud.action).toHaveBeenCalledTimes(1);
    expect(mqtt.published().filter((p) => p.topic === ACK_EG).map((a) => a.payload.v)).not.toContain('start');
    cloud = newCloud;
  });

  // the id memory survives stop()/start() of the same instance. Since the
  // Loxone topic refuses the id form, so the memory is checked at the gate (kept for the steuer/ path, P3).
  it('a duplicate id is refused after stop() and start() within the time window', async () => {
    const mk = () => ({ mqttService: mqtt, configService: makeConfig(), logger, pluginId: 'dreame', pluginManager: makePluginManager(mqtt), deps: { createCloud: () => cloud } });
    mqtt = makeMqtt(); logger = makeLogger(); cloud = makeFakeCloud(); plugin = new DreamePlugin();
    const p3 = (v, id) => JSON.stringify({ v, ts: Date.now(), id });
    const gate = () => plugin._devs.find((d) => d.key === 'eg').gate;
    await plugin.start(mk());
    expect(gate().accept(p3(1, 'a'), false)).toBe('start');
    await plugin.stop();
    await plugin.start(mk());
    expect(gate().accept(p3(1, 'a'), false)).toBeNull(); // QoS 1 redelivery of the same command
  });

  // the PluginManager re-imports the module with a cache-bust and builds a new instance
  // on start()/reload(), so the id memory must not live on the instance or in the module.
  it('a duplicate id is refused by a new instance from a fresh module import', async () => {
    const url = new URL('../../plugins/dreame/plugin.js', import.meta.url).href;
    const mk = () => ({ mqttService: mqtt, configService: makeConfig(), logger, pluginId: 'dreame', pluginManager: makePluginManager(mqtt), deps: { createCloud: () => cloud } });
    mqtt = makeMqtt(); logger = makeLogger(); cloud = makeFakeCloud();
    const p3 = (v, id) => JSON.stringify({ v, ts: Date.now(), id });
    const First = (await import(`${url}?t=r41-1`)).default;
    const gate = () => plugin._devs.find((d) => d.key === 'eg').gate;
    plugin = new First();
    await plugin.start(mk());
    expect(gate().accept(p3(1, 'a'), false)).toBe('start');
    await plugin.stop();
    const Second = (await import(`${url}?t=r41-2`)).default;
    expect(Second).not.toBe(First);
    plugin = new Second();
    await plugin.start(mk());
    expect(gate().accept(p3(1, 'a'), false)).toBeNull(); // QoS 1 redelivery of the same command
  });

  // a late receipt of an old run must not appear, also not under a new topic root.
  it('the receipt of a pause call that ends after stop()/start() is dropped', async () => {
    let releasePause;
    const oldCloud = makeFakeCloud({
      action: vi.fn(async () => { await new Promise((r) => { releasePause = r; }); return { ok: true }; }),
    });
    mqtt = makeMqtt(); logger = makeLogger(); plugin = new DreamePlugin();
    const ctx = (c, root) => ({ mqttService: mqtt, configService: makeConfig({ topicRoot: root }), logger, pluginId: 'dreame', pluginManager: makePluginManager(mqtt), deps: { createCloud: () => c } });
    await plugin.start(ctx(oldCloud, 'haus/sauger'));
    mqtt.send(T_EG, 0);
    mqtt.send(T_EG, 2); // pause hangs
    await settle();
    await plugin.stop();
    await plugin.start(ctx(makeFakeCloud(), 'haus/sauger2'));
    mqtt.publish.mockClear();
    releasePause();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mqtt.published().filter((p) => p.topic.endsWith('/ereignis/befehl'))).toEqual([]);
    expect(allLogged(logger)).toContain('receipt');
    cloud = oldCloud;
  });

  it('the failure receipt of a stop that ends after stop()/start() is dropped', async () => {
    let releaseStop;
    const oldCloud = makeFakeCloud({
      action: vi.fn(async () => { await new Promise((r) => { releaseStop = r; }); return { ok: false }; }),
    });
    mqtt = makeMqtt(); logger = makeLogger(); plugin = new DreamePlugin();
    const ctx = (c, root) => ({ mqttService: mqtt, configService: makeConfig({ topicRoot: root }), logger, pluginId: 'dreame', pluginManager: makePluginManager(mqtt), deps: { createCloud: () => c } });
    await plugin.start(ctx(oldCloud, 'haus/sauger'));
    mqtt.send(T_EG, 1);
    mqtt.send(T_EG, 0); // stop hangs
    await settle();
    await plugin.stop();
    await plugin.start(ctx(makeFakeCloud(), 'haus/sauger2'));
    mqtt.publish.mockClear();
    releaseStop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mqtt.published().filter((p) => p.topic.endsWith('/ereignis/befehl'))).toEqual([]);
    cloud = oldCloud;
  });

  it('stopping the plugin cancels a pending return-to-base', async () => {
    await boot();
    mqtt.send(T_EG, 1);
    mqtt.send(T_EG, 0);
    await vi.advanceTimersByTimeAsync(500);
    await plugin.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(cloud.action).toHaveBeenCalledTimes(1);
  });

  it('acks ergebnis=fehler when the cloud rejects the command', async () => {
    await boot({ action: vi.fn(async () => ({ ok: false, code: -1 })) });
    mqtt.send(T_EG, 1);
    mqtt.send(T_EG, 2);
    await settle();
    expect(mqtt.last(ACK_EG).payload).toMatchObject({ v: 'pause', ergebnis: 'fehler' });
  });

  it('acks ergebnis=fehler (and logs no secret) when the cloud call throws', async () => {
    await boot({ action: vi.fn(async () => { throw new Error('HTTP 500'); }) });
    mqtt.send(T_EG, 1);
    mqtt.send(T_EG, 2);
    await settle();
    expect(mqtt.last(ACK_EG).payload).toMatchObject({ v: 'pause', ergebnis: 'fehler' });
    expect(allLogged(logger)).not.toContain(DID_EG);
  });

  it('refuses a value the Loxone connection does not confirm, without touching the baseline', async () => {
    const lox = new Map([[T_EG, 0]]);
    await boot({}, lox);
    mqtt.send(T_EG, 0); // initial sync, confirmed
    mqtt.send(T_EG, 1); // injected by a foreign publisher: Loxone still says 0
    await settle();
    expect(cloud.action).not.toHaveBeenCalled();
    expect(mqtt.last(ACK_EG)).toBeUndefined();
    expect(logger.warn.mock.calls.flat().join(' ')).toMatch(/not confirmed by Loxone/);
    lox.set(T_EG, 1); // the real Loxone change follows
    mqtt.send(T_EG, 1);
    await settle();
    expect(cloud.action).toHaveBeenCalledTimes(1);
    expect(cloud.action.mock.calls[0].slice(1)).toEqual([2, 1]);
  });

  it('refuses id commands on a Loxone topic unless Loxone shows the same value', async () => {
    const lox = new Map([[T_EG, 0]]);
    await boot({}, lox);
    mqtt.send(T_EG, JSON.stringify({ v: 1, ts: Date.now(), id: 'a1-x' }));
    await settle();
    expect(cloud.action).not.toHaveBeenCalled();
  });

  // Loxone never publishes an id, so the id form on the Loxone topic is foreign,
  // even with the value Loxone shows (else a fresh id would repeat the command at will).
  it('refuses id commands on a Loxone topic also when the value matches Loxone', async () => {
    const lox = new Map([[T_EG, 0]]);
    await boot({}, lox);
    mqtt.send(T_EG, JSON.stringify({ v: 0, ts: Date.now(), id: 'r6-a' }));
    mqtt.send(T_EG, JSON.stringify({ v: 0, ts: Date.now(), id: 'r6-b' }));
    mqtt.send(T_EG, JSON.stringify({ value: 0, ts: Date.now(), id: 'r6-c' }));
    await settle();
    expect(cloud.action).not.toHaveBeenCalled();
    expect(mqtt.last(ACK_EG)).toBeUndefined();
  });

  // on the Loxone path only the forms Loxone itself publishes count.
  it('accepts only a bare 0/1/2 or Loxone\'s value object on the Loxone topic', async () => {
    const lox = new Map([[T_EG, 0]]);
    await boot({}, lox);
    mqtt.send(T_EG, 0); // initial sync
    lox.set(T_EG, 1);
    for (const p of ['0x1', '1e0', '+1', '01', ' 1', '1.0', '{"v":1}', '{"value":"1"}']) mqtt.send(T_EG, p);
    await settle();
    expect(cloud.action).not.toHaveBeenCalled();
    mqtt.send(T_EG, JSON.stringify({ value: 1, name: 'Sauger EG', type: 'Switch', uuid: 'u', room: 'EG' }));
    await settle();
    expect(cloud.action).toHaveBeenCalledTimes(1);
    expect(cloud.action.mock.calls[0].slice(1)).toEqual([2, 1]);
  });

  it('fails closed without a running Loxone plugin', async () => {
    mqtt = makeMqtt(); logger = makeLogger(); cloud = makeFakeCloud(); plugin = new DreamePlugin();
    await plugin.start({
      mqttService: mqtt, configService: makeConfig(), logger, pluginId: 'dreame',
      pluginManager: { getInstance: () => null }, deps: { createCloud: () => cloud },
    });
    mqtt.send(T_EG, 0);
    mqtt.send(T_EG, 1);
    await settle();
    expect(cloud.action).not.toHaveBeenCalled();
    await plugin.stop();
    // and without any plugin manager at all
    mqtt = makeMqtt(); plugin = new DreamePlugin();
    await plugin.start({ mqttService: mqtt, configService: makeConfig(), logger, pluginId: 'dreame', deps: { createCloud: () => cloud } });
    mqtt.send(T_EG, 0);
    mqtt.send(T_EG, 1);
    await settle();
    expect(cloud.action).not.toHaveBeenCalled();
  });

  it('rejects a command topic below the plugin\'s own topic root (feedback loop)', async () => {
    mqtt = makeMqtt(); logger = makeLogger(); cloud = makeFakeCloud(); plugin = new DreamePlugin();
    await plugin.start({
      mqttService: mqtt,
      configService: makeConfig({ devices: [{ key: 'eg', model: 'dreame.vacuum.r2449a', befehlThema: 'haus/sauger/eg/zustand' }] }),
      logger, pluginId: 'dreame', deps: { createCloud: () => cloud },
    });
    expect(mqtt.subscribe).not.toHaveBeenCalledWith('haus/sauger/eg/zustand');
    expect(logger.warn).toHaveBeenCalled();
  });
});
