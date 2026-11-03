import { vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { parseCommandValue } from '../../plugins/dreame/dreame-commands.js';

export const DID_EG = '1111111';
export const DID_OG = '2222222';

export function makeMqtt() {
  const m = new EventEmitter();
  m.publish = vi.fn();
  m.subscribe = vi.fn();
  m.unsubscribe = vi.fn();
  /** all publishes as { topic, payload (parsed), opts } */
  m.published = () => m.publish.mock.calls.map(([topic, payload, opts]) => {
    let parsed = payload;
    try { parsed = JSON.parse(payload); } catch { /* keep raw */ }
    return { topic, payload: parsed, raw: payload, opts };
  });
  m.last = (topic) => m.published().filter((p) => p.topic === topic).at(-1);
  m.sent = new Map(); // topic -> last payload sent through send() (what Loxone published)
  m.send = (topic, payload, retain = false) => {
    m.sent.set(topic, String(payload));
    m.emit('message', { topic, payload: String(payload), timestamp: Date.now(), retain });
  };
  return m;
}

/**
 * Plugin manager whose Loxone instance confirms exactly the values sent through
 * mqtt.send. `values`
 * overrides single topics with a fixed Loxone value (null = not published).
 */
export function makePluginManager(mqtt, values = new Map()) {
  const loxone = {
    peekPublishedValue: vi.fn((topic) => {
      if (values.has(topic)) return values.get(topic);
      const raw = mqtt.sent.get(topic);
      return raw === undefined ? null : parseCommandValue(raw);
    }),
  };
  return { loxone, getInstance: vi.fn((id) => (id === 'loxone' ? loxone : null)) };
}

export function makeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

export function allLogged(logger) {
  return JSON.stringify(['debug', 'info', 'warn', 'error'].map((l) => logger[l].mock.calls));
}

export const DEVICES_CFG = [
  { key: 'eg', model: 'dreame.vacuum.r2449a', befehlThema: 'loxone/sauger-eg/befehl' },
  { key: 'og', name: 'Mova OG', befehlThema: 'loxone/sauger-og/befehl' },
];

export function makeConfig(over = {}) {
  const store = {
    plugins: {
      dreame: {
        username: 'me@example.org',
        password: 'geheim-passwort-123',
        country: 'eu',
        pollSeconds: 60,
        devices: DEVICES_CFG,
        ...over,
      },
    },
  };
  return {
    store,
    get: vi.fn((key, fallback) => {
      let v = store;
      for (const k of key.split('.')) { if (v == null) return fallback; v = v[k]; }
      return v !== undefined ? v : fallback;
    }),
    set: vi.fn((key, value) => {
      const keys = key.split('.');
      let o = store;
      for (const k of keys.slice(0, -1)) o = o[k] ??= {};
      o[keys.at(-1)] = value;
    }),
    save: vi.fn(async () => {}),
  };
}

/** Programmable fake cloud with the DreameCloud surface the plugin uses. */
export function makeFakeCloud(over = {}) {
  const records = [
    { did: DID_EG, model: 'dreame.vacuum.r2449a', name: 'Sauger EG', uid: 'uid-1', prefix: '10000', bindDomain: '10000.mt.eu.iot.dreame.tech:19973', latestStatus: null, battery: null },
    { did: DID_OG, model: 'dreame.vacuum.r2427a', name: 'Mova OG', uid: 'uid-1', prefix: '10000', bindDomain: '10000.mt.eu.iot.dreame.tech:19973', latestStatus: null, battery: null },
  ];
  const cloud = {
    _loggedIn: true,
    authFailed: false,
    isLoggedIn: vi.fn(() => cloud._loggedIn),
    login: vi.fn(async () => cloud._loggedIn),
    listDevices: vi.fn(async () => records),
    getProperties: vi.fn(async () => ({ reachable: true, values: { '2.1': 6, '2.2': 0, '3.1': 77 } })),
    action: vi.fn(async () => ({ ok: true })),
    startPush: vi.fn(() => true),
    stopPush: vi.fn(),
    redact: vi.fn((s) => s),
    pushHandler: null,
    records,
    ...over,
  };
  cloud.startPush.mockImplementation((_d, h) => { cloud.pushHandler = h; return true; });
  return cloud;
}
