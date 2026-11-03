/**
 * unifi-poe — write surface for PoE control via UniFi controller.
 *
 * 25 cases pinning every safety-critical invariant called out in the plan:
 *   - HA #18267 RMW preservation         (Tests 1, 2, 3)
 *   - Per-device mutex                   (Tests 4, 5)
 *   - Cycle rate-limit                   (Tests 6, 8, 24)
 *   - Cycle uses /cmd/devmgr only        (Test 7)
 *   - Protected-port gate                (Tests 9, 10, 11, 13)
 *   - dryRun zero HTTPS                  (Tests 12, 13)
 *   - not_poe_capable                    (Test 14)
 *   - Payload parsing                    (Tests 15, 16, 17, 18)
 *   - not_connected gate                 (Test 19)
 *   - read_failed                        (Tests 20, 21)
 *   - write_failed                       (Test 22)
 *   - port_idx validation                (Test 23)
 *   - RESULT_STATUS frozen enum          (Test 25)
 *
 * All HTTPS is mocked via a programmable UnifiClient stub (no live network).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { createPoEController, RESULT_STATUS } from '../../../plugins/unifi/unifi-poe.js';

const FIXTURE_PATH = path.resolve(
  __dirname,
  '../../fixtures/unifi/rest-device-main-with-overrides.json',
);
const mainFixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));

/**
 * Build a programmable mock UnifiClient. `request({method, path, body})` will:
 *   - call `requestImpls[\`${method} ${path}\`]` when provided (most specific),
 *   - else default GET /rest/device/* → deviceFixture,
 *   - else default PUT /rest/device/* → { meta:{rc:'ok'} },
 *   - else default POST /cmd/devmgr → { meta:{rc:'ok'} },
 *   - else throw.
 */
function makeClient({ authState = 'connected', deviceFixture, requestImpls = {} } = {}) {
  const requestSpy = vi.fn(async ({ method, path: p, body }) => {
    const key = `${method} ${p}`;
    if (requestImpls[key]) {
      return requestImpls[key]({ method, path: p, body });
    }
    // /stat/device — list endpoint used by applyPortOverride's read path
    // (UCG-MAX-compatible, replaces the old /rest/device/{id} GET).
    if (method === 'GET' && /\/stat\/device$/.test(p)) {
      return deviceFixture;
    }
    if (method === 'GET' && /\/rest\/device\//.test(p)) {
      return deviceFixture;
    }
    if (method === 'PUT' && /\/rest\/device\//.test(p)) {
      return { meta: { rc: 'ok' } };
    }
    if (method === 'POST' && /\/cmd\/devmgr$/.test(p)) {
      return { meta: { rc: 'ok' } };
    }
    throw new Error(`unexpected mock call: ${method} ${p}`);
  });
  return {
    request: requestSpy,
    getStatus: () => ({ authState }),
  };
}

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

