import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { promises as fsp } from 'node:fs';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

// ── child_process spawn mock ───────────────────────────────────────
// Per-test mutable state. The `BridgeService` calls
// `spawn('systemctl', ['reload', 'mosquitto'])`. We return a fake child that
// emits `close` with the configured code and writes the configured stderr.
const spawnState = {
  calls: [],
  /** queue of { code, stderr } responses; popped per spawn */
  queue: [],
};

function pushSpawnResponse(code, stderr = '') {
  spawnState.queue.push({ code, stderr });
}

vi.mock('node:child_process', () => {
  return {
    spawn: vi.fn((cmd, args) => {
      spawnState.calls.push({ cmd, args });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      const resp = spawnState.queue.shift() || { code: 0, stderr: '' };
      // Defer emission so the caller has time to attach listeners — mirrors
      // real child_process behaviour and matches what BridgeService expects.
      setImmediate(() => {
        if (resp.stderr) child.stderr.emit('data', Buffer.from(resp.stderr, 'utf8'));
        child.emit('close', resp.code);
      });
      return child;
    }),
  };
});

import { BridgeService } from '../server/services/bridge-service.js';

// ── Fake ConfigService ─────────────────────────────────────────────
function createFakeConfig(initial = {}) {
  const data = JSON.parse(JSON.stringify(initial));
  const saveSpy = vi.fn(async () => {});
  return {
    _data: data,
    save: saveSpy,
    get(key, fallback) {
      const parts = key.split('.');
      let v = data;
      for (const p of parts) {
        if (v == null || typeof v !== 'object') return fallback;
        v = v[p];
      }
      return v !== undefined ? v : fallback;
    },
    set(key, value) {
      const parts = key.split('.');
      let v = data;
      for (let i = 0; i < parts.length - 1; i++) {
        if (v[parts[i]] == null || typeof v[parts[i]] !== 'object') v[parts[i]] = {};
        v = v[parts[i]];
      }
      v[parts[parts.length - 1]] = value;
    },
  };
}

// ── Fake MqttService ───────────────────────────────────────────────
function createFakeMqtt() {
  const m = new EventEmitter();
  m.subscribe = vi.fn();
  return m;
}

// ── Filesystem scratch dir per test ────────────────────────────────
let scratchDir;
let confPath;

beforeEach(async () => {
  scratchDir = `/tmp/mqtt-master-test/bridges-${randomBytes(6).toString('hex')}`;
  await mkdir(scratchDir, { recursive: true });
  confPath = join(scratchDir, 'mqtt-master-bridges.conf');
  spawnState.calls = [];
  spawnState.queue = [];
});

afterEach(async () => {
  await rm(scratchDir, { recursive: true, force: true });
});

// ── Canonical fixture ──────────────────────────────────────────────
function canonicalLegacy() {
  return {
    connectionName: 'from-legacy',
    remoteHost: '203.0.113.8',
    remotePort: 1883,
    topics: [{ pattern: '#', direction: 'in', qos: 0 }],
    enabled: true,
  };
}

// ── Test suites ────────────────────────────────────────────────────

describe('BridgeService — construction & $SYS subscription', () => {
  it('subscribes to $SYS/broker/connection/+/state at construction', () => {
    const mqtt = createFakeMqtt();
    const config = createFakeConfig({ bridges: { confPath } });
    // eslint-disable-next-line no-new
    new BridgeService({ config, mqttService: mqtt, logger: console });
    expect(mqtt.subscribe).toHaveBeenCalledWith('$SYS/broker/connection/+/state');
  });

  it('populates status map from incoming $SYS messages', () => {
    const mqtt = createFakeMqtt();
    const config = createFakeConfig({ bridges: { confPath } });
    const svc = new BridgeService({ config, mqttService: mqtt, logger: console });
    mqtt.emit('message', { topic: '$SYS/broker/connection/from-legacy/state', payload: '1', timestamp: Date.now() });
    mqtt.emit('message', { topic: '$SYS/broker/connection/other/state', payload: '0', timestamp: Date.now() });
    const status = svc.getStatus();
    expect(status['from-legacy']).toBe('connected');
    expect(status.other).toBe('disconnected');
  });

  it('ignores non-$SYS messages', () => {
    const mqtt = createFakeMqtt();
    const config = createFakeConfig({ bridges: { confPath } });
    const svc = new BridgeService({ config, mqttService: mqtt, logger: console });
    mqtt.emit('message', { topic: 'sensors/temp', payload: '22', timestamp: Date.now() });
    expect(Object.keys(svc.getStatus()).length).toBe(0);
  });
});

