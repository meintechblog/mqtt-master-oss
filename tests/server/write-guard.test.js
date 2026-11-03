/**
 * 
 * schreibende Methoden nur von 127.0.0.1 und der erlaubten Adresse, sonst 403.
 * Lesende Methoden bleiben aus dem ganzen LAN erreichbar.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import { installWriteGuard, isWriteAllowed, normalizeIp } from '../../server/lib/write-guard.js';

describe('normalizeIp', () => {
  it('strips the IPv4-mapped IPv6 prefix', () => {
    expect(normalizeIp('::ffff:192.168.1.10')).toBe('192.168.1.10');
  });
  it('maps ::1 to 127.0.0.1', () => {
    expect(normalizeIp('::1')).toBe('127.0.0.1');
  });
  it('returns empty string for missing addresses', () => {
    expect(normalizeIp(undefined)).toBe('');
  });
});

describe('isWriteAllowed', () => {
  const allow = ['127.0.0.1', '192.168.1.10'];
  it('allows listed addresses, also IPv4-mapped', () => {
    expect(isWriteAllowed('127.0.0.1', allow)).toBe(true);
    expect(isWriteAllowed('::ffff:192.168.1.10', allow)).toBe(true);
    expect(isWriteAllowed('::1', allow)).toBe(true);
  });
  it('refuses everything else, including prefixes of listed addresses', () => {
    expect(isWriteAllowed('192.168.1.21', allow)).toBe(false);
    expect(isWriteAllowed('192.168.1.100', allow)).toBe(false);
    expect(isWriteAllowed('192.168.1.20', allow)).toBe(false);
    expect(isWriteAllowed('', allow)).toBe(false);
  });
});

describe('installWriteGuard', () => {
  let app;
  let calls;

  beforeEach(async () => {
    calls = 0;
    app = Fastify({ logger: false });
    installWriteGuard(app, { allow: ['127.0.0.1', '192.168.1.10'] });
    const handler = async () => { calls += 1; return { ok: true }; };
    app.get('/api/x', handler);
    app.post('/api/x', handler);
    app.put('/api/x', handler);
    app.delete('/api/x', handler);
    app.patch('/api/x', handler);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    it(`${method} from another LAN address is refused with 403 before the handler runs`, async () => {
      const res = await app.inject({ method, url: '/api/x', remoteAddress: '192.168.1.20', payload: {} });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ ok: false, error: 'write_not_allowed' });
      expect(calls).toBe(0);
    });

    it(`${method} from the allowed address passes`, async () => {
      const res = await app.inject({ method, url: '/api/x', remoteAddress: '192.168.1.10', payload: {} });
      expect(res.statusCode).toBe(200);
      expect(calls).toBe(1);
    });
  }

  it('POST from localhost passes', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/x', remoteAddress: '127.0.0.1', payload: {} });
    expect(res.statusCode).toBe(200);
  });

  it('GET stays open for every LAN address', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/x', remoteAddress: '192.168.1.20' });
    expect(res.statusCode).toBe(200);
  });

  it('ignores X-Forwarded-For (no trustProxy)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/x',
      remoteAddress: '192.168.1.20',
      headers: { 'x-forwarded-for': '192.168.1.10' },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });
});