describe('createPoEController — RMW (HA #18267) invariants', () => {
  it('Test 1 — setOff on a fresh port preserves EVERY existing port_overrides entry byte-identically', async () => {
    const client = makeClient({ deviceFixture: structuredClone(mainFixture) });
    const poe = createPoEController(client, { site: 'default', dryRun: false, logger: silentLogger });

    const result = await poe.setOff('02:00:00:00:00:fa', 6);
    expect(result.status).toBe(RESULT_STATUS.OK);
    expect(result.action).toBe('off');

    const putCall = client.request.mock.calls.find(([req]) => req.method === 'PUT');
    expect(putCall).toBeDefined();
    const body = putCall[0].body;
    expect(Array.isArray(body.port_overrides)).toBe(true);
    expect(body.port_overrides).toHaveLength(3);

    const port5 = body.port_overrides.find((e) => e.port_idx === 5);
    expect(port5).toEqual({
      port_idx: 5,
      poe_mode: 'off',
      portconf_id: '5ee12ed5da6ad50006e3176f',
      port_name: 'Camera-VLAN',
      port_security_enabled: false,
    });

    const port8 = body.port_overrides.find((e) => e.port_idx === 8);
    expect(port8).toEqual({
      port_idx: 8,
      poe_mode: 'auto',
      portconf_id: '5ee12ed5da6ad50006e3176f',
      port_name: 'Office-AP',
      full_duplex: true,
    });

    const port6 = body.port_overrides.find((e) => e.port_idx === 6);
    expect(port6.port_idx).toBe(6);
    expect(port6.poe_mode).toBe('off');
    expect(port6.portconf_id).toBe('5ee12ed5da6ad50006e3176f');
  });

  it('Test 2 — RMW with NO existing overrides inserts the first entry (with portconf_id from port_table)', async () => {
    const empty = structuredClone(mainFixture);
    empty.data[0].port_overrides = [];
    const client = makeClient({ deviceFixture: empty });
    const poe = createPoEController(client, { site: 'default', dryRun: false, logger: silentLogger });

    const result = await poe.setOn('02:00:00:00:00:fa', 6);
    expect(result.status).toBe(RESULT_STATUS.OK);

    const putCall = client.request.mock.calls.find(([req]) => req.method === 'PUT');
    const body = putCall[0].body;
    expect(body.port_overrides).toHaveLength(1);
    expect(body.port_overrides[0].port_idx).toBe(6);
    expect(body.port_overrides[0].poe_mode).toBe('auto');
    expect(body.port_overrides[0].portconf_id).toBe('5ee12ed5da6ad50006e3176f');
  });

  it('Test 3 — RMW updates existing entry — port 5 off→on preserves every other field', async () => {
    const client = makeClient({ deviceFixture: structuredClone(mainFixture) });
    const poe = createPoEController(client, { site: 'default', dryRun: false, logger: silentLogger });

    const result = await poe.setOn('02:00:00:00:00:fa', 5);
    expect(result.status).toBe(RESULT_STATUS.OK);

    const putCall = client.request.mock.calls.find(([req]) => req.method === 'PUT');
    const body = putCall[0].body;
    const port5 = body.port_overrides.find((e) => e.port_idx === 5);
    expect(port5.poe_mode).toBe('auto');
    expect(port5.port_name).toBe('Camera-VLAN');
    expect(port5.port_security_enabled).toBe(false);
    expect(port5.portconf_id).toBe('5ee12ed5da6ad50006e3176f');

    // port 8 must remain untouched.
    const port8 = body.port_overrides.find((e) => e.port_idx === 8);
    expect(port8).toEqual({
      port_idx: 8,
      poe_mode: 'auto',
      portconf_id: '5ee12ed5da6ad50006e3176f',
      port_name: 'Office-AP',
      full_duplex: true,
    });
  });
});

describe('createPoEController — per-device mutex (D-RMW-02)', () => {
  it('Test 4 — two concurrent setOff to SAME mac serialize through the per-device mutex', async () => {
    let resolveGet1;
    let resolveGet2;
    let getCallCount = 0;
    const client = {
      request: vi.fn(async ({ method, path: p }) => {
        if (method === 'GET' && /\/stat\/device$/.test(p)) {
          getCallCount++;
          if (getCallCount === 1) {
            return new Promise((r) => {
              resolveGet1 = () => r(structuredClone(mainFixture));
            });
          }
          if (getCallCount === 2) {
            return new Promise((r) => {
              resolveGet2 = () => r(structuredClone(mainFixture));
            });
          }
        }
        if (method === 'PUT') return { meta: { rc: 'ok' } };
        return {};
      }),
      getStatus: () => ({ authState: 'connected' }),
    };
    const poe = createPoEController(client, { site: 'default', dryRun: false, logger: silentLogger });

    const p1 = poe.setOff('02:00:00:00:00:fa', 6);
    const p2 = poe.setOff('02:00:00:00:00:fa', 7);

    // Drain the microtask queue a few turns — both setOff awaits should now be
    // parked. Only the FIRST GET should have been dispatched.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(getCallCount).toBe(1);

    resolveGet1();
    const r1 = await p1;
    expect(r1.status).toBe(RESULT_STATUS.OK);

    // After p1 completed (mutex released), the second GET fires.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(getCallCount).toBe(2);

    resolveGet2();
    const r2 = await p2;
    expect(r2.status).toBe(RESULT_STATUS.OK);
  });

  it('Test 5 — concurrent setOff to DIFFERENT MACs proceed in parallel', async () => {
    // Both devices live in the same /stat/device response; the RMW path picks
    // the right one by MAC. The mutex partition is per-mac, so two distinct
    // MACs run in parallel even though they hit the same GET URL.
    const fixtureBoth = structuredClone(mainFixture);
    fixtureBoth.data.push({
      ...structuredClone(mainFixture.data[0]),
      mac: '02:00:00:00:00:0a',
      _id: 'a000a000a000a000a000a000',
    });

    let getCallCount = 0;
    const releasers = [];
    const client = {
      request: vi.fn(async ({ method, path: p }) => {
        if (method === 'GET' && /\/stat\/device$/.test(p)) {
          getCallCount++;
          return new Promise((r) => {
            releasers.push(() => r(structuredClone(fixtureBoth)));
          });
        }
        if (method === 'PUT') return { meta: { rc: 'ok' } };
        return {};
      }),
      getStatus: () => ({ authState: 'connected' }),
    };
    const poe = createPoEController(client, { site: 'default', dryRun: false, logger: silentLogger });

    const p1 = poe.setOff('02:00:00:00:00:fa', 6);
    const p2 = poe.setOff('02:00:00:00:00:0a', 1);

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    // BOTH GETs should be in flight even before any release.
    expect(getCallCount).toBe(2);

    // Release both — order does not matter.
    releasers.forEach((fn) => fn());
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.status).toBe(RESULT_STATUS.OK);
    expect(r2.status).toBe(RESULT_STATUS.OK);
  });
});