describe('BridgeService.listBridges / getBridge — password masking', () => {
  it('listBridges masks remotePassword to "***" in the list response', () => {
    const config = createFakeConfig({
      bridges: {
        confPath,
        list: [{
          id: 'authed',
          connectionName: 'authed',
          remoteHost: '198.51.100.5',
          remotePort: 1883,
          remoteUsername: 'alice',
          remotePassword: 'cleartext',
          topics: [{ pattern: '#', direction: 'in', qos: 0 }],
          enabled: true,
        }],
      },
    });
    const svc = new BridgeService({ config, mqttService: createFakeMqtt(), logger: console });
    const list = svc.listBridges();
    expect(list).toHaveLength(1);
    expect(list[0].remotePassword).toBe('***');
    expect(list[0].remoteUsername).toBe('alice');
  });

  function authedConfig() {
    return createFakeConfig({
      bridges: {
        confPath,
        list: [{
          id: 'authed',
          connectionName: 'authed',
          remoteHost: '198.51.100.5',
          remotePort: 1883,
          remoteUsername: 'alice',
          remotePassword: 'cleartext',
          topics: [{ pattern: '#', direction: 'in', qos: 0 }],
          enabled: true,
        }],
      },
    });
  }

  // GET is open to the whole LAN, so the
  // edit form gets the mask too and saving it back keeps the stored password.
  it('getBridge masks remotePassword as well', () => {
    const svc = new BridgeService({ config: authedConfig(), mqttService: createFakeMqtt(), logger: console });
    const b = svc.getBridge('authed');
    expect(b.remotePassword).toBe('***');
    expect(b.remoteUsername).toBe('alice');
  });

  it('upsertBridge keeps the stored password when the mask comes back', async () => {
    pushSpawnResponse(0, '');
    const config = authedConfig();
    const svc = new BridgeService({ config, mqttService: createFakeMqtt(), logger: console });
    const res = await svc.upsertBridge({ ...svc.getBridge('authed'), remotePort: 1884 });
    expect(res.ok).toBe(true);
    expect(config._data.bridges.list[0].remotePassword).toBe('cleartext');
    expect(config._data.bridges.list[0].remotePort).toBe(1884);
    expect(res.bridge.remotePassword).toBe('***');
    const written = await readFile(confPath, 'utf8');
    expect(written).toContain('remote_password cleartext');
  });

  it('upsertBridge replaces the password when a new one is sent', async () => {
    pushSpawnResponse(0, '');
    const config = authedConfig();
    const svc = new BridgeService({ config, mqttService: createFakeMqtt(), logger: console });
    const res = await svc.upsertBridge({ ...svc.getBridge('authed'), remotePassword: 'neu' });
    expect(res.ok).toBe(true);
    expect(config._data.bridges.list[0].remotePassword).toBe('neu');
  });

  // a non-string password slipped past the string-only mask.
  for (const bad of [['geheim'], { p: 'geheim' }, 42, true]) {
    it(`upsertBridge refuses a non-string remotePassword (${JSON.stringify(bad)})`, async () => {
      const config = createFakeConfig({ bridges: { confPath, list: [] } });
      const svc = new BridgeService({ config, mqttService: createFakeMqtt(), logger: console });
      const res = await svc.upsertBridge({ ...canonicalLegacy(), remoteUsername: 'alice', remotePassword: bad });
      expect(res.ok).toBe(false);
      expect(JSON.stringify(res)).not.toContain('geheim');
      expect(spawnState.calls).toHaveLength(0);
    });
  }

  it('upsertBridge refuses a non-string remoteUsername', async () => {
    const config = createFakeConfig({ bridges: { confPath, list: [] } });
    const svc = new BridgeService({ config, mqttService: createFakeMqtt(), logger: console });
    const res = await svc.upsertBridge({ ...canonicalLegacy(), remoteUsername: ['alice'] });
    expect(res.ok).toBe(false);
  });

  it('masks a stored non-string password from older config as well', () => {
    const config = createFakeConfig({
      bridges: { confPath, list: [{ ...canonicalLegacy(), id: 'alt', remotePassword: ['geheim'] }] },
    });
    const svc = new BridgeService({ config, mqttService: createFakeMqtt(), logger: console });
    expect(svc.getBridge('alt').remotePassword).toBe('***');
    expect(svc.listBridges()[0].remotePassword).toBe('***');
  });

  it('upsertBridge refuses the mask on a new bridge', async () => {
    const config = createFakeConfig({ bridges: { confPath, list: [] } });
    const svc = new BridgeService({ config, mqttService: createFakeMqtt(), logger: console });
    const res = await svc.upsertBridge({ ...canonicalLegacy(), remoteUsername: 'bob', remotePassword: '***' });
    expect(res.ok).toBe(false);
    expect(spawnState.calls).toHaveLength(0);
  });
});

