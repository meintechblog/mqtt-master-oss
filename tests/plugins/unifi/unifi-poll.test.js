/**
 * UnifiPoll — 14 cases covering the 3-timer engine, retain semantics, auth
 * gating, staleness gating, phase boundary, and the connected_device cache.
 *
 * Each test is independent: fake-timers initialised in beforeEach, restored in
 * afterEach. No real HTTP / no real MQTT — everything is driven by the mocked
 * UnifiClient + mqttService instance.
 *
 * Behaviour decisions referenced inline (08-CONTEXT.md):
 *   D-T-02/03/04 — topic shape
 *   D-F-02       — non-PoE ports omit poe_* keys
 *   D-M-01       — UAP read-only (no port publishes)
 *   D-P-04       — auth-state gating + clean stop
 *   D-H-02       — heartbeat staleness gating
 *   D-F-04       — connected_device 5-minute cache
 *
 * Phase-boundary invariants (Test 12) re-asserted in plugin-phase-boundary.test.js.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

import { UnifiPoll } from '../../../plugins/unifi/unifi-poll.js';

const FIXTURE_PATH = path.resolve(
  __dirname,
  '../../fixtures/unifi/stat-device-3devices.json',
);

const STAT = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));

/**
 * Build a programmable UnifiClient mock. `request({path})` resolves whatever
 * the test programs via mockResolvedValue / mockResolvedValueOnce. Default
 * behaviour returns the canonical 3-device fixture for /stat/device and an
 * empty data array for /stat/sta.
 */
function createMockClient() {
  const client = new EventEmitter();
  client.getStatus = vi.fn(() => ({ authState: 'connected', authStateReason: null }));
  client.request = vi.fn(async ({ path: p }) => {
    if (typeof p === 'string' && p.endsWith('/stat/device')) return JSON.parse(JSON.stringify(STAT));
    if (typeof p === 'string' && p.endsWith('/stat/sta')) return { data: [] };
    // Phase 14 — soft-default these endpoints so existing tests that don't
    // mock them still pass through the clients/user-list/wlanconf ticks.
    if (typeof p === 'string' && p.endsWith('/stat/health')) return { data: [] };
    if (typeof p === 'string' && p.endsWith('/rest/user')) return { data: [] };
    if (typeof p === 'string' && p.endsWith('/rest/wlanconf')) return { data: [] };
    throw new Error(`MockClient: unexpected request ${p}`);
  });
  return client;
}

function createMockMqtt() {
  return {
    publish: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  };
}