describe('createPoEController — cycle rate-limit (D-RL-01..03)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-13T12:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('Test 6 — 2nd cycle within 10s window → rate_limited with retryAfterMs, ZERO 2nd HTTPS', async () => {
    const client = makeClient({ deviceFixture: structuredClone(mainFixture) });
    const poe = createPoEController(client, {
      site: 'default',
      dryRun: false,
      cyclePortRateLimitMs: 10000,
      logger: silentLogger,
    });

    const r1 = await poe.setCycle('02:00:00:00:00:fa', 6);
    expect(r1.status).toBe(RESULT_STATUS.OK);

    const postCalls = client.request.mock.calls.filter(([r]) => r.method === 'POST');
    expect(postCalls).toHaveLength(1);
    expect(postCalls[0][0].path).toMatch(/\/cmd\/devmgr$/);
    expect(postCalls[0][0].body).toEqual({
      cmd: 'power-cycle',
      mac: '02:00:00:00:00:fa',
      port_idx: 6,
    });

    // 5s later — still inside the window.
    vi.setSystemTime(new Date('2026-05-13T12:00:05.000Z'));
    const r2 = await poe.setCycle('02:00:00:00:00:fa', 6);
    expect(r2.status).toBe(RESULT_STATUS.RATE_LIMITED);
    expect(r2.retryAfterMs).toBeGreaterThan(0);
    expect(r2.retryAfterMs).toBeLessThanOrEqual(5000);

    const postCallsAfter = client.request.mock.calls.filter(([r]) => r.method === 'POST');
    expect(postCallsAfter).toHaveLength(1); // NO second outbound HTTPS.

    // 11s after the first cycle — window cleared.
    vi.setSystemTime(new Date('2026-05-13T12:00:11.000Z'));
    const r3 = await poe.setCycle('02:00:00:00:00:fa', 6);
    expect(r3.status).toBe(RESULT_STATUS.OK);
  });

  it('Test 8 — rate-limit key includes port_idx; port 6 cooldown does not block port 7', async () => {
    const client = makeClient({ deviceFixture: structuredClone(mainFixture) });
    const poe = createPoEController(client, {
      site: 'default',
      dryRun: false,
      cyclePortRateLimitMs: 10000,
      logger: silentLogger,
    });

    const r1 = await poe.setCycle('02:00:00:00:00:fa', 6);
    expect(r1.status).toBe(RESULT_STATUS.OK);

    vi.setSystemTime(new Date('2026-05-13T12:00:05.000Z'));
    const r2 = await poe.setCycle('02:00:00:00:00:fa', 7);
    expect(r2.status).toBe(RESULT_STATUS.OK);
  });

  it('Test 24 — write_failed locks the rate-limit window (D-RL-02 — failure also consumes)', async () => {
    let postCount = 0;
    const client = {
      request: vi.fn(async ({ method, path: p }) => {
        if (method === 'POST' && p.includes('/cmd/devmgr')) {
          postCount++;
          if (postCount === 1) throw new Error('boom');
          return { meta: { rc: 'ok' } };
        }
        return {};
      }),
      getStatus: () => ({ authState: 'connected' }),
    };
    const poe = createPoEController(client, {
      site: 'default',
      dryRun: false,
      cyclePortRateLimitMs: 10000,
      logger: silentLogger,
    });

    const r1 = await poe.setCycle('02:00:00:00:00:fa', 6);
    expect(r1.status).toBe(RESULT_STATUS.WRITE_FAILED);

    vi.setSystemTime(new Date('2026-05-13T12:00:01.000Z'));
    const r2 = await poe.setCycle('02:00:00:00:00:fa', 6);
    expect(r2.status).toBe(RESULT_STATUS.RATE_LIMITED);
    expect(postCount).toBe(1);
  });
});