describe('BridgeService.upsertBridge — happy path', () => {
  it('writes the .conf atomically, reloads mosquitto, and persists the array', async () => {
    pushSpawnResponse(0, ''); // systemctl reload OK
    const config = createFakeConfig({ bridges: { confPath, list: [] } });
    const svc = new BridgeService({ config, mqttService: createFakeMqtt(), logger: console });

    const res = await svc.upsertBridge(canonicalLegacy());

    expect(res.ok).toBe(true);
    expect(res.bridge.connectionName).toBe('from-legacy');
    // .conf was written
    expect(existsSync(confPath)).toBe(true);
    const written = await readFile(confPath, 'utf8');
    expect(written).toContain('connection from-legacy');
    expect(written).toContain('address 203.0.113.8:1883');
    expect(written).toContain('topic # in 0 "" ""');
    // systemctl invocation
    expect(spawnState.calls).toHaveLength(1);
    expect(spawnState.calls[0].cmd).toBe('systemctl');
    expect(spawnState.calls[0].args).toEqual(['reload', 'mosquitto']);
    // Config persisted
    expect(config.save).toHaveBeenCalledOnce();
    expect(config._data.bridges.list).toHaveLength(1);
    expect(config._data.bridges.list[0].id).toBe('from-legacy');
  });

  it('assigns id = connectionName if missing', async () => {
    pushSpawnResponse(0, '');
    const config = createFakeConfig({ bridges: { confPath, list: [] } });
    const svc = new BridgeService({ config, mqttService: createFakeMqtt(), logger: console });
    const b = canonicalLegacy();
    delete b.id;
    const res = await svc.upsertBridge(b);
    expect(res.ok).toBe(true);
    expect(res.bridge.id).toBe('from-legacy');
  });

  it('sets file mode 0600 after a successful write (T-3sd-04 mitigation)', async () => {
    pushSpawnResponse(0, '');
    const config = createFakeConfig({ bridges: { confPath, list: [] } });
    const svc = new BridgeService({ config, mqttService: createFakeMqtt(), logger: console });
    await svc.upsertBridge(canonicalLegacy());
    const { mode } = await fsp.stat(confPath);
    // Lower 9 bits are the permission triple; mask everything else off.
    expect(mode & 0o777).toBe(0o600);
  });

  it('updates an existing bridge in place (same id)', async () => {
    const config = createFakeConfig({
      bridges: {
        confPath,
        list: [{ ...canonicalLegacy(), id: 'from-legacy' }],
      },
    });
    pushSpawnResponse(0, '');
    const svc = new BridgeService({ config, mqttService: createFakeMqtt(), logger: console });
    const upd = { ...canonicalLegacy(), id: 'from-legacy', remotePort: 1884 };
    const res = await svc.upsertBridge(upd);
    expect(res.ok).toBe(true);
    expect(config._data.bridges.list).toHaveLength(1);
    expect(config._data.bridges.list[0].remotePort).toBe(1884);
  });
});

