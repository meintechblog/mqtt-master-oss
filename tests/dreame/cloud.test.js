import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { DreameCloud, DreameCloudError } from '../../plugins/dreame/dreame-cloud.js';

const PW = 'geheim-passwort-123';
const SALT = 'RAylYC%fmSKp7%Tq'; // decoded DREAME_STRINGS[2]
const CID = 'EETjszu*XI5znHsI'; // decoded DREAME_STRINGS[55]
const md5 = (s) => createHash('md5').update(s).digest('hex');
const PW_MD5 = md5(PW + SALT);

const TOKEN_RESPONSE = (over = {}) => ({
  access_token: 'AT-secret-1',
  refresh_token: 'RT-secret-1',
  expires_in: 3600,
  uid: 'uid-4711',
  region: 'eu',
  lang: 'de',
  country: 'DE',
  tenant_id: '000000',
  ...over,
});

const RECORD = {
  did: '1234567',
  model: 'dreame.vacuum.r2449a',
  customName: 'Sauger EG',
  masterUid: 'uid-4711',
  bindDomain: '10000.mt.eu.iot.dreame.tech:19973',
  latestStatus: 6,
  battery: 88,
  mac: 'aa:bb:cc:dd:ee:ff',
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** fetch mock: route by URL path; each route is a function(init) -> Response */
function makeFetch(routes) {
  const calls = [];
  const fn = vi.fn(async (url, init) => {
    const u = new URL(url);
    calls.push({ url: String(url), path: u.pathname, init });
    const route = routes[u.pathname];
    if (!route) throw new Error(`unexpected path ${u.pathname}`);
    return route(init, calls);
  });
  fn.calls = calls;
  return fn;
}

const silentLogger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

function newCloud(fetchFn, over = {}) {
  let t = 1_000_000_000_000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const cloud = new DreameCloud({
    username: 'me@example.org',
    password: PW,
    country: 'eu',
    fetch: fetchFn,
    logger: silentLogger(),
    now: clock.now,
    sleep: async () => {},
    ...over,
  });
  return { cloud, clock };
}

describe('DreameCloud login', () => {
  it('logs in with the MD5 password hash and never sends the plain password', async () => {
    const f = makeFetch({ '/dreame-auth/oauth/token': () => jsonResponse(TOKEN_RESPONSE()) });
    const onRefreshToken = vi.fn();
    const { cloud } = newCloud(f, { onRefreshToken });
    expect(await cloud.login()).toBe(true);
    expect(cloud.isLoggedIn()).toBe(true);
    const { url, init } = f.calls[0];
    expect(url).toBe('https://eu.iot.dreame.tech:13267/dreame-auth/oauth/token');
    expect(init.method).toBe('POST');
    expect(init.body).toContain('grant_type=password');
    expect(init.body).toContain('username=me%40example.org');
    expect(init.body).toContain(`password=${PW_MD5}`);
    expect(init.body).not.toContain(PW);
    expect(init.headers['authorization']).toBe('Basic ZHJlYW1lX2FwcHYxOkFQXmR2QHpAU1FZVnhOODg=');
    expect(init.headers['tenant-id']).toBe('000000');
    expect(init.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(onRefreshToken).toHaveBeenCalledWith('RT-secret-1');
  });

  it('prefers the refresh key over the password', async () => {
    const f = makeFetch({ '/dreame-auth/oauth/token': () => jsonResponse(TOKEN_RESPONSE()) });
    const { cloud } = newCloud(f, { refreshToken: 'RT-stored' });
    expect(await cloud.login()).toBe(true);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].init.body).toBe(
      'grant_type=refresh_token&scope=all&platform=ANDROID&type=account&refresh_token=RT-stored',
    );
    expect(f.calls[0].init.body).not.toContain('password');
  });

  it('falls back to the password when the refresh key is rejected', async () => {
    let n = 0;
    const f = makeFetch({
      '/dreame-auth/oauth/token': () => (++n === 1
        ? jsonResponse({ error_description: 'Invalid refresh token' }, 400)
        : jsonResponse(TOKEN_RESPONSE())),
    });
    const { cloud } = newCloud(f, { refreshToken: 'RT-stale' });
    expect(await cloud.login()).toBe(true);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1].init.body).toContain('grant_type=password');
  });

  it('returns false and reports a sanitized error when credentials are refused', async () => {
    const f = makeFetch({
      '/dreame-auth/oauth/token': () => jsonResponse({ error_description: `bad user me@example.org pw ${PW_MD5}` }, 401),
    });
    const logger = silentLogger();
    const { cloud } = newCloud(f, { logger });
    expect(await cloud.login()).toBe(false);
    expect(cloud.isLoggedIn()).toBe(false);
    expect(cloud.authFailed).toBe(true);
    const logged = JSON.stringify([logger.warn.mock.calls, logger.error.mock.calls]);
    expect(logged).not.toContain(PW_MD5);
    expect(logged).not.toContain('me@example.org');
  });

  it('refreshes the token shortly before it expires, before the next API call', async () => {
    const f = makeFetch({
      '/dreame-auth/oauth/token': () => jsonResponse(TOKEN_RESPONSE()),
      '/dreame-user-iot/iotuserbind/device/listV2': () => jsonResponse({ code: 0, data: { page: { records: [] } } }),
    });
    const { cloud, clock } = newCloud(f);
    await cloud.login();
    clock.advance((3600 - 300) * 1000); // 300 s left, below the 600 s threshold
    await cloud.listDevices();
    const grants = f.calls.filter((c) => c.path.endsWith('/oauth/token')).map((c) => c.init.body);
    expect(grants).toHaveLength(2);
    expect(grants[1]).toContain('grant_type=refresh_token');
    expect(grants[1]).toContain('refresh_token=RT-secret-1');
  });

  it('does not refresh while the token is still fresh', async () => {
    const f = makeFetch({
      '/dreame-auth/oauth/token': () => jsonResponse(TOKEN_RESPONSE()),
      '/dreame-user-iot/iotuserbind/device/listV2': () => jsonResponse({ code: 0, data: { page: { records: [] } } }),
    });
    const { cloud, clock } = newCloud(f);
    await cloud.login();
    clock.advance(60 * 1000);
    await cloud.listDevices();
    expect(f.calls.filter((c) => c.path.endsWith('/oauth/token'))).toHaveLength(1);
  });
});

