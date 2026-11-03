import { describe, it, expect, vi } from 'vitest';
import LoxonePlugin from '../plugins/loxone/plugin.js';
import { LoxoneStructure } from '../plugins/loxone/loxone-structure.js';

/** Calls the private refresh with a minimal fake `this` (no WS, no MQTT broker). */
function fake({ version, versionError, stored }) {
  const structure = {
    fetchVersion: versionError ? vi.fn().mockRejectedValue(new Error(versionError)) : vi.fn().mockResolvedValue(version),
    fetchStructure: vi.fn().mockResolvedValue({ lastModified: version || 'neu', controls: {} }),
    buildMap: vi.fn(),
    getAll: () => [],
    getMeta: () => null,
  };
  const self = {
    _ctx: { mqttService: {}, logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } },
    _structure: structure,
    _config: { ip: '1.2.3.4', port: 80, username: 'u', password: 'p' },
    _structureVersion: stored,
    _structureMonitor: { detectChanges: () => 0, snapshot: vi.fn() },
    _publishAfterStructureChange: vi.fn(),
  };
  return { self, structure };
}

const refresh = (self, opts) => LoxonePlugin.prototype._refreshStructure.call(self, opts);

describe('LoxonePlugin structure refresh is version-gated', () => {
  it('skips the full LoxAPP3.json download when the version is unchanged', async () => {
    const { self, structure } = fake({ version: '2026-10-24 16:34:03', stored: '2026-10-24 16:34:03' });
    await refresh(self);
    expect(structure.fetchVersion).toHaveBeenCalledTimes(1);
    expect(structure.fetchStructure).not.toHaveBeenCalled();
    expect(self._publishAfterStructureChange).not.toHaveBeenCalled();
  });

  it('downloads and stores the new version when it changed', async () => {
    const { self, structure } = fake({ version: '2026-10-25 09:00:00', stored: '2026-10-24 16:34:03' });
    await refresh(self);
    expect(structure.fetchStructure).toHaveBeenCalledTimes(1);
    expect(self._structureVersion).toBe('2026-10-25 09:00:00');
    // states that arrived before the new structure are published once
    expect(self._publishAfterStructureChange).toHaveBeenCalledTimes(1);
  });

  it('falls back to the full fetch when the version check fails', async () => {
    const { self, structure } = fake({ versionError: 'boom', stored: 'x' });
    await refresh(self);
    expect(structure.fetchStructure).toHaveBeenCalledTimes(1);
  });

  it('first periodic run after start compares against the version stored at connect', async () => {
    const { self, structure } = fake({ version: '2026-10-24 16:34:03', stored: null });
    await refresh(self);
    expect(structure.fetchStructure).toHaveBeenCalledTimes(1);
    expect(self._structureVersion).toBe('2026-10-24 16:34:03');
    await refresh(self);
    expect(structure.fetchStructure).toHaveBeenCalledTimes(1);
  });

  it('force skips the version check (manual refresh from the UI)', async () => {
    const { self, structure } = fake({ version: 'same', stored: 'same' });
    await refresh(self, { force: true });
    expect(structure.fetchVersion).not.toHaveBeenCalled();
    expect(structure.fetchStructure).toHaveBeenCalledTimes(1);
  });
});

describe('LoxoneStructure.fetchVersion', () => {
  const answer = (body, ok = true) => vi.fn().mockResolvedValue({
    ok, status: ok ? 200 : 401, statusText: ok ? 'OK' : 'Unauthorized', json: async () => body,
  });

  it('returns LL.value – same string format as LoxAPP3.json lastModified', async () => {
    // Checked against a live Miniserver on 24.10.2026: LL.value
    // and LoxAPP3.json lastModified were both '2026-10-24 16:34:03'.
    const fetchMock = answer({ LL: { control: 'dev/sps/LoxAPPversion3', value: '2026-10-24 16:34:03', Code: '200' } });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const v = await new LoxoneStructure().fetchVersion('1.2.3.4', 80, 'u', 'p');
      expect(v).toBe('2026-10-24 16:34:03');
      expect(fetchMock.mock.calls[0][0]).toBe('http://1.2.3.4:80/jdev/sps/LoxAPPversion3');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('throws on HTTP error and on a missing value (caller then does the full fetch)', async () => {
    vi.stubGlobal('fetch', answer({}, false));
    try {
      await expect(new LoxoneStructure().fetchVersion('h', 80, 'u', 'p')).rejects.toThrow(/401/);
      vi.stubGlobal('fetch', answer({ LL: { value: '' } }));
      await expect(new LoxoneStructure().fetchVersion('h', 80, 'u', 'p')).rejects.toThrow(/no version/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