describe('createPoEController — cycle uses /cmd/devmgr only (D-CMD-03)', () => {
  it('Test 7 — cycle issues exactly ONE POST /cmd/devmgr — NEVER off+on, NEVER touches port_overrides', async () => {
    const client = makeClient({ deviceFixture: structuredClone(mainFixture) });
    const poe = createPoEController(client, { site: 'default', dryRun: false, logger: silentLogger });

    await poe.setCycle('02:00:00:00:00:fa', 6);

    const gets = client.request.mock.calls.filter(([r]) => r.method === 'GET');
    const puts = client.request.mock.calls.filter(([r]) => r.method === 'PUT');
    const posts = client.request.mock.calls.filter(([r]) => r.method === 'POST');

    expect(gets).toHaveLength(0);
    expect(puts).toHaveLength(0);
    expect(posts).toHaveLength(1);
    expect(posts[0][0].path).toMatch(/\/cmd\/devmgr$/);
    expect(posts[0][0].body.cmd).toBe('power-cycle');
  });
});

describe('createPoEController — protected-port (D-PROTECT-02, T-09-05)', () => {
  it('Test 9 — off + cycle on the hardcoded protected port → protected_port, ZERO HTTPS', async () => {
    const client = makeClient({ deviceFixture: structuredClone(mainFixture) });
    const poe = createPoEController(client, { site: 'default', dryRun: false, logger: silentLogger });

    const r1 = await poe.setOff('02:00:00:00:00:fa', 1);
    expect(r1.status).toBe(RESULT_STATUS.PROTECTED_PORT);
    expect(r1.action).toBe('off');
    expect(typeof r1.reason).toBe('string');
    expect(r1.reason.length).toBeGreaterThan(0);

    const r2 = await poe.setCycle('02:00:00:00:00:fa', 1);
    expect(r2.status).toBe(RESULT_STATUS.PROTECTED_PORT);
    expect(r2.action).toBe('cycle');

    expect(client.request.mock.calls).toHaveLength(0);
  });

  it('Test 10 — ON on the protected port is RECOVERY and proceeds normally', async () => {
    const client = makeClient({ deviceFixture: structuredClone(mainFixture) });
    const poe = createPoEController(client, { site: 'default', dryRun: false, logger: silentLogger });

    const r = await poe.setOn('02:00:00:00:00:fa', 1);
    expect(r.status).toBe(RESULT_STATUS.OK);

    const putCall = client.request.mock.calls.find(([req]) => req.method === 'PUT');
    expect(putCall).toBeDefined();
    const port1 = putCall[0].body.port_overrides.find((e) => e.port_idx === 1);
    expect(port1).toBeDefined();
    expect(port1.poe_mode).toBe('auto');
  });

  it('Test 11 — protected-port match is case-insensitive on MAC', async () => {
    const client = makeClient({ deviceFixture: structuredClone(mainFixture) });
    const poe = createPoEController(client, { site: 'default', dryRun: false, logger: silentLogger });

    const r = await poe.setOff('02:00:00:00:00:fa', 1);
    expect(r.status).toBe(RESULT_STATUS.PROTECTED_PORT);
    expect(client.request.mock.calls).toHaveLength(0);
  });
});

describe('createPoEController — dryRun (D-DRY-01..03)', () => {
  it('Test 12 — dryRun=true on all 3 verbs returns ok+dryRun, ZERO HTTPS', async () => {
    const client = makeClient({ deviceFixture: structuredClone(mainFixture) });
    const poe = createPoEController(client, { site: 'default', dryRun: true, logger: silentLogger });

    const rOn = await poe.setOn('02:00:00:00:00:fa', 6);
    const rOff = await poe.setOff('02:00:00:00:00:fa', 6);
    const rCyc = await poe.setCycle('02:00:00:00:00:fa', 6);

    expect(rOn.status).toBe(RESULT_STATUS.OK);
    expect(rOn.dryRun).toBe(true);
    expect(rOn.action).toBe('on');

    expect(rOff.status).toBe(RESULT_STATUS.OK);
    expect(rOff.dryRun).toBe(true);
    expect(rOff.action).toBe('off');

    expect(rCyc.status).toBe(RESULT_STATUS.OK);
    expect(rCyc.dryRun).toBe(true);
    expect(rCyc.action).toBe('cycle');

    expect(client.request.mock.calls).toHaveLength(0);
  });

  it('Test 13 — dryRun=true STILL refuses a protected port (off) — safety wins over dryRun', async () => {
    const client = makeClient({ deviceFixture: structuredClone(mainFixture) });
    const poe = createPoEController(client, { site: 'default', dryRun: true, logger: silentLogger });

    const r = await poe.setOff('02:00:00:00:00:fa', 1);
    expect(r.status).toBe(RESULT_STATUS.PROTECTED_PORT);
    expect(client.request.mock.calls).toHaveLength(0);
  });
});