describe('DreameCloud API calls', () => {
  function loggedInCloud(extraRoutes = {}) {
    const f = makeFetch({
      '/dreame-auth/oauth/token': () => jsonResponse(TOKEN_RESPONSE()),
      '/dreame-user-iot/iotuserbind/device/listV2': () => jsonResponse({ code: 0, data: { page: { records: [RECORD] } } }),
      ...extraRoutes,
    });
    const made = newCloud(f);
    return { f, ...made };
  }

  it('lists devices with the bearer token and a signed body, normalised', async () => {
    const { f, cloud } = loggedInCloud();
    await cloud.login();
    const devices = await cloud.listDevices();
    expect(devices).toEqual([expect.objectContaining({
      did: '1234567', model: 'dreame.vacuum.r2449a', name: 'Sauger EG',
      latestStatus: 6, battery: 88,
    })]);
    const call = f.calls.find((c) => c.path.endsWith('/listV2'));
    expect(call.init.headers['dreame-auth']).toBe('bearer AT-secret-1');
    const body = JSON.parse(call.init.body);
    expect(typeof body.sign).toBe('string');
    expect(typeof body.timestamp).toBe('number');
  });

  it('sends get_properties as an RPC with did/siid/piid triples', async () => {
    const { f, cloud } = loggedInCloud({
      '/dreame-iot-com-10000/device/sendCommand': () => jsonResponse({
        code: 0,
        data: { result: [
          { did: '1234567', siid: 2, piid: 1, code: 0, value: 6 },
          { did: '1234567', siid: 2, piid: 2, code: 0, value: 0 },
          { did: '1234567', siid: 3, piid: 1, code: 0, value: 88 },
        ] },
      }),
    });
    await cloud.login();
    const [dev] = await cloud.listDevices();
    const res = await cloud.getProperties(dev, [
      { siid: 2, piid: 1 }, { siid: 2, piid: 2 }, { siid: 3, piid: 1 },
    ]);
    expect(res).toEqual({ reachable: true, values: { '2.1': 6, '2.2': 0, '3.1': 88 } });
    const call = f.calls.find((c) => c.path.endsWith('/sendCommand'));
    expect(call.url).toBe('https://eu.iot.dreame.tech:13267/dreame-iot-com-10000/device/sendCommand');
    const body = JSON.parse(call.init.body);
    expect(body.did).toBe('1234567');
    expect(typeof body.id).toBe('number');
    expect(body.data).toEqual({
      did: '1234567',
      id: body.id,
      method: 'get_properties',
      params: [
        { did: '1234567', siid: 2, piid: 1 },
        { did: '1234567', siid: 2, piid: 2 },
        { did: '1234567', siid: 3, piid: 1 },
      ],
    });
  });

  it('sends actions as RPC action with siid/aiid and an empty in list', async () => {
    const { f, cloud } = loggedInCloud({
      '/dreame-iot-com-10000/device/sendCommand': () => jsonResponse({ code: 0, data: { result: { code: 0, out: [] } } }),
    });
    await cloud.login();
    const [dev] = await cloud.listDevices();
    expect(await cloud.action(dev, 2, 1)).toEqual({ ok: true });
    const body = JSON.parse(f.calls.find((c) => c.path.endsWith('/sendCommand')).init.body);
    expect(body.data.method).toBe('action');
    expect(body.data.params).toEqual({ did: '1234567', siid: 2, aiid: 1, in: [] });
  });

  it('reports ok=false for an action the device rejects', async () => {
    const { cloud } = loggedInCloud({
      '/dreame-iot-com-10000/device/sendCommand': () => jsonResponse({ code: 0, data: { result: { code: -1 } } }),
    });
    await cloud.login();
    const [dev] = await cloud.listDevices();
    expect((await cloud.action(dev, 4, 2)).ok).toBe(false);
  });

  it('reports a device timeout (80001) as unreachable, not as an exception', async () => {
    const { cloud } = loggedInCloud({
      '/dreame-iot-com-10000/device/sendCommand': () => jsonResponse({ code: 80001, msg: 'device may be offline' }),
    });
    await cloud.login();
    const [dev] = await cloud.listDevices();
    expect(await cloud.getProperties(dev, [{ siid: 2, piid: 1 }])).toEqual({ reachable: false, values: {} });
  });

  it('computes the request signature like the original (sorted splice + ms + key)', async () => {
    const { f, cloud } = loggedInCloud({
      '/dreame-iot-com-10000/device/sendCommand': () => jsonResponse({ code: 0, data: { result: [{ siid: 2, piid: 1, code: 0, value: 1 }] } }),
    });
    await cloud.login();
    const [dev] = await cloud.listDevices();
    await cloud.getProperties(dev, [{ siid: 2, piid: 1 }]);
    const body = JSON.parse(f.calls.find((c) => c.path.endsWith('/sendCommand')).init.body);
    // nested dict values are JSON-encoded, lists inside nested dicts are skipped
    const spliced = `data=[did="1234567"&id=${body.id}&method="get_properties"]&did=1234567&id=${body.id}`;
    expect(body.sign).toBe(md5(`${spliced}${body.timestamp}${CID}`));
  });

  it('retries once with a fresh login when the API answers 401 with an expired session', async () => {
    let n = 0;
    const { f, cloud } = loggedInCloud({
      '/dreame-iot-com-10000/device/sendCommand': () => (++n === 1
        ? jsonResponse({ code: 401, msg: 'expired' }, 401)
        : jsonResponse({ code: 0, data: { result: { code: 0 } } })),
    });
    await cloud.login();
    const [dev] = await cloud.listDevices();
    expect((await cloud.action(dev, 2, 2)).ok).toBe(true);
    expect(f.calls.filter((c) => c.path.endsWith('/sendCommand'))).toHaveLength(2);
    expect(f.calls.filter((c) => c.path.endsWith('/oauth/token')).length).toBeGreaterThanOrEqual(2);
  });

  it('throws a sanitized error without response bodies, headers or secrets', async () => {
    const { cloud } = loggedInCloud({
      '/dreame-iot-com-10000/device/sendCommand': () => new Response(
        `internal error token AT-secret-1 did 1234567 pw ${PW}`, { status: 500 },
      ),
    });
    await cloud.login();
    const [dev] = await cloud.listDevices();
    const err = await cloud.action(dev, 2, 1).catch((e) => e);
    expect(err).toBeInstanceOf(DreameCloudError);
    for (const secret of ['AT-secret-1', '1234567', PW, 'RT-secret-1']) {
      expect(err.message).not.toContain(secret);
    }
    expect(err.message).toMatch(/500/);
  });

  it('sanitizes network errors that embed secrets', async () => {
    let first = true;
    const f = vi.fn(async (url) => {
      if (String(url).endsWith('/oauth/token')) return jsonResponse(TOKEN_RESPONSE());
      if (String(url).endsWith('/listV2')) return jsonResponse({ code: 0, data: { page: { records: [RECORD] } } });
      first = false;
      throw new Error('connect ECONNRESET with bearer AT-secret-1 for 1234567');
    });
    const { cloud } = newCloud(f, { retries: 0 });
    await cloud.login();
    const [dev] = await cloud.listDevices();
    const err = await cloud.action(dev, 2, 1).catch((e) => e);
    expect(first).toBe(false);
    expect(err).toBeInstanceOf(DreameCloudError);
    expect(err.message).not.toContain('AT-secret-1');
    expect(err.message).not.toContain('1234567');
  });

  // an array result with a failed entry is a failure.
  it('reports ok=false when the action result is an array with a failed entry', async () => {
    const { cloud } = loggedInCloud({
      '/dreame-iot-com-10000/device/sendCommand': () => jsonResponse({ code: 0, data: { result: [{ code: -1 }] } }),
    });
    await cloud.login();
    const [dev] = await cloud.listDevices();
    expect((await cloud.action(dev, 4, 2)).ok).toBe(false);
  });

  it('reports ok=false for an empty array result (fail closed)', async () => {
    const { cloud } = loggedInCloud({
      '/dreame-iot-com-10000/device/sendCommand': () => jsonResponse({ code: 0, data: { result: [] } }),
    });
    await cloud.login();
    const [dev] = await cloud.listDevices();
    expect((await cloud.action(dev, 4, 2)).ok).toBe(false);
  });

  // an envelope with only failed property entries is not a measurement.
  it('throws when no requested property came back', async () => {
    const { cloud } = loggedInCloud({
      '/dreame-iot-com-10000/device/sendCommand': () => jsonResponse({ code: 0, data: { result: [{ siid: 2, piid: 1, code: -4001 }] } }),
    });
    await cloud.login();
    const [dev] = await cloud.listDevices();
    await expect(cloud.getProperties(dev, [{ siid: 2, piid: 1 }])).rejects.toBeInstanceOf(DreameCloudError);
  });

  // a non-numeric code from the server never reaches the message.
  it('never puts a non-numeric API code into an error message', async () => {
    const { cloud } = loggedInCloud({
      '/dreame-iot-com-10000/device/sendCommand': () => jsonResponse({ code: 'device SN-98765 rejected' }),
      '/dreame-user-iot/iotuserbind/device/listV2': () => jsonResponse({ code: 'uid X-55555 blocked' }),
    });
    await cloud.login();
    const e1 = await cloud.listDevices().catch((e) => e);
    expect(e1).toBeInstanceOf(DreameCloudError);
    expect(e1.message).not.toContain('X-55555');
    expect(e1.code).toBeUndefined();
  });

  it('never puts a non-numeric API code into a property error', async () => {
    const { cloud } = loggedInCloud({
      '/dreame-iot-com-10000/device/sendCommand': () => jsonResponse({ code: 'device SN-98765 rejected' }),
    });
    await cloud.login();
    const [dev] = await cloud.listDevices();
    const err = await cloud.getProperties(dev, [{ siid: 2, piid: 1 }]).catch((e) => e);
    expect(err.message).not.toContain('SN-98765');
    expect(JSON.stringify(await cloud.action(dev, 2, 1))).not.toContain('SN-98765');
  });

  // a 401 followed by a temporarily failing login is not a credential refusal.
  for (const failure of [503, 429, 'network']) {
    it(`401 then login ${failure}: authFailed stays false`, async () => {
      let tokenCalls = 0;
      const { cloud } = loggedInCloud({
        '/dreame-auth/oauth/token': () => {
          tokenCalls += 1;
          if (tokenCalls === 1) return jsonResponse(TOKEN_RESPONSE());
          if (failure === 'network') throw new Error('ECONNRESET');
          return new Response('busy', { status: failure });
        },
        '/dreame-iot-com-10000/device/sendCommand': () => jsonResponse({ code: 401 }, 401),
      });
      await cloud.login();
      const [dev] = await cloud.listDevices();
      await expect(cloud.action(dev, 2, 1)).rejects.toBeInstanceOf(DreameCloudError);
      expect(cloud.authFailed).toBe(false);
      expect(cloud.isLoggedIn()).toBe(false);
    });
  }

  it('401 then login refused (401): authFailed is set', async () => {
    let tokenCalls = 0;
    const { cloud } = loggedInCloud({
      '/dreame-auth/oauth/token': () => (++tokenCalls === 1 ? jsonResponse(TOKEN_RESPONSE()) : new Response('no', { status: 401 })),
      '/dreame-iot-com-10000/device/sendCommand': () => jsonResponse({ code: 401 }, 401),
    });
    await cloud.login();
    const [dev] = await cloud.listDevices();
    await expect(cloud.action(dev, 2, 1)).rejects.toBeInstanceOf(DreameCloudError);
    expect(cloud.authFailed).toBe(true);
  });

  // an action envelope without a valid confirmation is no success.
  for (const [label, data] of [
    ['data without result', {}],
    ['result is no array/object', { result: 'ok' }],
    ['empty result array', { result: [] }],
    ['array entry with code != 0', { result: [{ code: 0 }, { code: -1 }] }],
    ['array entry without code', { result: [{ out: [] }] }],
  ]) {
    it(`action reports ok=false for ${label}`, async () => {
      const { cloud } = loggedInCloud({
        '/dreame-iot-com-10000/device/sendCommand': () => jsonResponse({ code: 0, data }),
      });
      await cloud.login();
      const [dev] = await cloud.listDevices();
      expect((await cloud.action(dev, 4, 2)).ok).toBe(false);
    });
  }

  it('action reports ok=true for a non-empty array where every entry has code 0', async () => {
    const { cloud } = loggedInCloud({
      '/dreame-iot-com-10000/device/sendCommand': () => jsonResponse({ code: 0, data: { result: [{ code: 0 }, { code: 0, out: [] }] } }),
    });
    await cloud.login();
    const [dev] = await cloud.listDevices();
    expect((await cloud.action(dev, 4, 2)).ok).toBe(true);
  });

  // a 401 that is not "expired" renews the session once instead of locking the client.
  it('API 401 with a foreign code renews the token once and repeats a query', async () => {
    let n = 0;
    let tokenCalls = 0;
    const { f, cloud } = loggedInCloud({
      '/dreame-auth/oauth/token': () => { tokenCalls += 1; return jsonResponse(TOKEN_RESPONSE()); },
      '/dreame-user-iot/iotuserbind/device/listV2': () => (++n === 1
        ? jsonResponse({ code: 403 }, 401)
        : jsonResponse({ code: 0, data: { page: { records: [RECORD] } } })),
    });
    await cloud.login();
    const devs = await cloud.listDevices();
    expect(devs).toHaveLength(1);
    expect(cloud.authFailed).toBe(false);
    expect(cloud.isLoggedIn()).toBe(true);
    expect(tokenCalls).toBe(2);
    expect(f.calls.filter((c) => c.path.endsWith('/listV2'))).toHaveLength(2);
  });

  it('API 401 with a foreign code renews the token for an action but never repeats it', async () => {
    let tokenCalls = 0;
    const { f, cloud } = loggedInCloud({
      '/dreame-auth/oauth/token': () => { tokenCalls += 1; return jsonResponse(TOKEN_RESPONSE()); },
      '/dreame-iot-com-10000/device/sendCommand': () => jsonResponse({ code: 403 }, 401),
    });
    await cloud.login();
    const [dev] = await cloud.listDevices();
    expect((await cloud.action(dev, 2, 1)).ok).toBe(false);
    expect(cloud.authFailed).toBe(false);
    expect(cloud.isLoggedIn()).toBe(true);
    expect(tokenCalls).toBe(2);
    expect(f.calls.filter((c) => c.path.endsWith('/sendCommand'))).toHaveLength(1);
  });

  it('a freshly issued token that gets 401 at once sets authFailed', async () => {
    const { cloud } = loggedInCloud({
      '/dreame-user-iot/iotuserbind/device/listV2': () => jsonResponse({ code: 403 }, 401),
    });
    await cloud.login();
    await expect(cloud.listDevices()).rejects.toBeInstanceOf(DreameCloudError);
    expect(cloud.authFailed).toBe(true);
  });

  // form bodies must be encoded, "+" would reach the server as a space.
  it('sends a refresh key with reserved form characters unchanged', async () => {
    const KEY = 'ab+cd/=&x y%';
    const f = makeFetch({ '/dreame-auth/oauth/token': () => jsonResponse(TOKEN_RESPONSE()) });
    const { cloud } = newCloud(f, { refreshToken: KEY });
    expect(await cloud.login()).toBe(true);
    const form = new URLSearchParams(f.calls[0].init.body);
    expect(form.get('refresh_token')).toBe(KEY);
    expect([...form.keys()]).toEqual(['grant_type', 'scope', 'platform', 'type', 'refresh_token']);
  });

  it('encodes server supplied country and lang in the password login body', async () => {
    let n = 0;
    const f = makeFetch({
      '/dreame-auth/oauth/token': () => { n += 1; return jsonResponse(TOKEN_RESPONSE({ country: 'D&E', lang: 'd+e', refresh_token: undefined })); },
    });
    const { cloud, clock } = newCloud(f);
    await cloud.login();
    await cloud.login();
    const form = new URLSearchParams(f.calls[1].init.body);
    expect(form.get('country')).toBe('D&E');
    expect(form.get('lang')).toBe('d+e');
  });

  // close() aborts the call in flight and suppresses its retries.
  it('close() aborts a command in flight and never retries it', async () => {
    let sends = 0;
    const f = vi.fn(async (url, init) => {
      if (String(url).endsWith('/oauth/token')) return jsonResponse(TOKEN_RESPONSE());
      if (String(url).endsWith('/listV2')) return jsonResponse({ code: 0, data: { page: { records: [RECORD] } } });
      sends += 1;
      return new Promise((_res, rej) => {
        init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    });
    const { cloud } = newCloud(f, { retries: 3 });
    await cloud.login();
    const [dev] = await cloud.listDevices();
    const pending = cloud.action(dev, 2, 1).catch((e) => e);
    await new Promise((r) => setImmediate(r));
    cloud.close();
    const err = await pending;
    expect(err).toBeInstanceOf(DreameCloudError);
    expect(sends).toBe(1);
    await expect(cloud.action(dev, 2, 1)).rejects.toBeInstanceOf(DreameCloudError);
    expect(sends).toBe(1);
  });

  it('close() also stops the retries of an idempotent call in flight', async () => {
    let sends = 0;
    const f = vi.fn(async (url, init) => {
      if (String(url).endsWith('/oauth/token')) return jsonResponse(TOKEN_RESPONSE());
      if (String(url).endsWith('/listV2')) return jsonResponse({ code: 0, data: { page: { records: [RECORD] } } });
      sends += 1;
      return new Promise((_res, rej) => {
        init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    });
    const { cloud } = newCloud(f, { retries: 3 });
    await cloud.login();
    const [dev] = await cloud.listDevices();
    const pending = cloud.getProperties(dev, [{ siid: 2, piid: 1 }]).catch((e) => e);
    await new Promise((r) => setImmediate(r));
    cloud.close();
    expect(await pending).toBeInstanceOf(DreameCloudError);
    expect(sends).toBe(1);
  });

  it('never retries an action after a network error or timeout (it may have been executed)', async () => {
    let sends = 0;
    const f = vi.fn(async (url) => {
      if (String(url).endsWith('/oauth/token')) return jsonResponse(TOKEN_RESPONSE());
      if (String(url).endsWith('/listV2')) return jsonResponse({ code: 0, data: { page: { records: [RECORD] } } });
      sends += 1;
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    });
    const { cloud } = newCloud(f, { retries: 3 });
    await cloud.login();
    const [dev] = await cloud.listDevices();
    await expect(cloud.action(dev, 2, 1)).rejects.toBeInstanceOf(DreameCloudError);
    expect(sends).toBe(1);
  });

  it('redact() scrubs every registered secret from arbitrary text', async () => {
    const { cloud } = loggedInCloud();
    await cloud.login();
    await cloud.listDevices();
    const text = `x ${PW} ${PW_MD5} AT-secret-1 RT-secret-1 uid-4711 1234567 aa:bb:cc:dd:ee:ff y`;
    const out = cloud.redact(text);
    for (const s of [PW, PW_MD5, 'AT-secret-1', 'RT-secret-1', 'uid-4711', '1234567', 'aa:bb:cc:dd:ee:ff']) {
      expect(out).not.toContain(s);
    }
  });
});

describe('DreameCloud push subscription', () => {
  let fakeClient;
  let mqttConnect;
  beforeEach(() => {
    fakeClient = Object.assign(new EventEmitter(), { subscribe: vi.fn(), end: vi.fn() });
    mqttConnect = vi.fn(() => fakeClient);
  });

  async function startedCloud() {
    const f = makeFetch({
      '/dreame-auth/oauth/token': () => jsonResponse(TOKEN_RESPONSE()),
      '/dreame-user-iot/iotuserbind/device/listV2': () => jsonResponse({ code: 0, data: { page: { records: [RECORD] } } }),
    });
    const { cloud } = newCloud(f, { mqttConnect });
    await cloud.login();
    const devices = await cloud.listDevices();
    return { cloud, devices };
  }

  it('connects to the device broker with uid/token and subscribes to the status topic', async () => {
    const { cloud, devices } = await startedCloud();
    cloud.startPush(devices, vi.fn());
    expect(mqttConnect).toHaveBeenCalledTimes(1);
    const [url, opts] = mqttConnect.mock.calls[0];
    expect(url).toBe('mqtts://10000.mt.eu.iot.dreame.tech:19973');
    expect(opts.username).toBe('uid-4711');
    expect(opts.password).toBe('AT-secret-1');
    expect(opts.keepalive).toBe(60);
    expect(opts.clientId).toMatch(/^p_[0-9a-f]{16}$/);
    fakeClient.emit('connect');
    expect(fakeClient.subscribe).toHaveBeenCalledWith('/status/1234567/uid-4711/dreame.vacuum.r2449a/eu/');
  });

  it('forwards properties_changed pushes and ignores everything else', async () => {
    const { cloud, devices } = await startedCloud();
    const handler = vi.fn();
    cloud.startPush(devices, handler);
    fakeClient.emit('message', 't', Buffer.from(JSON.stringify({
      id: 92, did: '1234567',
      data: { method: 'properties_changed', params: [{ did: '1234567', siid: 2, piid: 1, value: 1 }, { siid: 3, piid: 1, value: 80 }] },
    })));
    expect(handler).toHaveBeenCalledWith('1234567', [
      { siid: 2, piid: 1, value: 1 }, { siid: 3, piid: 1, value: 80 },
    ]);
    handler.mockClear();
    fakeClient.emit('message', 't', Buffer.from('{"truncated'));
    fakeClient.emit('message', 't', Buffer.from(JSON.stringify({ data: { method: 'event_occured', params: [] } })));
    expect(handler).not.toHaveBeenCalled();
  });

  it('stopPush ends the client', async () => {
    const { cloud, devices } = await startedCloud();
    cloud.startPush(devices, vi.fn());
    cloud.stopPush();
    expect(fakeClient.end).toHaveBeenCalled();
  });

  it('does not start push after close()', async () => {
    const { cloud, devices } = await startedCloud();
    cloud.close();
    expect(cloud.startPush(devices, vi.fn())).toBe(false);
    expect(mqttConnect).not.toHaveBeenCalled();
  });

  it('connects only to push hosts below .iot.dreame.tech', async () => {
    const { cloud, devices } = await startedCloud();
    const bad = ['evil.example.org:19973', 'iot.dreame.tech.evil.org:19973', 'xiot.dreame.tech:19973', '10000.mt.eu.iot.dreame.tech:19973/x', 'user@10000.mt.eu.iot.dreame.tech:19973'];
    for (const bindDomain of bad) {
      expect(cloud.startPush(devices.map((d) => ({ ...d, bindDomain })), vi.fn())).toBe(false);
    }
    expect(mqttConnect).not.toHaveBeenCalled();
    expect(cloud.startPush([...devices, { ...devices[0], did: '999', bindDomain: bad[0] }], vi.fn())).toBe(true);
    expect(mqttConnect).toHaveBeenCalledTimes(1);
    expect(mqttConnect.mock.calls[0][0]).toBe('mqtts://10000.mt.eu.iot.dreame.tech:19973');
  });

  it('does not start push without a login or without an mqttConnect', async () => {
    const f = makeFetch({});
    const { cloud } = newCloud(f, { mqttConnect });
    expect(cloud.startPush([RECORD], vi.fn())).toBe(false);
    expect(mqttConnect).not.toHaveBeenCalled();
  });
});