function makePoll(overrides = {}) {
  const client = overrides.client || createMockClient();
  const mqttService = overrides.mqttService || createMockMqtt();
  const poll = new UnifiPoll({
    client,
    mqttService,
    topicPrefix: overrides.topicPrefix ?? 'unifi-x/',
    site: 'default',
    pollDeviceListSec: overrides.pollDeviceListSec ?? 30,
    pollPortStateSec: overrides.pollPortStateSec ?? 5,
    heartbeatSec: overrides.heartbeatSec ?? 60,
    // Phase 14 — propagate clients config when test overrides it.
    clientsEnabled: overrides.clientsEnabled,
    pollClientsSec: overrides.pollClientsSec,
    clientsStaleAfterSec: overrides.clientsStaleAfterSec,
    clientsCleanupAfterSec: overrides.clientsCleanupAfterSec,
    clientsMaxPublished: overrides.clientsMaxPublished,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  return { poll, client, mqttService };
}

// Helpers for topic shape assertions.
const isCmdTopic = (t) => typeof t === 'string' && /\/cmd($|\/)/.test(t);
const isByMacTopic = (t) => typeof t === 'string' && t.includes('/by-mac/');
const isStateTopic = (t) => typeof t === 'string' && t.endsWith('/state');

describe('UnifiPoll', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('Test 1 — constructor does NOT auto-arm timers or publish', () => {
    const { poll, mqttService } = makePoll();
    expect(vi.getTimerCount()).toBe(0);
    expect(mqttService.publish).not.toHaveBeenCalled();
    return poll.stop(); // idempotent: stop() before start() must not throw.
  });

  it('Test 2 — runOnce("device-list") publishes per-device + per-port retained JSON in BOTH namespaces', async () => {
    const { poll, mqttService } = makePoll();

    await poll.runOnce({ kind: 'device-list' });

    // Every publish must carry retain:true.
    for (const call of mqttService.publish.mock.calls) {
      expect(call[2]).toEqual({ retain: true });
    }

    // No /cmd publish anywhere.
    expect(
      mqttService.publish.mock.calls.find(([t]) => isCmdTopic(t)),
    ).toBeUndefined();

    // Topic shape — primary slug under unifi-x/ but NOT under unifi-x/by-mac/.
    const slugTopics = mqttService.publish.mock.calls.filter(
      ([t]) => t.startsWith('unifi-x/') && !isByMacTopic(t),
    );
    const macTopics = mqttService.publish.mock.calls.filter(
      ([t]) => t.startsWith('unifi-x/by-mac/'),
    );

    // Expected: 3 devices, but UAP (port_count 0) still publishes device-state.
    // Per-device state publishes: 3 in slug + 3 in by-mac.
    const slugDeviceState = slugTopics.filter(([t]) => /^unifi-x\/[^/]+\/state$/.test(t));
    expect(slugDeviceState).toHaveLength(3);
    const macDeviceState = macTopics.filter(([t]) => /^unifi-x\/by-mac\/[^/]+\/state$/.test(t));
    expect(macDeviceState).toHaveLength(3);

    // Per-port publishes: USPM16P 18 ports + UCG-MAX 5 ports = 23. UAP has 0
    // ports in fixture so D-M-01 has no effect on per-port count here.
    const slugPortState = slugTopics.filter(([t]) => /^unifi-x\/[^/]+\/port\/\d+\/state$/.test(t));
    expect(slugPortState).toHaveLength(23);
    const macPortState = macTopics.filter(([t]) => /^unifi-x\/by-mac\/[^/]+\/port\/\d+\/state$/.test(t));
    expect(macPortState).toHaveLength(23);

    // Every payload parses as JSON.
    for (const call of mqttService.publish.mock.calls) {
      expect(() => JSON.parse(call[1])).not.toThrow();
    }
  });

  it('Test 3 — D-F-02 wire-level: SFP+ port published JSON omits poe_* keys', async () => {
    const { poll, mqttService } = makePoll();
    await poll.runOnce({ kind: 'device-list' });

    // Main/USPM16P has 18 ports, ports 17/18 are SFP+ with port_poe:false.
    const usw = STAT.data.find((d) => d.model === 'USPM16P');
    const sfpPortIdxes = usw.port_table
      .filter((p) => p.port_poe === false)
      .map((p) => p.port_idx);
    expect(sfpPortIdxes.length).toBeGreaterThanOrEqual(2);

    for (const idx of sfpPortIdxes) {
      const publishCall = mqttService.publish.mock.calls.find(
        ([t]) => t.endsWith(`/port/${idx}/state`) && !isByMacTopic(t),
      );
      expect(publishCall).toBeDefined();
      const payload = JSON.parse(publishCall[1]);
      expect('poe_power_w' in payload).toBe(false);
      expect('poe_mode' in payload).toBe(false);
      expect('poe_voltage_v' in payload).toBe(false);
      expect('poe_current_ma' in payload).toBe(false);
    }
  });

  it('Test 4 — UAP device-level publish but NO port publishes (D-M-01)', async () => {
    // Construct a fixture variant where the UAP has a non-empty port_table so
    // we can prove the loop intentionally skips it. The real fixture has UAP
    // port_count=0 which would trivially satisfy the assertion.
    const variant = JSON.parse(JSON.stringify(STAT));
    const uap = variant.data.find((d) => d.type === 'uap');
    uap.port_table = [
      { port_idx: 1, port_poe: false, up: true, speed: 1000, full_duplex: true, name: 'eth0' },
    ];

    const { poll, client, mqttService } = makePoll();
    client.request.mockImplementation(async ({ path: p }) => {
      if (p.endsWith('/stat/device')) return variant;
      if (p.endsWith('/stat/sta')) return { data: [] };
      throw new Error(`unexpected ${p}`);
    });

    await poll.runOnce({ kind: 'device-list' });

    // Device-state publishes for UAP MUST exist (both namespaces).
    const uapDeviceStateSlug = mqttService.publish.mock.calls.find(
      ([t]) => /^unifi-x\/u6-pro\/state$/.test(t),
    );
    expect(uapDeviceStateSlug).toBeDefined();

    // Per-port publishes referencing UAP's slug or MAC MUST NOT exist.
    const uapSlug = 'u6-pro'; // slugify("U6 Pro")
    const uapMacSlug = uap.mac.toLowerCase().replace(/:/g, '-');
    const uapPortPublishes = mqttService.publish.mock.calls.filter(
      ([t]) =>
        t === `unifi-x/${uapSlug}/port/1/state` ||
        t === `unifi-x/by-mac/${uapMacSlug}/port/1/state`,
    );
    expect(uapPortPublishes).toHaveLength(0);
  });

  it('Test 5 — start() arms 3 timers; advancing time fires them', async () => {
    const { poll, client } = makePoll();
    poll.start();
    // Phase 14 — start() arms 7 timers (3 original + clients + user-list + wlanconf + presence-sweep).
    expect(vi.getTimerCount()).toBe(7);

    const initialRequestCount = client.request.mock.calls.length;

    // Port-state interval = 5s.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(client.request.mock.calls.length).toBeGreaterThan(initialRequestCount);

    // Advance another 25s — device-list interval (30s total) should fire.
    await vi.advanceTimersByTimeAsync(25_000);
    // Both loops are now firing; at least 6 requests total (~2 per loop +
    // /stat/sta when device-list runs). We assert a lower bound for stability.
    expect(client.request.mock.calls.length).toBeGreaterThanOrEqual(6);

    await poll.stop();
  });

  it('Test 6 — heartbeat republishes cached state at heartbeatSec', async () => {
    const { poll, mqttService } = makePoll();

    // Prime the cache with one device-list pass.
    await poll.runOnce({ kind: 'device-list' });
    poll.start();
    mqttService.publish.mockClear();

    // Heartbeat fires at 60s. Use 59.5s + 0.5s steps to avoid the 30s
    // device-list tick and the 5s port-state tick concurrently triggering
    // the same window (we want to isolate heartbeat-only output here).
    // Instead just verify heartbeat fires at all by advancing to 60s and
    // confirming there are publishes that derive from cache rather than
    // fresh /stat/device payload.
    await vi.advanceTimersByTimeAsync(60_000);

    // The heartbeat MUST have at least repushed both namespaces for each cached device.
    const publishedTopics = mqttService.publish.mock.calls.map(([t]) => t);
    expect(publishedTopics.some((t) => /^unifi-x\/by-mac\/[^/]+\/state$/.test(t))).toBe(true);
    expect(publishedTopics.some((t) => /^unifi-x\/[^/]+\/state$/.test(t) && !isByMacTopic(t))).toBe(true);

    // Every publish retain:true.
    for (const call of mqttService.publish.mock.calls) {
      expect(call[2]).toEqual({ retain: true });
    }

    await poll.stop();
  });

  it('Test 7 — heartbeat staleness gating (D-H-02): disconnected device stops republishing', async () => {
    const { poll, client, mqttService } = makePoll();

    // First pass: full 3-device fixture populates the snapshot.
    await poll.runOnce({ kind: 'device-list' });
    poll.start();

    // Program the next /stat/device to return only 2 devices (drop UAP).
    const reduced = JSON.parse(JSON.stringify(STAT));
    const droppedDevice = reduced.data.find((d) => d.type === 'uap');
    reduced.data = reduced.data.filter((d) => d.type !== 'uap');

    client.request.mockImplementation(async ({ path: p }) => {
      if (p.endsWith('/stat/device')) return reduced;
      if (p.endsWith('/stat/sta')) return { data: [] };
      throw new Error(`unexpected ${p}`);
    });

    // Advance past device-list tick at 30s — snapshot now omits UAP.
    await vi.advanceTimersByTimeAsync(30_000);

    // Advance further so lastPolledAt(UAP) > 2 * pollPortStateSec (= 10s).
    // The UAP's lastPolledAt was the runOnce timestamp at t=0; we're now at
    // t≈30s which is already > 10s, so the staleness gate should engage
    // when the heartbeat fires.
    mqttService.publish.mockClear();
    await vi.advanceTimersByTimeAsync(30_000); // total t=60s -> heartbeat fires.

    const uapSlug = 'u6-pro';
    const uapMacSlug = droppedDevice.mac.toLowerCase().replace(/:/g, '-');
    const uapHeartbeatPublishes = mqttService.publish.mock.calls.filter(([t]) =>
      t === `unifi-x/${uapSlug}/state` ||
      t === `unifi-x/by-mac/${uapMacSlug}/state`,
    );
    // After D-H-02 staleness gating, the UAP must NOT be heartbeat-republished.
    expect(uapHeartbeatPublishes).toHaveLength(0);

    // The remaining 2 devices ARE still heartbeat-republished.
    const remainingMacs = reduced.data.map((d) => d.mac.toLowerCase().replace(/:/g, '-'));
    for (const macStr of remainingMacs) {
      const seen = mqttService.publish.mock.calls.find(
        ([t]) => t === `unifi-x/by-mac/${macStr}/state`,
      );
      expect(seen).toBeDefined();
    }

    await poll.stop();
  });

  it('Test 8 — heartbeatSec=0 disables the heartbeat timer', () => {
    const { poll } = makePoll({ heartbeatSec: 0 });
    poll.start();
    // 2 original (device-list + port-state) + 4 Phase 14 (clients, user-list, wlanconf, presence-sweep) = 6.
    expect(vi.getTimerCount()).toBe(6);
    return poll.stop();
  });

  it('Test 9 — auth-state gating skips ticks when authState !== "connected"', async () => {
    const client = createMockClient();
    client.getStatus = vi.fn(() => ({ authState: 'refreshing', authStateReason: null }));

    const { poll } = makePoll({ client });
    poll.start();

    const initialCalls = client.request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000); // would normally fire port-state twice.
    expect(client.request.mock.calls.length).toBe(initialCalls);

    // Flip auth state back to connected and advance again.
    client.getStatus = vi.fn(() => ({ authState: 'connected', authStateReason: null }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(client.request.mock.calls.length).toBeGreaterThan(initialCalls);

    await poll.stop();
  });

  it('Test 10 — stop() cancels all timers + awaits in-flight tick', async () => {
    const { poll, client } = makePoll();
    poll.start();
    // Phase 14 — start() arms 7 timers (3 original + clients + user-list + wlanconf + presence-sweep).
    expect(vi.getTimerCount()).toBe(7);

    // Provoke an in-flight tick via runOnce — the timer-driven path is racey
    // under fake timers (vi.advanceTimersByTimeAsync is async, callbacks run
    // in microtasks). runOnce gives us a synchronous handle to a pending tick
    // that stop() must await per the protocol — equivalent assertion.
    let releaseRequest;
    client.request.mockImplementationOnce(
      () => new Promise((res) => { releaseRequest = res; }),
    );
    const tickPromise = poll.runOnce({ kind: 'port-state' });

    const stopPromise = poll.stop();
    let stopped = false;
    stopPromise.then(() => { stopped = true; });

    // Microtask flush — stop must NOT resolve yet because request is pending.
    await Promise.resolve();
    expect(stopped).toBe(false);

    releaseRequest({ data: [] });
    await tickPromise.catch(() => {});
    await stopPromise;

    expect(stopped).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('Test 11 — poll-error event on failed request, retries on next cycle', async () => {
    const { poll, client } = makePoll();
    const errors = [];
    poll.on('poll-error', (e) => errors.push(e));

    client.request.mockRejectedValueOnce(new Error('boom'));
    poll.start();

    await vi.advanceTimersByTimeAsync(5_000); // first port-state tick — fails

    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].kind).toBe('port-state');
    expect(poll.getMetrics().pollErrorCount).toBeGreaterThanOrEqual(1);

    // Timers still armed.
    // Phase 14 — start() arms 7 timers (3 original + clients + user-list + wlanconf + presence-sweep).
    expect(vi.getTimerCount()).toBe(7);

    // Next tick — default mock resolves successfully; pollErrorCount should NOT
    // increment beyond the previous value (no new error).
    const errCountBefore = poll.getMetrics().pollErrorCount;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(poll.getMetrics().pollErrorCount).toBe(errCountBefore);

    await poll.stop();
  });

  it('Test 12 — CRITICAL phase-boundary: NEVER subscribes; NEVER publishes /cmd', async () => {
    const { poll, mqttService } = makePoll();
    poll.start();
    await vi.advanceTimersByTimeAsync(120_000); // 2 minutes covers every timer.
    await poll.stop();

    expect(mqttService.subscribe).not.toHaveBeenCalled();
    // No /cmd topic ever published.
    const cmdPublishes = mqttService.publish.mock.calls.filter(([t]) => isCmdTopic(t));
    expect(cmdPublishes).toHaveLength(0);
    // No /cmd/result topic either.
    const cmdResultPublishes = mqttService.publish.mock.calls.filter(([t]) => t.includes('/cmd/result'));
    expect(cmdResultPublishes).toHaveLength(0);
  });

  it('Test 13 — LLDP-driven connected_device flows through to the per-port JSON', async () => {
    const variant = JSON.parse(JSON.stringify(STAT));
    const usw = variant.data.find((d) => d.type === 'usw');
    usw.port_table[0].lldp_table = [{ system_name: 'esp32.lan' }];

    const { poll, client, mqttService } = makePoll();
    client.request.mockImplementation(async ({ path: p }) => {
      if (p.endsWith('/stat/device')) return variant;
      if (p.endsWith('/stat/sta')) return { data: [] };
      throw new Error(`unexpected ${p}`);
    });

    await poll.runOnce({ kind: 'device-list' });

    const portPublish = mqttService.publish.mock.calls.find(
      ([t]) => t === `unifi-x/${usw.name.toLowerCase()}/port/1/state`,
    );
    expect(portPublish).toBeDefined();
    const payload = JSON.parse(portPublish[1]);
    expect(payload.connected_device).toBe('esp32.lan');
  });

  // ---- Phase 9 additions (09-02 Task 1) -----------------------------------

  it('Test A (Phase 9) — getCachedPortTables + getRuntimeProtectedPorts populated by runOnce(device-list)', async () => {
    const { poll } = makePoll();

    await poll.runOnce({ kind: 'device-list' });

    // Cached port_tables: keyed by mac lowercase, with non-empty array for Main USPM16P.
    const tables = poll.getCachedPortTables();
    expect(tables).toBeInstanceOf(Map);
    const mainPorts = tables.get('02:00:00:00:00:fa');
    expect(Array.isArray(mainPorts)).toBe(true);
    expect(mainPorts.length).toBeGreaterThan(0);
    // Entries carry the fields createPoEController needs for the not-PoE gate.
    const firstPort = mainPorts.find((p) => Number(p.port_idx) === 1);
    expect(firstPort).toBeDefined();
    expect(typeof firstPort.port_poe).toBe('boolean');

    // Runtime protected ports: LLDP-augmented from U6P uplink (uplink_mac=Main,
    // uplink_remote_port=2 → adds "02:00:00:00:00:fa:2").
    const runtime = poll.getRuntimeProtectedPorts();
    expect(runtime).toBeInstanceOf(Set);
    expect(runtime.has('02:00:00:00:00:fa:2')).toBe(true);
  });

  it('Test B (Phase 9) — getRuntimeProtectedPorts is EMPTY when no devices have uplink + no LLDP table mentions controller', async () => {
    // Strip every device's uplink + lldp_table entries.
    const stripped = JSON.parse(JSON.stringify(STAT));
    for (const d of stripped.data) {
      delete d.uplink;
      delete d.last_uplink;
      if (Array.isArray(d.port_table)) {
        for (const p of d.port_table) {
          delete p.lldp_table;
          // Also drop is_uplink which some impls might key on (defensive).
          if (Object.prototype.hasOwnProperty.call(p, 'is_uplink')) p.is_uplink = false;
        }
      }
    }

    const { poll, client } = makePoll();
    client.request.mockImplementation(async ({ path: p }) => {
      if (p.endsWith('/stat/device')) return stripped;
      if (p.endsWith('/stat/sta')) return { data: [] };
      throw new Error(`unexpected ${p}`);
    });

    await poll.runOnce({ kind: 'device-list' });

    const runtime = poll.getRuntimeProtectedPorts();
    expect(runtime).toBeInstanceOf(Set);
    expect(runtime.size).toBe(0);
  });

  it('Test C (Phase 9) — runtime protected set REBUILT each poll (no leftover state from prior fixture)', async () => {
    const { poll, client } = makePoll();
    // First pass: full fixture → set contains the U6P-uplink entry.
    await poll.runOnce({ kind: 'device-list' });
    expect(poll.getRuntimeProtectedPorts().has('02:00:00:00:00:fa:2')).toBe(true);

    // Second pass: stripped fixture (no uplinks). Set must NARROW to empty —
    // previous entries do not linger across rebuilds.
    const stripped = JSON.parse(JSON.stringify(STAT));
    for (const d of stripped.data) {
      delete d.uplink;
      delete d.last_uplink;
      if (Array.isArray(d.port_table)) {
        for (const p of d.port_table) { delete p.lldp_table; }
      }
    }
    client.request.mockImplementation(async ({ path: p }) => {
      if (p.endsWith('/stat/device')) return stripped;
      if (p.endsWith('/stat/sta')) return { data: [] };
      throw new Error(`unexpected ${p}`);
    });
    await poll.runOnce({ kind: 'device-list' });
    expect(poll.getRuntimeProtectedPorts().size).toBe(0);
  });

  it('Test 14 — connected_device cache TTL = 5 minutes per (mac, port_idx)', async () => {
    const variant = JSON.parse(JSON.stringify(STAT));
    const usw = variant.data.find((d) => d.type === 'usw');
    usw.port_table[0].lldp_table = [{ system_name: 'esp32.lan' }];

    const { poll, client, mqttService } = makePoll();
    let mode = 'with-lldp';
    client.request.mockImplementation(async ({ path: p }) => {
      if (p.endsWith('/stat/device')) {
        const v = JSON.parse(JSON.stringify(variant));
        if (mode === 'without-lldp') {
          const u = v.data.find((d) => d.type === 'usw');
          delete u.port_table[0].lldp_table;
        }
        return v;
      }
      if (p.endsWith('/stat/sta')) return { data: [] };
      throw new Error(`unexpected ${p}`);
    });

    await poll.runOnce({ kind: 'device-list' }); // populates cache

    mode = 'without-lldp';
    mqttService.publish.mockClear();
    await poll.runOnce({ kind: 'port-state' });
    const port1 = mqttService.publish.mock.calls.find(
      ([t]) => t === `unifi-x/${usw.name.toLowerCase()}/port/1/state`,
    );
    expect(port1).toBeDefined();
    expect(JSON.parse(port1[1]).connected_device).toBe('esp32.lan');

    // Advance system time past TTL.
    vi.setSystemTime(Date.now() + 6 * 60_000);
    mqttService.publish.mockClear();
    await poll.runOnce({ kind: 'port-state' });
    const port1b = mqttService.publish.mock.calls.find(
      ([t]) => t === `unifi-x/${usw.name.toLowerCase()}/port/1/state`,
    );
    expect(port1b).toBeDefined();
    expect(JSON.parse(port1b[1]).connected_device).toBeNull();
  });

  // ─── Phase 13 — WAN, ISP, site-health publishing (D-P13-WAN-02/04/05) ────

  it('P13-Test A — runOnce publishes wan/1/state + wan/2/state on gateway device-list tick', async () => {
    const { poll, mqttService } = makePoll();
    await poll.runOnce({ kind: 'device-list' });

    const gwName = STAT.data.find((d) => d.type === 'udm').name.toLowerCase();
    const wan1Topic = `unifi-x/${gwName}/wan/1/state`;
    const wan2Topic = `unifi-x/${gwName}/wan/2/state`;

    const wan1 = mqttService.publish.mock.calls.find(([t]) => t === wan1Topic);
    const wan2 = mqttService.publish.mock.calls.find(([t]) => t === wan2Topic);
    expect(wan1).toBeDefined();
    expect(wan2).toBeDefined();
    // retain:true per D-MISC-01.
    expect(wan1[2]).toEqual({ retain: true });
    expect(wan2[2]).toEqual({ retain: true });

    const wan1Payload = JSON.parse(wan1[1]);
    expect(wan1Payload.interface).toBe('eth4');
    expect(wan1Payload.up).toBe(true);
    expect(wan1Payload.ip).toBe('203.0.113.169');
  });

  it('P13-Test B — site/health published per device-list tick', async () => {
    const { poll, client, mqttService } = makePoll();
    // Re-program the request mock to include /stat/health alongside the
    // default /stat/device and /stat/sta resolutions.
    client.request.mockImplementation(async ({ path: p }) => {
      if (typeof p === 'string' && p.endsWith('/stat/device')) {
        return JSON.parse(JSON.stringify(STAT));
      }
      if (typeof p === 'string' && p.endsWith('/stat/sta')) return { data: [] };
      if (typeof p === 'string' && p.endsWith('/stat/health')) {
        return {
          data: [
            { subsystem: 'wlan', num_ap: 1, num_user: 0, status: 'ok' },
            { subsystem: 'wan', status: 'ok', isp_name: 'ExampleISP', wan_ip: '198.51.100.102', latency: 20 },
            { subsystem: 'lan', num_sw: 1, num_user: 9, status: 'ok' },
            { subsystem: 'www', status: 'ok', latency: 18, uptime: 99, drops: 0 },
            { subsystem: 'vpn', status: 'unknown' },
          ],
        };
      }
      throw new Error(`unexpected ${p}`);
    });
    await poll.runOnce({ kind: 'device-list' });

    const healthCall = mqttService.publish.mock.calls.find(([t]) => t === 'unifi-x/site/health');
    expect(healthCall).toBeDefined();
    expect(healthCall[2]).toEqual({ retain: true });
    const payload = JSON.parse(healthCall[1]);
    expect(payload.wan.isp_name).toBe('ExampleISP');
    expect(payload.wan.public_ip).toBe('198.51.100.102');
    expect(payload.lan.num_user).toBe(9);
    expect(payload.www.uptime).toBe(99);
  });

  it('P13-Test C — wan/isp/state published on every 10th device-list poll (and first), tracked via _pollCount', async () => {
    const { poll, mqttService } = makePoll();
    // First poll: publishes isp state (counter==0).
    await poll.runOnce({ kind: 'device-list' });
    const gwName = STAT.data.find((d) => d.type === 'udm').name.toLowerCase();
    const ispTopic = `unifi-x/${gwName}/wan/isp/state`;
    const first = mqttService.publish.mock.calls.find(([t]) => t === ispTopic);
    expect(first).toBeDefined();

    // Polls 2..10: no isp republish (cadence is every 10th).
    for (let i = 2; i <= 10; i++) {
      mqttService.publish.mockClear();
      await poll.runOnce({ kind: 'device-list' });
      const ispCall = mqttService.publish.mock.calls.find(([t]) => t === ispTopic);
      if (i < 10) {
        expect(ispCall, `iteration ${i} should NOT publish ISP`).toBeUndefined();
      } else {
        // iteration 10 → publishes again.
        expect(ispCall, 'iteration 10 should publish ISP').toBeDefined();
      }
    }
  });

  it('P13-Test D — non-gateway devices do NOT get wan/* topics published', async () => {
    const { poll, mqttService } = makePoll();
    await poll.runOnce({ kind: 'device-list' });

    // Switch + AP slugs should NEVER appear under /wan/.
    const usw = STAT.data.find((d) => d.type === 'usw');
    const uap = STAT.data.find((d) => d.type === 'uap');
    const uswSlug = usw.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const uapSlug = uap.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

    const wanForSwitch = mqttService.publish.mock.calls.find(
      ([t]) => t.startsWith(`unifi-x/${uswSlug}/wan/`),
    );
    const wanForAp = mqttService.publish.mock.calls.find(
      ([t]) => t.startsWith(`unifi-x/${uapSlug}/wan/`),
    );
    expect(wanForSwitch).toBeUndefined();
    expect(wanForAp).toBeUndefined();
  });

  it('P13-Test E — gateway by-mac WAN topics also published (D-T-04 alongside slug)', async () => {
    const { poll, mqttService } = makePoll();
    await poll.runOnce({ kind: 'device-list' });

    const macTopics = mqttService.publish.mock.calls
      .map(([t]) => t)
      .filter((t) => t.startsWith('unifi-x/by-mac/') && t.includes('/wan/'));
    // Expect both wan/1/state and wan/2/state per gateway in by-mac namespace.
    const wan1ByMac = macTopics.find((t) => t.endsWith('/wan/1/state'));
    const wan2ByMac = macTopics.find((t) => t.endsWith('/wan/2/state'));
    expect(wan1ByMac).toBeDefined();
    expect(wan2ByMac).toBeDefined();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Phase 14 — clients polling + presence tests
  // ═══════════════════════════════════════════════════════════════════════

  /** Build a /stat/sta row for a wireless client. */
  function wirelessClient(mac, overrides = {}) {
    return {
      mac,
      hostname: 'iphone-' + mac.slice(-2),
      ip: '192.0.2.45',
      is_wired: false,
      essid: 'Gateway1',
      signal: -57,
      ap_mac: '02:00:00:00:00:fa',
      radio_proto: 'ax',
      channel: 36,
      tx_rate: 866000,
      rx_rate: 866000,
      oui: 'Apple',
      dev_vendor: 'Apple',
      last_seen: Math.floor(Date.now() / 1000),
      first_seen: Math.floor(Date.now() / 1000) - 86400,
      uptime: 3600,
      ...overrides,
    };
  }

  it('P14-Test 1 — runOnce("clients") publishes per-client retained state + summary', async () => {
    const { poll, client, mqttService } = makePoll();
    client.request.mockImplementation(async ({ path: p }) => {
      if (p.endsWith('/stat/sta')) return { data: [wirelessClient('aa:bb:cc:11:22:33')] };
      if (p.endsWith('/stat/device')) return JSON.parse(JSON.stringify(STAT));
      if (p.endsWith('/stat/health')) return { data: [] };
      if (p.endsWith('/rest/user')) return { data: [] };
      if (p.endsWith('/rest/wlanconf')) return { data: [] };
      throw new Error('unexpected');
    });

    await poll.runOnce({ kind: 'clients' });

    const publishes = mqttService.publish.mock.calls.map(([t]) => t);
    expect(publishes).toContain('unifi-x/clients/by-mac/aa-bb-cc-11-22-33/state');
    expect(publishes).toContain('unifi-x/clients/summary');
    // All publishes retained.
    for (const call of mqttService.publish.mock.calls) {
      expect(call[2]).toEqual({ retain: true });
    }
  });

  it('P14-Test 2 — per-client payload carries state:home + essid + ap_mac', async () => {
    const { poll, client, mqttService } = makePoll();
    client.request.mockImplementation(async ({ path: p }) => {
      if (p.endsWith('/stat/sta')) return { data: [wirelessClient('aa:bb:cc:11:22:33')] };
      if (p.endsWith('/stat/device')) return JSON.parse(JSON.stringify(STAT));
      return { data: [] };
    });

    await poll.runOnce({ kind: 'clients' });

    const clientCall = mqttService.publish.mock.calls.find(
      ([t]) => t === 'unifi-x/clients/by-mac/aa-bb-cc-11-22-33/state',
    );
    expect(clientCall).toBeDefined();
    const payload = JSON.parse(clientCall[1]);
    expect(payload.state).toBe('home');
    expect(payload.essid).toBe('Gateway1');
    expect(payload.ap_mac).toBe('02:00:00:00:00:fa');
    expect(payload.is_wired).toBe(false);
    expect(payload.signal_dbm).toBe(-57);
  });

  it('P14-Test 3 — summary payload has correct counts', async () => {
    const { poll, client, mqttService } = makePoll();
    client.request.mockImplementation(async ({ path: p }) => {
      if (p.endsWith('/stat/sta')) {
        return {
          data: [
            wirelessClient('aa:bb:cc:11:22:33'),
            wirelessClient('aa:bb:cc:44:55:66'),
            { ...wirelessClient('11:22:33:44:55:66'), is_wired: true, sw_mac: 'cc:cc:cc:cc:cc:cc', sw_port: 5 },
          ],
        };
      }
      if (p.endsWith('/stat/device')) return JSON.parse(JSON.stringify(STAT));
      return { data: [] };
    });

    await poll.runOnce({ kind: 'clients' });

    const summaryCall = mqttService.publish.mock.calls.find(
      ([t]) => t === 'unifi-x/clients/summary',
    );
    expect(summaryCall).toBeDefined();
    const summary = JSON.parse(summaryCall[1]);
    expect(summary.total).toBe(3);
    expect(summary.wireless).toBe(2);
    expect(summary.wired).toBe(1);
    expect(summary.home).toBe(3);
    expect(summary.not_home).toBe(0);
    expect(summary.by_ssid.Gateway1).toBe(2);
  });

  it('P14-Test 4 — friendly name cross-joined from /rest/user record', async () => {
    const { poll, client, mqttService } = makePoll();
    client.request.mockImplementation(async ({ path: p }) => {
      if (p.endsWith('/stat/sta')) return { data: [wirelessClient('aa:bb:cc:11:22:33', { hostname: 'iphone-raw' })] };
      if (p.endsWith('/rest/user')) {
        return { data: [{ mac: 'aa:bb:cc:11:22:33', name: 'Johns iPhone', note: 'work device' }] };
      }
      if (p.endsWith('/stat/device')) return JSON.parse(JSON.stringify(STAT));
      return { data: [] };
    });

    // Populate user cache first.
    await poll.runOnce({ kind: 'user-list' });
    await poll.runOnce({ kind: 'clients' });

    const clientCall = mqttService.publish.mock.calls.find(
      ([t]) => t === 'unifi-x/clients/by-mac/aa-bb-cc-11-22-33/state',
    );
    const payload = JSON.parse(clientCall[1]);
    expect(payload.name).toBe('Johns iPhone');
    expect(payload.note).toBe('work device');
  });

  it('P14-Test 5 — clientsEnabled=false suppresses ALL client publishes', async () => {
    const { poll, client, mqttService } = makePoll({ clientsEnabled: false });
    client.request.mockImplementation(async ({ path: p }) => {
      if (p.endsWith('/stat/sta')) return { data: [wirelessClient('aa:bb:cc:11:22:33')] };
      return { data: [] };
    });

    await poll.runOnce({ kind: 'clients' });

    const clientPublishes = mqttService.publish.mock.calls.filter(
      ([t]) => t.includes('/clients/'),
    );
    expect(clientPublishes).toHaveLength(0);
  });

  it('P14-Test 6 — clientsMaxPublished cap honored (most-recent-seen first)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const rows = [];
    for (let i = 0; i < 5; i++) {
      rows.push(wirelessClient(`aa:bb:cc:00:00:${i.toString(16).padStart(2, '0')}`, { last_seen: now - i * 60 }));
    }
    const { poll, client, mqttService } = makePoll({ clientsMaxPublished: 3 });
    client.request.mockImplementation(async ({ path: p }) => {
      if (p.endsWith('/stat/sta')) return { data: rows };
      return { data: [] };
    });

    await poll.runOnce({ kind: 'clients' });

    const clientPublishes = mqttService.publish.mock.calls.filter(
      ([t]) => /\/clients\/by-mac\/[a-z0-9-]+\/state$/.test(t),
    );
    // Cap at 3: only the 3 most-recent (i=0,1,2) get published.
    expect(clientPublishes).toHaveLength(3);
    const macs = clientPublishes.map(([t]) => t.match(/by-mac\/([^/]+)\//)[1]);
    expect(macs).toContain('aa-bb-cc-00-00-00');
    expect(macs).toContain('aa-bb-cc-00-00-01');
    expect(macs).toContain('aa-bb-cc-00-00-02');
    expect(macs).not.toContain('aa-bb-cc-00-00-04');
  });

  it('P14-Test 7 — presence sweep marks stale client as not_home after staleThreshold', async () => {
    const { poll, client, mqttService } = makePoll({ clientsStaleAfterSec: 60 });

    // Initial publish: client visible.
    client.request.mockImplementation(async ({ path: p }) => {
      if (p.endsWith('/stat/sta')) return { data: [wirelessClient('aa:bb:cc:11:22:33')] };
      return { data: [] };
    });
    await poll.runOnce({ kind: 'clients' });
    mqttService.publish.mockClear();

    // Disappear — /stat/sta now returns empty. Run clients poll (no new state
    // published for the missing MAC). Then advance time and run sweep.
    client.request.mockImplementation(async () => ({ data: [] }));
    // Fast-forward fake clock past the stale threshold (60 s).
    vi.setSystemTime(Date.now() + 120_000);
    await poll.runOnce({ kind: 'presence-sweep' });

    const transition = mqttService.publish.mock.calls.find(
      ([t]) => t === 'unifi-x/clients/by-mac/aa-bb-cc-11-22-33/state',
    );
    expect(transition).toBeDefined();
    const payload = JSON.parse(transition[1]);
    expect(payload.state).toBe('not_home');
  });

  it('P14-Test 8 — presence sweep retain-clears client after cleanup threshold', async () => {
    const { poll, client, mqttService } = makePoll({
      clientsStaleAfterSec: 60,
      clientsCleanupAfterSec: 600,
    });

    client.request.mockImplementation(async ({ path: p }) => {
      if (p.endsWith('/stat/sta')) return { data: [wirelessClient('aa:bb:cc:11:22:33')] };
      return { data: [] };
    });
    await poll.runOnce({ kind: 'clients' });
    mqttService.publish.mockClear();

    client.request.mockImplementation(async () => ({ data: [] }));
    vi.setSystemTime(Date.now() + 700_000); // > 600s cleanup threshold
    const removedEvents = [];
    poll.on('client-removed', (e) => removedEvents.push(e));
    await poll.runOnce({ kind: 'presence-sweep' });

    // Retain-clear publish: empty payload on the per-client topic.
    const cleared = mqttService.publish.mock.calls.find(
      ([t, p]) => t === 'unifi-x/clients/by-mac/aa-bb-cc-11-22-33/state' && p === '',
    );
    expect(cleared).toBeDefined();
    expect(removedEvents).toHaveLength(1);
    expect(removedEvents[0].mac).toBe('aa:bb:cc:11:22:33');
  });

  it('P14-Test 9 — client-seen event emitted on first appearance only', async () => {
    const { poll, client } = makePoll();
    const seen = [];
    poll.on('client-seen', (e) => seen.push(e));
    client.request.mockImplementation(async ({ path: p }) => {
      if (p.endsWith('/stat/sta')) return { data: [wirelessClient('aa:bb:cc:11:22:33')] };
      return { data: [] };
    });
    await poll.runOnce({ kind: 'clients' });
    await poll.runOnce({ kind: 'clients' });
    await poll.runOnce({ kind: 'clients' });
    // First poll → seen. Subsequent polls → no new 'seen' event.
    expect(seen).toHaveLength(1);
    expect(seen[0].mac).toBe('aa:bb:cc:11:22:33');
  });

  it('P14-Test 10 — PHASE BOUNDARY: clients tick never publishes /cmd or subscribes', async () => {
    const { poll, client, mqttService } = makePoll();
    client.request.mockImplementation(async ({ path: p }) => {
      if (p.endsWith('/stat/sta')) return { data: [wirelessClient('aa:bb:cc:11:22:33')] };
      return { data: [] };
    });
    await poll.runOnce({ kind: 'clients' });
    expect(mqttService.subscribe).not.toHaveBeenCalled();
    const cmdPublishes = mqttService.publish.mock.calls.filter(([t]) => isCmdTopic(t));
    expect(cmdPublishes).toHaveLength(0);
  });

  it('P14-Test 11 — wlanconf cross-join: ssid_security flows into payload', async () => {
    const { poll, client, mqttService } = makePoll();
    client.request.mockImplementation(async ({ path: p }) => {
      if (p.endsWith('/stat/sta')) return { data: [wirelessClient('aa:bb:cc:11:22:33')] };
      if (p.endsWith('/rest/wlanconf')) {
        return { data: [{ name: 'Gateway1', security: 'wpa2-psk' }] };
      }
      return { data: [] };
    });

    await poll.runOnce({ kind: 'wlanconf' });
    await poll.runOnce({ kind: 'clients' });

    const clientCall = mqttService.publish.mock.calls.find(
      ([t]) => t === 'unifi-x/clients/by-mac/aa-bb-cc-11-22-33/state',
    );
    const payload = JSON.parse(clientCall[1]);
    expect(payload.ssid_security).toBe('wpa2-psk');
  });

  it('P14-Test 12 — ap_name resolved when AP is in device snapshot', async () => {
    const { poll, client, mqttService } = makePoll();
    client.request.mockImplementation(async ({ path: p }) => {
      if (p.endsWith('/stat/sta')) {
        return { data: [wirelessClient('aa:bb:cc:11:22:33', { ap_mac: '02:00:00:00:00:fa' })] };
      }
      if (p.endsWith('/stat/device')) return JSON.parse(JSON.stringify(STAT));
      return { data: [] };
    });

    // Run device-list first so _lastSnapshot is populated.
    await poll.runOnce({ kind: 'device-list' });
    await poll.runOnce({ kind: 'clients' });

    const clientCall = mqttService.publish.mock.calls.find(
      ([t]) => t === 'unifi-x/clients/by-mac/aa-bb-cc-11-22-33/state',
    );
    const payload = JSON.parse(clientCall[1]);
    // device snapshot uses raw mac '02:00:00:00:00:fa' (Main USPM16P named "Main" in fixture).
    expect(payload.ap_name).toBe('Main');
  });

  it('P14-Test 13 — getPublishedClients accessor returns defensive copy', async () => {
    const { poll, client } = makePoll();
    client.request.mockImplementation(async ({ path: p }) => {
      if (p.endsWith('/stat/sta')) return { data: [wirelessClient('aa:bb:cc:11:22:33')] };
      return { data: [] };
    });
    await poll.runOnce({ kind: 'clients' });

    const map = poll.getPublishedClients();
    expect(map).toBeInstanceOf(Map);
    expect(map.has('aa:bb:cc:11:22:33')).toBe(true);
    // Mutating the returned map does NOT affect internal state.
    map.clear();
    expect(poll.getPublishedClients().has('aa:bb:cc:11:22:33')).toBe(true);
  });

  it('P14-Test 14 — markClientDiscoveryPublished/hasClientDiscoveryPublished gate Discovery storms', () => {
    const { poll } = makePoll();
    expect(poll.hasClientDiscoveryPublished('aa:bb:cc:11:22:33')).toBe(false);
    poll.markClientDiscoveryPublished('aa:bb:cc:11:22:33');
    expect(poll.hasClientDiscoveryPublished('aa:bb:cc:11:22:33')).toBe(true);
    // Case-insensitive.
    expect(poll.hasClientDiscoveryPublished('AA:BB:CC:11:22:33')).toBe(true);
  });

  it('P14-Test 15 — clients timer schedule (start arms timer; clientsEnabled=false disables)', () => {
    const { poll: enabledPoll } = makePoll();
    enabledPoll.start();
    expect(vi.getTimerCount()).toBe(7);
    enabledPoll.stop();

    const { poll: disabledPoll } = makePoll({ clientsEnabled: false });
    disabledPoll.start();
    // 3 original timers only (no clients/user-list/wlanconf/presence-sweep).
    expect(vi.getTimerCount()).toBe(3);
    disabledPoll.stop();
  });

  // REGRESSION — pre-fix bug 2026-05-13: a single shared _inFlight slot let the
  // 5s port-state timer starve the 30s clients timer indefinitely (LCM 5s,30s =
  // 30s — every clients fire collided with a port-state fire, and port-state
  // was registered first → won the slot → clients silently skipped). The fix
  // splits _inFlight into per-lane mutexes (device vs clients).
  it('P14-Test 16 — clients tick NOT starved by concurrent port-state tick (regression)', async () => {
    const { poll, client, mqttService } = makePoll();

    // Hold port-state's /stat/device request open across the t=30s window so
    // that the device lane is provably in-flight when the clients timer fires.
    let releasePortStateRequest;
    let portStateRequestSeen = 0;
    let staSeenByClients = 0;
    client.request.mockImplementation(async ({ path: p }) => {
      if (p.endsWith('/stat/device')) {
        portStateRequestSeen++;
        // First port-state fire holds open; subsequent fires resolve fast.
        if (portStateRequestSeen === 1) {
          return new Promise((res) => { releasePortStateRequest = () => res(JSON.parse(JSON.stringify(STAT))); });
        }
        return JSON.parse(JSON.stringify(STAT));
      }
      if (p.endsWith('/stat/sta')) {
        staSeenByClients++;
        return { data: [] };
      }
      if (p.endsWith('/stat/health')) return { data: [] };
      if (p.endsWith('/rest/user')) return { data: [] };
      if (p.endsWith('/rest/wlanconf')) return { data: [] };
      return { data: [] };
    });

    poll.start();

    // Advance to t=5s — first port-state tick fires; its /stat/device is now
    // held pending, so _inFlightDevice is set.
    await vi.advanceTimersByTimeAsync(5_000);

    // Advance to t=30s — clients timer fires WHILE port-state still in flight.
    // Pre-fix: clients would silently skip. Post-fix: clients runs on its own
    // lane and publishes the summary topic.
    await vi.advanceTimersByTimeAsync(25_000);

    const summaryTopic = 'unifi-x/clients/summary';
    const summaryPublishes = mqttService.publish.mock.calls.filter(([t]) => t === summaryTopic);
    expect(summaryPublishes.length).toBeGreaterThan(0);

    // Release the held port-state request so stop() can drain.
    releasePortStateRequest?.();
    await poll.stop();
  });
});