describe('BridgeService.upsertBridge — reload failure rollback', () => {
  it('restores the previous .conf byte-for-byte AND skips config.save() on reload failure', async () => {
    // Seed the disk with a previous "good" conf.
    const previousConf = '# previous good conf\nconnection prior\naddress 198.51.100.99:1883\n';
    await writeFile(confPath, previousConf, 'utf8');

    // First reload (post-write) fails; rollback re-write triggers a second
    // reload which we let succeed so the test can observe restoration.
    pushSpawnResponse(1, 'mosquitto: parse error');
    pushSpawnResponse(0, '');

    const config = createFakeConfig({
      bridges: {
        confPath,
        list: [{ ...canonicalLegacy(), id: 'from-legacy' }],
      },
    });
    const svc = new BridgeService({ config, mqttService: createFakeMqtt(), logger: console });

    const newBridge = { ...canonicalLegacy(), id: 'from-legacy', remotePort: 9999 };
    const res = await svc.upsertBridge(newBridge);

    expect(res.ok).toBe(false);
    expect(res.error).toBe('reload_failed');
    expect(res.stderr).toContain('mosquitto: parse error');

    // .conf must be byte-identical to the pre-write state.
    const after = await readFile(confPath, 'utf8');
    expect(after).toBe(previousConf);

    // config.save() must NOT have been called.
    expect(config.save).not.toHaveBeenCalled();

    // systemctl was called exactly twice (failed reload + rollback reload).
    expect(spawnState.calls).toHaveLength(2);
  });

  it('handles the "no previous conf existed" case on rollback (deletes the new file)', async () => {
    // No previous conf on disk.
    expect(existsSync(confPath)).toBe(false);

    pushSpawnResponse(1, 'parse error'); // failing reload
    pushSpawnResponse(0, '');             // post-rollback reload

    const config = createFakeConfig({ bridges: { confPath, list: [] } });
    const svc = new BridgeService({ config, mqttService: createFakeMqtt(), logger: console });

    const res = await svc.upsertBridge(canonicalLegacy());
    expect(res.ok).toBe(false);
    expect(res.error).toBe('reload_failed');
    // .conf must no longer exist after rollback.
    expect(existsSync(confPath)).toBe(false);
    expect(config.save).not.toHaveBeenCalled();
  });
});

describe('BridgeService.upsertBridge — validation', () => {
  async function expectValidationFailure(bridge, errorMatcher) {
    const config = createFakeConfig({ bridges: { confPath, list: [] } });
    const svc = new BridgeService({ config, mqttService: createFakeMqtt(), logger: console });
    const res = await svc.upsertBridge(bridge);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(errorMatcher);
    // No disk write, no systemctl, no save.
    expect(existsSync(confPath)).toBe(false);
    expect(spawnState.calls).toHaveLength(0);
    expect(config.save).not.toHaveBeenCalled();
  }

  it('rejects empty connectionName', async () => {
    await expectValidationFailure({ ...canonicalLegacy(), connectionName: '' }, /connection name/i);
  });
  it('rejects connectionName with a space', async () => {
    await expectValidationFailure({ ...canonicalLegacy(), connectionName: 'my bridge' }, /connection name/i);
  });
  it('rejects connectionName longer than 64 chars', async () => {
    await expectValidationFailure({ ...canonicalLegacy(), connectionName: 'a'.repeat(65) }, /connection name/i);
  });
  it('rejects missing remoteHost', async () => {
    const b = canonicalLegacy();
    delete b.remoteHost;
    await expectValidationFailure(b, /remoteHost/i);
  });
  it('rejects remotePort outside 1..65535', async () => {
    await expectValidationFailure({ ...canonicalLegacy(), remotePort: 0 }, /remotePort/i);
    await expectValidationFailure({ ...canonicalLegacy(), remotePort: 70000 }, /remotePort/i);
  });
  it('rejects topic with direction=sideways', async () => {
    await expectValidationFailure(
      { ...canonicalLegacy(), topics: [{ pattern: '#', direction: 'sideways', qos: 0 }] },
      /direction/i,
    );
  });
  it('rejects topic with qos=3', async () => {
    await expectValidationFailure(
      { ...canonicalLegacy(), topics: [{ pattern: '#', direction: 'in', qos: 3 }] },
      /qos/i,
    );
  });
});

describe('BridgeService.upsertBridge — duplicate names', () => {
  it('rejects a duplicate connectionName when not editing in place', async () => {
    const existing = { ...canonicalLegacy(), id: 'from-legacy' };
    const config = createFakeConfig({ bridges: { confPath, list: [existing] } });
    const svc = new BridgeService({ config, mqttService: createFakeMqtt(), logger: console });

    // A second bridge with the same connectionName but no `id` (new bridge).
    const dup = { ...canonicalLegacy() };
    const res = await svc.upsertBridge(dup);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/duplicate|already exists/i);
    expect(spawnState.calls).toHaveLength(0);
    expect(config.save).not.toHaveBeenCalled();
  });
});

