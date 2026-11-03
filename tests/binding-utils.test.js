import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { applyBindings, cleanupBindings, applyInvert } from '../plugins/lib/binding-utils.js';

/**
 * Minimal MqttService stand-in. EventEmitter so `on('message', handler)`
 * works, plus the two methods applyBindings calls (subscribe/removeListener).
 */
function makeMqttService() {
  const ee = new EventEmitter();
  ee.subscribe = vi.fn();
  ee.unsubscribe = vi.fn();
  // removeListener is inherited from EventEmitter.
  return ee;
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

describe('applyBindings — raw payload mode', () => {
  let mqttService;
  let logger;
  let sendToTarget;
  let handlerMap;
  let lastSendMap;

  beforeEach(() => {
    mqttService = makeMqttService();
    logger = makeLogger();
    sendToTarget = vi.fn();
    handlerMap = new Map();
    lastSendMap = new Map();
  });

  it('forwards raw numeric payload coerced to a Number', () => {
    const binding = {
      id: 'b-raw-1',
      enabled: true,
      mqttTopic: 'sensors/temp',
      jsonField: '',
      targetUuid: 'uuid-temp',
    };

    applyBindings({
      bindings: [binding], mqttService, logger, sendToTarget, handlerMap, lastSendMap,
    });

    mqttService.emit('message', { topic: 'sensors/temp', payload: '23.5' });

    expect(sendToTarget).toHaveBeenCalledTimes(1);
    expect(sendToTarget).toHaveBeenCalledWith('uuid-temp', '23.5');
    const stat = lastSendMap.get('b-raw-1');
    expect(stat.sendCount).toBe(1);
    expect(stat.value).toBe(23.5);
    expect(stat.lastError).toBeNull();
  });

  it('forwards raw integer 1 and raw integer 0 (Tasmota motion sensor)', () => {
    const binding = {
      id: 'b-raw-2',
      enabled: true,
      mqttTopic: 'stat/gateway1-30/Essen_Bewegungsmelder',
      jsonField: '',
      targetUuid: 'uuid-motion',
    };

    applyBindings({
      bindings: [binding], mqttService, logger, sendToTarget, handlerMap, lastSendMap,
    });

    mqttService.emit('message', { topic: 'stat/gateway1-30/Essen_Bewegungsmelder', payload: '1' });
    mqttService.emit('message', { topic: 'stat/gateway1-30/Essen_Bewegungsmelder', payload: '0' });

    expect(sendToTarget).toHaveBeenCalledTimes(2);
    expect(sendToTarget).toHaveBeenNthCalledWith(1, 'uuid-motion', '1');
    expect(sendToTarget).toHaveBeenNthCalledWith(2, 'uuid-motion', '0');
    const stat = lastSendMap.get('b-raw-2');
    expect(stat.sendCount).toBe(2);
    expect(stat.value).toBe(0);
  });

  it('falls back to string when raw payload is not a finite number', () => {
    const binding = {
      id: 'b-raw-string',
      enabled: true,
      mqttTopic: 'state/door',
      jsonField: '',
      targetUuid: 'uuid-door',
    };

    applyBindings({
      bindings: [binding], mqttService, logger, sendToTarget, handlerMap, lastSendMap,
    });

    mqttService.emit('message', { topic: 'state/door', payload: 'open' });

    expect(sendToTarget).toHaveBeenCalledTimes(1);
    expect(sendToTarget).toHaveBeenCalledWith('uuid-door', 'open');
    const stat = lastSendMap.get('b-raw-string');
    expect(stat.value).toBe('open');
  });

  it('does not forward when raw payload is empty; records empty_payload reason', () => {
    const binding = {
      id: 'b-raw-empty',
      enabled: true,
      mqttTopic: 'sensors/null',
      jsonField: '',
      targetUuid: 'uuid-null',
    };

    applyBindings({
      bindings: [binding], mqttService, logger, sendToTarget, handlerMap, lastSendMap,
    });

    mqttService.emit('message', { topic: 'sensors/null', payload: '' });
    mqttService.emit('message', { topic: 'sensors/null', payload: '   ' });

    expect(sendToTarget).not.toHaveBeenCalled();
    const stat = lastSendMap.get('b-raw-empty');
    expect(stat.sendCount || 0).toBe(0);
    expect(stat.recvCount).toBe(2);
    expect(stat.lastReason).toBe('empty_payload');
    expect(stat.lastError).toMatch(/empty/);
  });

  it('logs the raw-mode marker [raw] when subscribing a raw binding', () => {
    const binding = {
      id: 'b-raw-log',
      enabled: true,
      mqttTopic: 'sensors/raw-log',
      jsonField: '',
      targetUuid: 'uuid-x',
      label: 'Raw Sensor',
    };

    applyBindings({
      bindings: [binding], mqttService, logger, sendToTarget, handlerMap, lastSendMap,
    });

    const logged = logger.info.mock.calls.map(c => c[0]).join(' | ');
    expect(logged).toMatch(/\[raw\]/);
  });

  it('subscribes a binding with empty jsonField (line-92 skip-guard removed)', () => {
    const binding = {
      id: 'b-subscribe',
      enabled: true,
      mqttTopic: 'sensors/whatever',
      jsonField: '',
      targetUuid: 'uuid-y',
    };

    applyBindings({
      bindings: [binding], mqttService, logger, sendToTarget, handlerMap, lastSendMap,
    });

    expect(mqttService.subscribe).toHaveBeenCalledWith('sensors/whatever');
    expect(handlerMap.has('b-subscribe')).toBe(true);
  });
});

describe('applyBindings — JSON path regression', () => {
  let mqttService;
  let logger;
  let sendToTarget;
  let handlerMap;
  let lastSendMap;

  beforeEach(() => {
    mqttService = makeMqttService();
    logger = makeLogger();
    sendToTarget = vi.fn();
    handlerMap = new Map();
    lastSendMap = new Map();
  });

  it('still extracts nested JSON field (Tasmota Wasserboiler.Temperature)', () => {
    const binding = {
      id: 'b-json-1',
      enabled: true,
      mqttTopic: 'tele/gateway1-30/SENSOR',
      jsonField: 'Wasserboiler.Temperature',
      targetUuid: 'uuid-boiler',
    };

    applyBindings({
      bindings: [binding], mqttService, logger, sendToTarget, handlerMap, lastSendMap,
    });

    mqttService.emit('message', {
      topic: 'tele/gateway1-30/SENSOR',
      payload: JSON.stringify({ Wasserboiler: { Temperature: 17.6 } }),
    });

    expect(sendToTarget).toHaveBeenCalledTimes(1);
    expect(sendToTarget).toHaveBeenCalledWith('uuid-boiler', '17.6');
    const stat = lastSendMap.get('b-json-1');
    expect(stat.value).toBe(17.6);
  });

  it('records json_parse_failed when JSON-mode binding receives a non-JSON payload', () => {
    const binding = {
      id: 'b-json-2',
      enabled: true,
      mqttTopic: 'tele/gateway1-30/SENSOR',
      jsonField: 'Wasserboiler.Temperature',
      targetUuid: 'uuid-boiler',
    };

    applyBindings({
      bindings: [binding], mqttService, logger, sendToTarget, handlerMap, lastSendMap,
    });

    mqttService.emit('message', { topic: 'tele/gateway1-30/SENSOR', payload: 'not-json' });

    expect(sendToTarget).not.toHaveBeenCalled();
    const stat = lastSendMap.get('b-json-2');
    expect(stat.lastReason).toBe('json_parse_failed');
    expect(stat.lastError).toMatch(/not JSON/);
  });

  it('records field_missing when JSON path is absent', () => {
    const binding = {
      id: 'b-json-3',
      enabled: true,
      mqttTopic: 'tele/dev/SENSOR',
      jsonField: 'Wasserboiler.Temperature',
      targetUuid: 'uuid-boiler',
    };

    applyBindings({
      bindings: [binding], mqttService, logger, sendToTarget, handlerMap, lastSendMap,
    });

    mqttService.emit('message', {
      topic: 'tele/dev/SENSOR',
      payload: JSON.stringify({ SomethingElse: 1 }),
    });

    expect(sendToTarget).not.toHaveBeenCalled();
    const stat = lastSendMap.get('b-json-3');
    expect(stat.lastReason).toBe('field_missing');
  });
});

describe('cleanupBindings', () => {
  it('clears handlers and stats; safe to call without mqttService', () => {
    const handlerMap = new Map([['b1', { handler: () => {}, topic: 't1' }]]);
    const lastSendMap = new Map([['b1', { value: 1 }]]);

    expect(() => cleanupBindings({
      mqttService: null, handlerMap, lastSendMap,
    })).not.toThrow();

    // With a real mqttService, cleanup removes listeners and empties maps.
    const mqttService = makeMqttService();
    const handler = vi.fn();
    mqttService.on('message', handler);
    const h2 = new Map([['b1', { handler, topic: 't1' }]]);
    const s2 = new Map([['b1', { value: 2 }]]);
    cleanupBindings({ mqttService, handlerMap: h2, lastSendMap: s2 });
    expect(h2.size).toBe(0);
    expect(s2.size).toBe(0);
    expect(mqttService.listenerCount('message')).toBe(0);
  });
});

describe('applyBindings — timer heartbeat (per-binding)', () => {
  let mqttService;
  let logger;
  let sendToTarget;
  let handlerMap;
  let lastSendMap;
  let intervalMap;

  beforeEach(() => {
    mqttService = makeMqttService();
    logger = makeLogger();
    sendToTarget = vi.fn();
    handlerMap = new Map();
    lastSendMap = new Map();
    intervalMap = new Map();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-sends the cached value every keepaliveMs after a real MQTT event', () => {
    const binding = {
      id: 'b-hb-1',
      enabled: true,
      mqttTopic: 'sensors/motion',
      jsonField: '',
      targetUuid: 'uuid-motion',
      keepaliveMs: 5000,
    };

    applyBindings({
      bindings: [binding], mqttService, logger, sendToTarget,
      handlerMap, lastSendMap, intervalMap,
    });

    // Real MQTT event arrives → forwarded immediately.
    mqttService.emit('message', { topic: 'sensors/motion', payload: '1' });
    expect(sendToTarget).toHaveBeenCalledTimes(1);
    expect(sendToTarget).toHaveBeenNthCalledWith(1, 'uuid-motion', '1');
    expect(lastSendMap.get('b-hb-1').sendCount).toBe(1);
    expect(lastSendMap.get('b-hb-1').lastReason).toBe('changed');

    // Advance just past keepalive → timer fires, value re-sent.
    vi.advanceTimersByTime(5100);
    expect(sendToTarget).toHaveBeenCalledTimes(2);
    expect(sendToTarget).toHaveBeenNthCalledWith(2, 'uuid-motion', '1');
    const stat = lastSendMap.get('b-hb-1');
    expect(stat.sendCount).toBe(2);
    expect(stat.lastReason).toBe('timer_heartbeat');
    // Heartbeat must NOT bump recvCount (it isn't a received MQTT event).
    expect(stat.recvCount).toBe(1);

    // Cleanup → no further heartbeat sends, even after long delay.
    cleanupBindings({ mqttService, handlerMap, lastSendMap, intervalMap });
    vi.advanceTimersByTime(60000);
    expect(sendToTarget).toHaveBeenCalledTimes(2);
    expect(intervalMap.size).toBe(0);
  });

  it('does not fire heartbeat before any MQTT value has been received', () => {
    const binding = {
      id: 'b-hb-no-value',
      enabled: true,
      mqttTopic: 'sensors/idle',
      jsonField: '',
      targetUuid: 'uuid-idle',
      keepaliveMs: 1000,
    };

    applyBindings({
      bindings: [binding], mqttService, logger, sendToTarget,
      handlerMap, lastSendMap, intervalMap,
    });

    // Timer ticks but stat.value is undefined → no send.
    vi.advanceTimersByTime(5000);
    expect(sendToTarget).not.toHaveBeenCalled();
  });

  it('keepaliveMs=0 disables the heartbeat (explicit opt-out, not the 30s default)', () => {
    const binding = {
      id: 'b-hb-off',
      enabled: true,
      mqttTopic: 'sensors/off',
      jsonField: '',
      targetUuid: 'uuid-off',
      keepaliveMs: 0,
    };

    applyBindings({
      bindings: [binding], mqttService, logger, sendToTarget,
      handlerMap, lastSendMap, intervalMap,
    });

    mqttService.emit('message', { topic: 'sensors/off', payload: '42' });
    expect(sendToTarget).toHaveBeenCalledTimes(1);

    // No interval should be armed.
    expect(intervalMap.size).toBe(0);

    // Advance a long way — no heartbeat fires.
    vi.advanceTimersByTime(60000);
    expect(sendToTarget).toHaveBeenCalledTimes(1);

    // Log line reflects the disabled state.
    const logged = logger.info.mock.calls.map(c => c[0]).join(' | ');
    expect(logged).toMatch(/heartbeat off/);
  });

  it('re-arms the heartbeat after each real MQTT-driven send (no double-fire at boundary)', () => {
    const binding = {
      id: 'b-hb-rearm',
      enabled: true,
      mqttTopic: 'sensors/rearm',
      jsonField: '',
      targetUuid: 'uuid-rearm',
      keepaliveMs: 1000,
    };

    applyBindings({
      bindings: [binding], mqttService, logger, sendToTarget,
      handlerMap, lastSendMap, intervalMap,
    });

    mqttService.emit('message', { topic: 'sensors/rearm', payload: '10' });
    expect(sendToTarget).toHaveBeenCalledTimes(1);

    // 900ms later (before original keepalive boundary) a fresh MQTT event
    // arrives. The heartbeat should be reset, NOT fire ~100ms later.
    vi.advanceTimersByTime(900);
    mqttService.emit('message', { topic: 'sensors/rearm', payload: '20' });
    expect(sendToTarget).toHaveBeenCalledTimes(2);

    // Advance 200ms more (would have been past the original 1000ms boundary
    // from the first send). No heartbeat should fire yet.
    vi.advanceTimersByTime(200);
    expect(sendToTarget).toHaveBeenCalledTimes(2);

    // Advance to a full keepalive past the SECOND send → heartbeat fires.
    vi.advanceTimersByTime(900);
    expect(sendToTarget).toHaveBeenCalledTimes(3);
    expect(sendToTarget).toHaveBeenNthCalledWith(3, 'uuid-rearm', '20');
    expect(lastSendMap.get('b-hb-rearm').lastReason).toBe('timer_heartbeat');
  });
});

describe('applyInvert — unit', () => {
  it('flips positive finite number: 0.34 → -0.34', () => {
    expect(applyInvert(0.34, true)).toBe(-0.34);
  });

  it('double negation: -0.34 → 0.34', () => {
    expect(applyInvert(-0.34, true)).toBe(0.34);
  });

  it('invert=false is a no-op: 0.34 stays 0.34', () => {
    expect(applyInvert(0.34, false)).toBe(0.34);
  });

  it('invert=undefined is a no-op (legacy bindings without the field)', () => {
    expect(applyInvert(0.34, undefined)).toBe(0.34);
  });

  it('non-numeric string "on" passes through unchanged (no "oNaN")', () => {
    expect(applyInvert('on', true)).toBe('on');
  });

  it('non-numeric string "off" passes through unchanged', () => {
    expect(applyInvert('off', true)).toBe('off');
  });

  // JS-quirk: -(0) === -0. We accept -0 deterministically via Object.is so
  // the assertion does not depend on === 's loose handling of +0/-0. If a
  // downstream consumer ever needs +0 normalisation, applyInvert is not the
  // right layer — the round-to-3-decimals step in applyBindings still emits
  // a finite number either way (and toString of -0 is "0").
  it('zero input with invert=true yields -0 (Object.is asserts the JS-quirk)', () => {
    const result = applyInvert(0, true);
    expect(Object.is(result, -0)).toBe(true);
  });
});

describe('applyBindings — invert pipeline composition', () => {
  let mqttService;
  let logger;
  let sendToTarget;
  let handlerMap;
  let lastSendMap;

  beforeEach(() => {
    mqttService = makeMqttService();
    logger = makeLogger();
    sendToTarget = vi.fn();
    handlerMap = new Map();
    lastSendMap = new Map();
  });

  it('raw 340 + transform=div1000 + invert=true → forwarded "-0.34"', () => {
    const binding = {
      id: 'b-inv-1',
      enabled: true,
      mqttTopic: 'sensors/grid_power',
      jsonField: '',
      targetUuid: 'uuid-grid',
      transform: 'div1000',
      invert: true,
    };

    applyBindings({
      bindings: [binding], mqttService, logger, sendToTarget, handlerMap, lastSendMap,
    });

    mqttService.emit('message', { topic: 'sensors/grid_power', payload: '340' });

    expect(sendToTarget).toHaveBeenCalledTimes(1);
    expect(sendToTarget).toHaveBeenCalledWith('uuid-grid', '-0.34');
    const stat = lastSendMap.get('b-inv-1');
    expect(stat.value).toBe(-0.34);
  });

  it('invert=true without transform: raw 5 → forwarded "-5"', () => {
    const binding = {
      id: 'b-inv-2',
      enabled: true,
      mqttTopic: 'sensors/plain',
      jsonField: '',
      targetUuid: 'uuid-plain',
      invert: true,
    };

    applyBindings({
      bindings: [binding], mqttService, logger, sendToTarget, handlerMap, lastSendMap,
    });

    mqttService.emit('message', { topic: 'sensors/plain', payload: '5' });

    expect(sendToTarget).toHaveBeenCalledTimes(1);
    expect(sendToTarget).toHaveBeenCalledWith('uuid-plain', '-5');
  });

  it('regression: legacy binding WITHOUT invert key behaves identically to pre-PR', () => {
    // Exactly the same binding as the first raw-mode test above but no
    // `invert` field at all — must still forward "23.5" unchanged.
    const binding = {
      id: 'b-inv-legacy',
      enabled: true,
      mqttTopic: 'sensors/temp-legacy',
      jsonField: '',
      targetUuid: 'uuid-temp-legacy',
    };

    applyBindings({
      bindings: [binding], mqttService, logger, sendToTarget, handlerMap, lastSendMap,
    });

    mqttService.emit('message', { topic: 'sensors/temp-legacy', payload: '23.5' });

    expect(sendToTarget).toHaveBeenCalledTimes(1);
    expect(sendToTarget).toHaveBeenCalledWith('uuid-temp-legacy', '23.5');
    expect(lastSendMap.get('b-inv-legacy').value).toBe(23.5);
  });

  it('non-numeric raw payload "on" with invert=true passes through unchanged', () => {
    const binding = {
      id: 'b-inv-string',
      enabled: true,
      mqttTopic: 'state/switch',
      jsonField: '',
      targetUuid: 'uuid-switch',
      invert: true,
    };

    applyBindings({
      bindings: [binding], mqttService, logger, sendToTarget, handlerMap, lastSendMap,
    });

    mqttService.emit('message', { topic: 'state/switch', payload: 'on' });

    expect(sendToTarget).toHaveBeenCalledTimes(1);
    // String "on" round-trips: applyTransform → 'on' (not transformed),
    // applyInvert → 'on' (not numeric), no rounding (not typeof 'number').
    expect(sendToTarget).toHaveBeenCalledWith('uuid-switch', 'on');
  });
});

describe('applyBindings — heartbeat stops for a dead cyclic source', () => {
  let mqttService;
  let logger;
  let sendToTarget;
  let handlerMap;
  let lastSendMap;
  let intervalMap;

  beforeEach(() => {
    mqttService = makeMqttService();
    logger = makeLogger();
    sendToTarget = vi.fn();
    handlerMap = new Map();
    lastSendMap = new Map();
    intervalMap = new Map();
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanupBindings({ mqttService, handlerMap, lastSendMap, intervalMap });
    vi.useRealTimers();
  });

  const run = (extra) => {
    const binding = {
      id: 'b-stale', enabled: true, mqttTopic: 'pv/ac', jsonField: '',
      targetUuid: 'uuid-pv', keepaliveMs: 30000, ...extra,
    };
    applyBindings({ bindings: [binding], mqttService, logger, sendToTarget, handlerMap, lastSendMap, intervalMap });
    mqttService.emit('message', { topic: 'pv/ac', payload: '4.529' });
    return lastSendMap.get('b-stale');
  };

  it('keeps sending within 15 min, then stops (cyclic default)', () => {
    const stat = run({});
    vi.advanceTimersByTime(14 * 60 * 1000);
    const vorher = sendToTarget.mock.calls.length;
    expect(vorher).toBeGreaterThan(20);
    vi.advanceTimersByTime(10 * 60 * 1000);
    // at most one more send right at the 15-min boundary, then nothing
    expect(sendToTarget.mock.calls.length - vorher).toBeLessThanOrEqual(2);
    expect(stat.lastReason).toBe('stale_skip');
    const danach = sendToTarget.mock.calls.length;
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(sendToTarget.mock.calls.length).toBe(danach);
  });

  it('resumes as soon as a fresh value arrives', () => {
    run({});
    vi.advanceTimersByTime(30 * 60 * 1000);
    const n = sendToTarget.mock.calls.length;
    mqttService.emit('message', { topic: 'pv/ac', payload: '0' });
    expect(sendToTarget.mock.calls.length).toBe(n + 1);
    vi.advanceTimersByTime(31000);
    expect(sendToTarget.mock.calls.length).toBe(n + 2);
  });

  it('event sources keep their heartbeat', () => {
    run({ sourceMode: 'event' });
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(sendToTarget.mock.calls.length).toBeGreaterThan(100);
  });

  it('legacy binding without sourceMode on a stat/ topic keeps its heartbeat', () => {
    const binding = {
      id: 'b-pir', enabled: true, mqttTopic: 'stat/flur/Bewegungsmelder', jsonField: '',
      targetUuid: 'uuid-pir', keepaliveMs: 30000,
    };
    applyBindings({ bindings: [binding], mqttService, logger, sendToTarget, handlerMap, lastSendMap, intervalMap });
    mqttService.emit('message', { topic: 'stat/flur/Bewegungsmelder', payload: '0' });
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(sendToTarget.mock.calls.length).toBeGreaterThan(100);
  });

  it('staleAfterMs: 0 restores repeat-forever', () => {
    run({ staleAfterMs: 0 });
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(sendToTarget.mock.calls.length).toBeGreaterThan(100);
  });

  it('error payloads after a valid value do not keep the heartbeat alive', () => {
    run({ jsonField: 'p' });
    // first value must be valid JSON for the jsonField binding
    mqttService.emit('message', { topic: 'pv/ac', payload: '{"p": 4.529}' });
    const start = sendToTarget.mock.calls.length;
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(5 * 60 * 1000);
      mqttService.emit('message', { topic: 'pv/ac', payload: 'kaputt' });
    }
    const n = sendToTarget.mock.calls.length;
    vi.advanceTimersByTime(30 * 60 * 1000);
    expect(n - start).toBeLessThan(40);
    expect(sendToTarget.mock.calls.length).toBe(n);
    // the red parse error stays visible instead of being masked by stale_skip
    expect(lastSendMap.get('b-stale').lastReason).toBe('json_parse_failed');
  });

  it('a retained replay is forwarded once but arms no heartbeat', () => {
    const binding = {
      id: 'b-ret', enabled: true, mqttTopic: 'pv/ac', jsonField: '',
      targetUuid: 'uuid-pv', keepaliveMs: 30000,
    };
    applyBindings({ bindings: [binding], mqttService, logger, sendToTarget, handlerMap, lastSendMap, intervalMap });
    mqttService.emit('message', { topic: 'pv/ac', payload: '4.529', retain: true });
    expect(sendToTarget).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(sendToTarget).toHaveBeenCalledTimes(1);
    expect(lastSendMap.get('b-ret').lastReason).toBe('stale_skip');
    // a live value brings the heartbeat back
    mqttService.emit('message', { topic: 'pv/ac', payload: '5' });
    vi.advanceTimersByTime(31000);
    expect(sendToTarget).toHaveBeenCalledTimes(3);
  });

  it('stale_skip does not hide a send_error', () => {
    sendToTarget = vi.fn(() => { throw new Error('ziel weg'); });
    const stat = run({});
    expect(stat.lastReason).toBe('send_error');
    vi.advanceTimersByTime(30 * 60 * 1000);
    expect(stat.lastReason).toBe('send_error');
  });
});
