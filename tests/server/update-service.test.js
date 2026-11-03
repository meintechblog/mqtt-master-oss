/**
 * Auto-Apply ist abgeschaltet. Auch wenn in config.json
 * noch `update.autoApply: true` steht (oder der Schlüssel fehlt, früher
 * hieß das „an“), spielt der Dienst nie selbst ein Update ein.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { UpdateService } from '../../server/services/update-service.js';

vi.mock('../../server/services/version-service.js', () => ({
  getCurrentVersion: vi.fn(async () => ({ sha: 'aaaa', isDev: false, isDirty: false })),
  findInstallDir: vi.fn(() => null),
}));

function makeConfig(update) {
  const store = { update };
  return {
    get: (key, fallback) => (key in store ? store[key] : fallback),
    set: (key, value) => { store[key] = value; },
    save: vi.fn(async () => {}),
  };
}

const quietLogger = { info() {}, warn() {} };

describe('UpdateService auto-apply', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  for (const [label, update] of [
    ['autoApply true', { autoApply: true, latestSha: 'bbbb', autoUpdateHour: 3 }],
    ['autoApply missing (old default = on)', { latestSha: 'bbbb', autoUpdateHour: 3 }],
  ]) {
    it(`never runs an update by itself within 48 h (${label})`, async () => {
      vi.useFakeTimers();
      const svc = new UpdateService({ config: makeConfig(update), logger: quietLogger });
      vi.spyOn(svc, 'checkNow').mockResolvedValue({ ok: true });
      const runUpdate = vi.spyOn(svc, 'runUpdate').mockResolvedValue({ started: true });

      svc.start();
      await vi.advanceTimersByTimeAsync(48 * 60 * 60 * 1000);
      svc.stop();

      expect(runUpdate).not.toHaveBeenCalled();
    });

    it(`reports autoApply false in the status (${label})`, async () => {
      const svc = new UpdateService({ config: makeConfig(update), logger: quietLogger });
      const status = await svc.getStatus();
      expect(status.autoApply).toBe(false);
    });
  }

  it('still polls GitHub for new versions after start', async () => {
    vi.useFakeTimers();
    const svc = new UpdateService({ config: makeConfig({}), logger: quietLogger });
    const checkNow = vi.spyOn(svc, 'checkNow').mockResolvedValue({ ok: true });

    svc.start();
    await vi.advanceTimersByTimeAsync(60 * 1000);
    svc.stop();

    expect(checkNow).toHaveBeenCalled();
  });
});

/**
 * Die Update-Kachel zeigte einen veralteten Stand
 * (latestSha vom 02.06.) als verfügbar, weil jede spätere GitHub-Abfrage mit
 * 404 scheiterte (Repo privat) und der alte Wert stehen blieb.
 */
describe('UpdateService stale latest version', () => {
  const stale = {
    latestSha: 'bbbb', latestCommitDate: '2026-06-02T10:00:00Z',
    latestCommitMessage: 'old', lastCheckEtag: 'W/"old"',
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  for (const [label, fetchImpl] of [
    ['HTTP 404', async () => new Response('{"message":"Not Found"}', { status: 404 })],
    ['HTTP 500', async () => new Response('oops', { status: 500 })],
    ['network error', async () => { throw new Error('getaddrinfo ENOTFOUND'); }],
  ]) {
    it(`forgets the stored latest version when the check fails (${label})`, async () => {
      vi.stubGlobal('fetch', vi.fn(fetchImpl));
      const config = makeConfig({ ...stale });
      const svc = new UpdateService({ config, logger: quietLogger });

      const res = await svc.checkNow();
      const status = await svc.getStatus();

      expect(res.error).toBe('network');
      expect(status.hasUpdate).toBe(false);
      expect(status.latestSha).toBeNull();
      expect(status.latestCommitDate).toBeNull();
      expect(status.latestCommitMessage).toBeNull();
      expect(config.get('update').lastCheckEtag).toBeNull();
      expect(status.lastError).toMatch(/^network:/);
    });
  }

  it('forgets the stored latest version on 403 without rate-limit headers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"message":"Forbidden"}', { status: 403 })));
    const svc = new UpdateService({ config: makeConfig({ ...stale }), logger: quietLogger });

    const res = await svc.checkNow();
    const status = await svc.getStatus();

    expect(res.error).toBe('network');
    expect(status.latestSha).toBeNull();
    expect(status.hasUpdate).toBe(false);
  });

  it('forgets the stored latest version when the request times out after 10 s', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', vi.fn((_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      })));
      const svc = new UpdateService({ config: makeConfig({ ...stale }), logger: quietLogger });

      const pending = svc.checkNow();
      await vi.advanceTimersByTimeAsync(10_000);
      const res = await pending;
      const status = await svc.getStatus();

      expect(res).toEqual({ error: 'network', message: 'timeout' });
      expect(status.latestSha).toBeNull();
      expect(status.hasUpdate).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not bring an old version back after 200 → 404 → 304', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        sha: 'cccc', commit: { committer: { date: '2026-10-01T10:00:00Z' }, message: 'new' },
      }), { status: 200, headers: { etag: 'W/"new"' } }))
      .mockResolvedValueOnce(new Response('{"message":"Not Found"}', { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    vi.stubGlobal('fetch', fetchMock);
    const svc = new UpdateService({ config: makeConfig({}), logger: quietLogger });

    expect((await svc.checkNow()).latestSha).toBe('cccc');
    expect((await svc.checkNow()).error).toBe('network');
    const res = await svc.checkNow();
    const status = await svc.getStatus();

    expect(fetchMock.mock.calls[2][1].headers['If-None-Match']).toBeUndefined();
    expect(res.hasUpdate).toBe(false);
    expect(status.latestSha).toBeNull();
    expect(status.hasUpdate).toBe(false);
  });

  it('keeps the stored latest version on a rate limit (data is only delayed)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', {
      status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' },
    })));
    const svc = new UpdateService({ config: makeConfig({ ...stale }), logger: quietLogger });

    const res = await svc.checkNow();
    const status = await svc.getStatus();

    expect(res.error).toBe('rate_limited');
    expect(status.latestSha).toBe('bbbb');
  });
});