describe('BridgeService.deleteBridge', () => {
  it('removes the bridge, regenerates the .conf, reloads, persists', async () => {
    pushSpawnResponse(0, '');
    const config = createFakeConfig({
      bridges: {
        confPath,
        list: [{ ...canonicalLegacy(), id: 'from-legacy' }],
      },
    });
    const svc = new BridgeService({ config, mqttService: createFakeMqtt(), logger: console });
    const res = await svc.deleteBridge('from-legacy');
    expect(res.ok).toBe(true);
    expect(config._data.bridges.list).toHaveLength(0);
    expect(config.save).toHaveBeenCalledOnce();
    // .conf should exist but no longer contain the bridge.
    const after = await readFile(confPath, 'utf8');
    expect(after).not.toContain('connection from-legacy');
  });

  it('prunes the deleted bridge from the $SYS status map (no phantom in getStatus)', async () => {
    pushSpawnResponse(0, '');
    const mqtt = createFakeMqtt();
    const config = createFakeConfig({
      bridges: {
        confPath,
        list: [{ ...canonicalLegacy(), id: 'from-legacy' }],
      },
    });
    const svc = new BridgeService({ config, mqttService: mqtt, logger: console });
    // mosquitto reports the bridge connected, populating the status map.
    mqtt.emit('message', { topic: '$SYS/broker/connection/from-legacy/state', payload: '1', timestamp: Date.now() });
    expect(svc.getStatus()['from-legacy']).toBe('connected');

    const res = await svc.deleteBridge('from-legacy');
    expect(res.ok).toBe(true);
    // The stale $SYS entry must not linger as a phantom connection.
    expect(svc.getStatus()['from-legacy']).toBeUndefined();
  });

  it('returns ok:false when the bridge does not exist', async () => {
    const config = createFakeConfig({ bridges: { confPath, list: [] } });
    const svc = new BridgeService({ config, mqttService: createFakeMqtt(), logger: console });
    const res = await svc.deleteBridge('nonexistent');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not.*found|not_found/i);
    expect(spawnState.calls).toHaveLength(0);
  });

  it('rolls back on reload failure (same semantics as upsert)', async () => {
    const previousConf = '# previous good conf\nconnection prior\n';
    await writeFile(confPath, previousConf, 'utf8');
    pushSpawnResponse(1, 'parse error');
    pushSpawnResponse(0, '');

    const config = createFakeConfig({
      bridges: {
        confPath,
        list: [{ ...canonicalLegacy(), id: 'from-legacy' }],
      },
    });
    const svc = new BridgeService({ config, mqttService: createFakeMqtt(), logger: console });
    const res = await svc.deleteBridge('from-legacy');
    expect(res.ok).toBe(false);
    expect(res.error).toBe('reload_failed');
    // Restored byte-for-byte.
    expect(await readFile(confPath, 'utf8')).toBe(previousConf);
    // Bridge was NOT removed from config in memory either.
    expect(config._data.bridges.list).toHaveLength(1);
    expect(config.save).not.toHaveBeenCalled();
  });
});

describe('BridgeService.applyNow', () => {
  it('regenerates+reloads without changing the array', async () => {
    pushSpawnResponse(0, '');
    const config = createFakeConfig({
      bridges: { confPath, list: [{ ...canonicalLegacy(), id: 'from-legacy' }] },
    });
    const svc = new BridgeService({ config, mqttService: createFakeMqtt(), logger: console });
    const res = await svc.applyNow();
    expect(res.ok).toBe(true);
    // No new bridge state, so save is NOT called (config was already accurate).
    expect(config.save).not.toHaveBeenCalled();
    expect(existsSync(confPath)).toBe(true);
  });
});

describe('BridgeService.getStatus — unknown bridges', () => {
  it('returns "unknown" for bridges that exist in config but have no $SYS state yet', () => {
    const config = createFakeConfig({
      bridges: { confPath, list: [{ ...canonicalLegacy(), id: 'from-legacy' }] },
    });
    const svc = new BridgeService({ config, mqttService: createFakeMqtt(), logger: console });
    const status = svc.getStatus();
    expect(status['from-legacy']).toBe('unknown');
  });
});
