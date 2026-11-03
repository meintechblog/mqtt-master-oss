/**
 * the write guard on the real route
 * wiring of server/index.js (registerRoutes), not only on dummy routes.
 * Covers every registered writing route, encapsulated route plugins, 404
 * paths, HEAD/OPTIONS, IPv6 peers and the WebSocket upgrade.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebSocket from '@fastify/websocket';
import { registerRoutes } from '../../server/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const READ_ONLY = new Set(['GET', 'HEAD', 'OPTIONS']);

function fakeServices() {
  const mqttService = Object.assign(new EventEmitter(), {
    publish: vi.fn(async () => {}),
    subscribe: vi.fn(),
    connected: true,
  });
  const sysBrokerService = Object.assign(new EventEmitter(), {
    getState: () => ({}),
    isConnected: () => true,
  });
  const configService = {
    get: (key, fallback) => (key === 'web.writeAllow' ? ['127.0.0.1', '192.168.1.10'] : fallback),
    set: vi.fn(),
    save: vi.fn(async () => {}),
  };
  const pluginManager = {
    listAll: async () => [],
    getInstance: () => null,
  };
  const bridgeService = {
    listBridges: () => [],
    getBridge: () => null,
    getStatus: () => ({}),
    upsertBridge: vi.fn(async () => ({ ok: true })),
    deleteBridge: vi.fn(async () => ({ ok: true })),
    applyNow: vi.fn(async () => ({ ok: true })),
  };
  const topicCacheService = { list: () => [] };
  return { mqttService, sysBrokerService, configService, pluginManager, bridgeService, topicCacheService };
}

describe('write guard on the real route wiring', () => {
  let app;
  let services;
  const writeRoutes = [];

  beforeAll(async () => {
    services = fakeServices();
    app = Fastify({ logger: false });
    await app.register(fastifyStatic, { root: join(__dirname, '..', '..', 'webapp'), prefix: '/' });
    await app.register(fastifyWebSocket);
    for (const [name, value] of Object.entries(services)) app.decorate(name, value);
    app.addHook('onRoute', (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const m of methods) {
        if (!READ_ONLY.has(m)) writeRoutes.push({ method: m, url: route.url });
      }
    });
    await registerRoutes(app, services.configService);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const concrete = (url) => url.replace(/:uuid/g, '0f1e2d3c-4b5a-6978-8796a5b4c3d2e1f0').replace(/:[A-Za-z]+/g, 'x');

  it('registers the writing routes of every API module', () => {
    const urls = writeRoutes.map((r) => `${r.method} ${r.url}`);
    expect(urls).toContain('POST /api/mqtt/publish');
    expect(urls).toContain('PUT /api/bridges/:id');
    expect(urls).toContain('POST /api/plugins/:id/controls/:uuid/cmd');
    expect(urls.some((u) => u.includes('/api/update'))).toBe(true);
    expect(writeRoutes.length).toBeGreaterThan(20);
  });

  it('refuses every writing route from another LAN address with 403', async () => {
    const passed = [];
    for (const r of writeRoutes) {
      const res = await app.inject({ method: r.method, url: concrete(r.url), remoteAddress: '192.168.1.20', payload: {} });
      if (res.statusCode !== 403) passed.push(`${r.method} ${r.url} → ${res.statusCode}`);
    }
    expect(passed).toEqual([]);
    expect(services.mqttService.publish).not.toHaveBeenCalled();
    expect(services.bridgeService.upsertBridge).not.toHaveBeenCalled();
    expect(services.bridgeService.deleteBridge).not.toHaveBeenCalled();
    expect(services.bridgeService.applyNow).not.toHaveBeenCalled();
  });

  it('refuses writes to unknown paths (404 handler) from the LAN', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/gibt-es-nicht', remoteAddress: '192.168.1.20', payload: {} });
    expect(res.statusCode).toBe(403);
  });

  for (const peer of ['::ffff:192.168.1.20', 'fe80::1', '2001:db8::240', '::ffff:127.0.0.2']) {
    it(`refuses a write from the IPv6 peer ${peer}`, async () => {
      const res = await app.inject({ method: 'POST', url: '/api/mqtt/publish', remoteAddress: peer, payload: { topic: 't', payload: '1' } });
      expect(res.statusCode).toBe(403);
    });
  }

  for (const peer of ['::1', '::ffff:127.0.0.1', '::ffff:192.168.1.10', '192.168.1.10']) {
    it(`lets a write from ${peer} through to the real handler`, async () => {
      services.mqttService.publish.mockClear();
      const res = await app.inject({ method: 'POST', url: '/api/mqtt/publish', remoteAddress: peer, payload: { topic: 't', payload: '1' } });
      expect(res.statusCode).toBe(200);
      expect(services.mqttService.publish).toHaveBeenCalledOnce();
    });
  }

  it('ignores X-Forwarded-For (no trustProxy)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/mqtt/publish', remoteAddress: '192.168.1.20',
      headers: { 'x-forwarded-for': '192.168.1.10' }, payload: { topic: 't', payload: '1' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('keeps GET, HEAD and OPTIONS open for the LAN', async () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const res = await app.inject({ method, url: '/api/plugins', remoteAddress: '192.168.1.20' });
      expect(res.statusCode, method).not.toBe(403);
    }
  });

  it('accepts the WebSocket upgrade (read-only) and offers no publish over it', async () => {
    const ws = await app.injectWS('/ws/messages');
    const replies = [];
    const got = new Promise((resolve) => {
      ws.on('message', (raw) => {
        replies.push(JSON.parse(raw.toString()));
        if (replies.length === 2) resolve();
      });
    });
    ws.send(JSON.stringify({ action: 'subscribe', topic: 'a/#' }));
    ws.send(JSON.stringify({ action: 'publish', topic: 'a/b', payload: '1' }));
    await got;
    ws.terminate();
    expect(replies[0]).toMatchObject({ type: 'subscribed', topic: 'a/#' });
    expect(replies[1]).toMatchObject({ type: 'error', message: 'Unknown action' });
    expect(services.mqttService.publish).not.toHaveBeenCalledWith('a/b', expect.anything(), expect.anything());
  });
});