describe('createPoEController — not_poe_capable (D-MISC-03)', () => {
  it('Test 14 — SFP+ port (port_poe=false in cached telemetry) → not_poe_capable, ZERO HTTPS', async () => {
    const portTables = new Map();
    portTables.set('02:00:00:00:00:fa', mainFixture.data[0].port_table);

    const client = makeClient({ deviceFixture: structuredClone(mainFixture) });
    const poe = createPoEController(client, {
      site: 'default',
      dryRun: false,
      getPortTablesByMac: () => portTables,
      logger: silentLogger,
    });

    const r = await poe.setOff('02:00:00:00:00:fa', 17);
    expect(r.status).toBe(RESULT_STATUS.NOT_POE_CAPABLE);
    expect(client.request.mock.calls).toHaveLength(0);
  });
});

describe('createPoEController — payload parsing (D-CMD-01)', () => {
  it('Test 15 — case-insensitive plain-string payload — ON / Off / Cycle all accepted', async () => {
    const client = makeClient({ deviceFixture: structuredClone(mainFixture) });
    const poe = createPoEController(client, { site: 'default', dryRun: false, logger: silentLogger });

    const rOn = await poe.dispatch('02:00:00:00:00:fa', 6, 'ON');
    expect(rOn.status).toBe(RESULT_STATUS.OK);
    expect(rOn.action).toBe('on');

    // Reset request mock between dispatches.
    client.request.mockClear();
    const fresh = makeClient({ deviceFixture: structuredClone(mainFixture) });
    const poe2 = createPoEController(fresh, { site: 'default', dryRun: false, logger: silentLogger });
    const rOff = await poe2.dispatch('02:00:00:00:00:fa', 6, '  Off  ');
    expect(rOff.status).toBe(RESULT_STATUS.OK);
    expect(rOff.action).toBe('off');

    const fresh2 = makeClient({ deviceFixture: structuredClone(mainFixture) });
    const poe3 = createPoEController(fresh2, { site: 'default', dryRun: false, logger: silentLogger });
    const rCyc = await poe3.dispatch('02:00:00:00:00:fa', 6, 'Cycle');
    expect(rCyc.status).toBe(RESULT_STATUS.OK);
    expect(rCyc.action).toBe('cycle');
  });

  it('Test 16 — JSON payload {action:"off"} accepted', async () => {
    const client = makeClient({ deviceFixture: structuredClone(mainFixture) });
    const poe = createPoEController(client, { site: 'default', dryRun: false, logger: silentLogger });

    const r = await poe.dispatch('02:00:00:00:00:fa', 6, JSON.stringify({ action: 'off' }));
    expect(r.status).toBe(RESULT_STATUS.OK);
    expect(r.action).toBe('off');
  });

  it('Test 17 — invalid plain-string payload → invalid_payload, ZERO HTTPS', async () => {
    const client = makeClient({ deviceFixture: structuredClone(mainFixture) });
    const poe = createPoEController(client, { site: 'default', dryRun: false, logger: silentLogger });

    const r = await poe.dispatch('02:00:00:00:00:fa', 6, 'turbo');
    expect(r.status).toBe(RESULT_STATUS.INVALID_PAYLOAD);
    expect(client.request.mock.calls).toHaveLength(0);
  });

  it('Test 18 — invalid JSON payload (no action key) → invalid_payload', async () => {
    const client = makeClient({ deviceFixture: structuredClone(mainFixture) });
    const poe = createPoEController(client, { site: 'default', dryRun: false, logger: silentLogger });

    const r = await poe.dispatch('02:00:00:00:00:fa', 6, JSON.stringify({ verb: 'on' }));
    expect(r.status).toBe(RESULT_STATUS.INVALID_PAYLOAD);
  });

  it('Rename-Test 1 — JSON {action:"rename",name:"Living Room"} → setName RMW with port_overrides preservation', async () => {
    const client = makeClient({ deviceFixture: structuredClone(mainFixture) });
    const poe = createPoEController(client, { site: 'default', dryRun: false, logger: silentLogger });

    const r = await poe.dispatch('02:00:00:00:00:fa', 6, JSON.stringify({ action: 'rename', name: 'Living Room' }));
    expect(r.status).toBe(RESULT_STATUS.OK);
    expect(r.action).toBe('rename');
    expect(r.name).toBe('Living Room');

    // RMW preserved every other entry and merged BOTH name + port_name into
    // port 6. port_name is what the UniFi UI's Port Settings dialog reads;
    // name is what older firmwares + the mobile app honour. Writing both
    // covers every controller variant.
    const putCall = client.request.mock.calls.find(([req]) => req.method === 'PUT');
    expect(putCall).toBeDefined();
    const body = putCall[0].body;
    const port6 = body.port_overrides.find((e) => e.port_idx === 6);
    expect(port6.name).toBe('Living Room');
    expect(port6.port_name).toBe('Living Room');
    // Other ports untouched.
    const port5 = body.port_overrides.find((e) => e.port_idx === 5);
    expect(port5.port_name).toBe('Camera-VLAN');
    const port8 = body.port_overrides.find((e) => e.port_idx === 8);
    expect(port8.port_name).toBe('Office-AP');
  });

  it('Rename-Test 2 — empty / whitespace-only / oversized / control-char names rejected before any HTTPS', async () => {
    const cases = [
      JSON.stringify({ action: 'rename', name: '' }),
      JSON.stringify({ action: 'rename', name: '   ' }),
      JSON.stringify({ action: 'rename', name: 'x'.repeat(33) }),
      JSON.stringify({ action: 'rename', name: 'bad name' }),
      JSON.stringify({ action: 'rename', name: 'with\nnewline' }),
      JSON.stringify({ action: 'rename' }), // missing name
      JSON.stringify({ action: 'rename', name: 42 }), // wrong type
    ];
    for (const payload of cases) {
      const client = makeClient({ deviceFixture: structuredClone(mainFixture) });
      const poe = createPoEController(client, { site: 'default', dryRun: false, logger: silentLogger });
      const r = await poe.dispatch('02:00:00:00:00:fa', 6, payload);
      expect(r.status).toBe(RESULT_STATUS.INVALID_PAYLOAD);
      expect(client.request.mock.calls).toHaveLength(0);
    }
  });

  it('Rename-Test 3 — names are trimmed before being forwarded to the controller', async () => {
    const client = makeClient({ deviceFixture: structuredClone(mainFixture) });
    const poe = createPoEController(client, { site: 'default', dryRun: false, logger: silentLogger });
    const r = await poe.dispatch('02:00:00:00:00:fa', 6, JSON.stringify({ action: 'rename', name: '  Port Label  ' }));
    expect(r.status).toBe(RESULT_STATUS.OK);
    expect(r.name).toBe('Port Label');
    const putCall = client.request.mock.calls.find(([req]) => req.method === 'PUT');
    const body = putCall[0].body;
    const port6 = body.port_overrides.find((e) => e.port_idx === 6);
    expect(port6.name).toBe('Port Label');
  });

  it('Rename-Test 4 — dryRun: setName logs but ZERO HTTPS calls', async () => {
    const client = makeClient({ deviceFixture: structuredClone(mainFixture) });
    const poe = createPoEController(client, { site: 'default', dryRun: true, logger: silentLogger });
    const r = await poe.dispatch('02:00:00:00:00:fa', 6, JSON.stringify({ action: 'rename', name: 'Tested' }));
    expect(r.status).toBe(RESULT_STATUS.OK);
    expect(r.dryRun).toBe(true);
    expect(r.name).toBe('Tested');
    expect(client.request.mock.calls).toHaveLength(0);
  });

  it('Rename-Test 5 — rename targets a protected port — write proceeds (no power impact)', async () => {
    const client = makeClient({ deviceFixture: structuredClone(mainFixture) });
    const poe = createPoEController(client, { site: 'default', dryRun: false, logger: silentLogger });
    // Port 1 on 02:00:00:00:00:fa is the controller-uplink in the hardcoded floor.
    const r = await poe.dispatch('02:00:00:00:00:fa', 1, JSON.stringify({ action: 'rename', name: 'Uplink' }));
    expect(r.status).toBe(RESULT_STATUS.OK);
    expect(r.action).toBe('rename');
  });
});

describe('createPoEController — RMW read path (UCG-MAX 404 fix)', () => {
  // The old /rest/device/{mac-or-id} GET 404s on UCG-MAX firmware. The
  // RMW path now reads from /stat/device (which polling already proves
  // works) and picks the target device by MAC. The PUT still targets
  // /rest/device/{_id} — which DOES work for writes on UCG-MAX.
  it('Rmw-Read-Test 1 — GET hits /stat/device (not /rest/device/{anything})', async () => {
    const client = makeClient({ deviceFixture: structuredClone(mainFixture) });
    const poe = createPoEController(client, { site: 'default', dryRun: false, logger: silentLogger });
    const r = await poe.setOn('02:00:00:00:00:fa', 6);
    expect(r.status).toBe(RESULT_STATUS.OK);
    const getCall = client.request.mock.calls.find(([req]) => req.method === 'GET' && /\/stat\/device$/.test(req.path));
    expect(getCall).toBeDefined();
    expect(getCall[0].path).toBe('/proxy/network/api/s/default/stat/device');
    // Make sure we did NOT hit the broken /rest/device/{...} GET.
    const restGet = client.request.mock.calls.find(([req]) => req.method === 'GET' && /\/rest\/device\//.test(req.path));
    expect(restGet).toBeUndefined();
  });

  it('Rmw-Read-Test 2 — PUT still targets /rest/device/{_id} (write endpoint unchanged)', async () => {
    const client = makeClient({ deviceFixture: structuredClone(mainFixture) });
    const poe = createPoEController(client, { site: 'default', dryRun: false, logger: silentLogger });
    await poe.setOn('02:00:00:00:00:fa', 6);
    const putCall = client.request.mock.calls.find(([req]) => req.method === 'PUT');
    expect(putCall).toBeDefined();
    expect(putCall[0].path).toBe(`/proxy/network/api/s/default/rest/device/${mainFixture.data[0]._id}`);
  });

  it('Rmw-Read-Test 3 — device not in /stat/device response → read_failed (clear error message)', async () => {
    const empty = { data: [] };
    const client = makeClient({ deviceFixture: empty });
    const poe = createPoEController(client, { site: 'default', dryRun: false, logger: silentLogger });
    const r = await poe.setOn('02:00:00:00:00:fa', 6);
    expect(r.status).toBe(RESULT_STATUS.READ_FAILED);
    expect(r.error).toMatch(/not found/i);
  });
});

describe('createPoEController — auth-state gate (D-MISC-02)', () => {
  it('Test 19 — dispatch with authState !== "connected" → not_connected, ZERO HTTPS', async () => {
    const client = makeClient({
      authState: 'refreshing',
      deviceFixture: structuredClone(mainFixture),
    });
    const poe = createPoEController(client, { site: 'default', dryRun: false, logger: silentLogger });

    const r = await poe.dispatch('02:00:00:00:00:fa', 6, 'on');
    expect(r.status).toBe(RESULT_STATUS.NOT_CONNECTED);
    expect(client.request.mock.calls).toHaveLength(0);
  });
});

describe('createPoEController — read_failed (D-RMW-04)', () => {
  it('Test 20 — GET throws → read_failed, NEVER issues PUT', async () => {
    const client = {
      request: vi.fn(async ({ method }) => {
        if (method === 'GET') throw new Error('boom — 500 Internal');
        return { meta: { rc: 'ok' } };
      }),
      getStatus: () => ({ authState: 'connected' }),
    };
    const poe = createPoEController(client, { site: 'default', dryRun: false, logger: silentLogger });

    const r = await poe.setOff('02:00:00:00:00:fa', 6);
    expect(r.status).toBe(RESULT_STATUS.READ_FAILED);
    expect(typeof r.error).toBe('string');
    expect(r.error.length).toBeGreaterThan(0);

    const puts = client.request.mock.calls.filter(([req]) => req.method === 'PUT');
    expect(puts).toHaveLength(0);
  });

  it('Test 21 — GET returns unexpected shape → read_failed, NEVER issues PUT', async () => {
    const client = makeClient({
      deviceFixture: { meta: { rc: 'ok' }, data: 'not-an-array' },
    });
    const poe = createPoEController(client, { site: 'default', dryRun: false, logger: silentLogger });

    const r = await poe.setOff('02:00:00:00:00:fa', 6);
    expect(r.status).toBe(RESULT_STATUS.READ_FAILED);

    const puts = client.request.mock.calls.filter(([req]) => req.method === 'PUT');
    expect(puts).toHaveLength(0);
  });
});

describe('createPoEController — write_failed', () => {
  it('Test 22 — PUT throws → write_failed with error message', async () => {
    const client = {
      request: vi.fn(async ({ method }) => {
        if (method === 'GET') return structuredClone(mainFixture);
        if (method === 'PUT') throw new Error('500 Internal');
        return {};
      }),
      getStatus: () => ({ authState: 'connected' }),
    };
    const poe = createPoEController(client, { site: 'default', dryRun: false, logger: silentLogger });

    const r = await poe.setOff('02:00:00:00:00:fa', 6);
    expect(r.status).toBe(RESULT_STATUS.WRITE_FAILED);
    expect(typeof r.error).toBe('string');
    expect(r.error.length).toBeGreaterThan(0);
  });
});

describe('createPoEController — port_idx validation', () => {
  it('Test 23 — invalid port_idx (0, -1, "six") → unknown_port, ZERO HTTPS', async () => {
    const client = makeClient({ deviceFixture: structuredClone(mainFixture) });
    const poe = createPoEController(client, { site: 'default', dryRun: false, logger: silentLogger });

    const r1 = await poe.setOff('02:00:00:00:00:fa', 0);
    const r2 = await poe.setOff('02:00:00:00:00:fa', -1);
    const r3 = await poe.setOff('02:00:00:00:00:fa', 'six');

    expect(r1.status).toBe(RESULT_STATUS.UNKNOWN_PORT);
    expect(r2.status).toBe(RESULT_STATUS.UNKNOWN_PORT);
    expect(r3.status).toBe(RESULT_STATUS.UNKNOWN_PORT);
    expect(client.request.mock.calls).toHaveLength(0);
  });
});

describe('createPoEController — Phase 13 speedtest dispatch (D-P13-SPD-01)', () => {
  it('P13-Test 26 — speedtest(mac) POSTs /cmd/devmgr with cmd:"speedtest", mac', async () => {
    const client = makeClient({});
    const poe = createPoEController(client, { site: 'default', dryRun: false, logger: silentLogger });

    const result = await poe.speedtest('02:00:00:00:00:0e');
    expect(result.status).toBe('ok');
    expect(result.action).toBe('speedtest');

    const postCall = client.request.mock.calls.find(
      ([req]) => req.method === 'POST' && /\/cmd\/devmgr$/.test(req.path),
    );
    expect(postCall).toBeDefined();
    expect(postCall[0].body).toEqual({ cmd: 'speedtest', mac: '02:00:00:00:00:0e' });
  });

  it('P13-Test 27 — speedtest is rate-limited to 1 per 5 min per gateway (default)', async () => {
    const client = makeClient({});
    const poe = createPoEController(client, {
      site: 'default',
      dryRun: false,
      speedtestRateLimitMs: 5 * 60_000,
      logger: silentLogger,
    });

    const first = await poe.speedtest('02:00:00:00:00:0e');
    expect(first.status).toBe('ok');

    const second = await poe.speedtest('02:00:00:00:00:0e');
    expect(second.status).toBe('rate_limited');
    expect(second.retryAfterMs).toBeGreaterThan(0);

    // Other gateway is NOT rate-limited (per-gateway window).
    const otherMac = await poe.speedtest('aa:bb:cc:dd:ee:ff');
    expect(otherMac.status).toBe('ok');
  });

  it('P13-Test 28 — speedtest dryRun short-circuits (status:ok + dryRun:true, ZERO HTTPS)', async () => {
    const client = makeClient({});
    const poe = createPoEController(client, { site: 'default', dryRun: true, logger: silentLogger });

    const result = await poe.speedtest('02:00:00:00:00:0e');
    expect(result.status).toBe('ok');
    expect(result.dryRun).toBe(true);
    expect(client.request).not.toHaveBeenCalled();
  });

  it('P13-Test 29 — speedtest with authState !== "connected" → not_connected', async () => {
    const client = makeClient({ authState: 'disconnected' });
    const poe = createPoEController(client, { site: 'default', dryRun: false, logger: silentLogger });

    const result = await poe.speedtest('02:00:00:00:00:0e');
    expect(result.status).toBe('not_connected');
    expect(client.request).not.toHaveBeenCalled();
  });

  it('P13-Test 30 — speedtest POST throws → write_failed with error message', async () => {
    const client = makeClient({
      requestImpls: {
        'POST /proxy/network/api/s/default/cmd/devmgr': () => {
          throw new Error('controller 503');
        },
      },
    });
    const poe = createPoEController(client, { site: 'default', dryRun: false, logger: silentLogger });

    const result = await poe.speedtest('02:00:00:00:00:0e');
    expect(result.status).toBe('write_failed');
    expect(result.error).toContain('controller 503');
  });
});

describe('createPoEController — RESULT_STATUS export', () => {
  it('Test 25 — RESULT_STATUS is frozen and complete (D-RESULT-01)', () => {
    expect(Object.isFrozen(RESULT_STATUS)).toBe(true);
    expect(RESULT_STATUS.OK).toBe('ok');
    expect(RESULT_STATUS.PROTECTED_PORT).toBe('protected_port');
    expect(RESULT_STATUS.RATE_LIMITED).toBe('rate_limited');
    expect(RESULT_STATUS.READ_FAILED).toBe('read_failed');
    expect(RESULT_STATUS.WRITE_FAILED).toBe('write_failed');
    expect(RESULT_STATUS.INVALID_PAYLOAD).toBe('invalid_payload');
    expect(RESULT_STATUS.UNKNOWN_DEVICE).toBe('unknown_device');
    expect(RESULT_STATUS.UNKNOWN_PORT).toBe('unknown_port');
    expect(RESULT_STATUS.NOT_CONNECTED).toBe('not_connected');
    expect(RESULT_STATUS.NOT_POE_CAPABLE).toBe('not_poe_capable');

    // Freeze must reject mutation attempts.
    expect(() => {
      'use strict';
      RESULT_STATUS.OK = 'mutated';
    }).toThrow();
  });
});
