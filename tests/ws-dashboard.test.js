import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import Fastify from 'fastify';
import fastifyWebSocket from '@fastify/websocket';
import WebSocket from 'ws';
import wsDashboard from '../server/routes/ws-dashboard.js';

/** Create a mock SysBrokerService */
function createMockSysBrokerService(state = { data: {}, topics: {} }, connected = true) {
  const mock = new EventEmitter();
  mock.getState = vi.fn(() => structuredClone(state));
  mock.isConnected = vi.fn(() => connected);
  return mock;
}

/**
 * Connect a WebSocket client that buffers all messages from the start.
 * Returns { ws, messages, waitFor(count) }.
 */
function createClient(url) {
  const ws = new WebSocket(url);
  const messages = [];
  const waiters = [];

  ws.on('message', (raw) => {
    messages.push(JSON.parse(raw.toString()));
    // Resolve any pending waiters
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (messages.length >= waiters[i].count) {
        waiters[i].resolve([...messages]);
        waiters.splice(i, 1);
      }
    }
  });

  function waitFor(count) {
    if (messages.length >= count) return Promise.resolve([...messages]);
    return new Promise((resolve) => {
      waiters.push({ count, resolve });
    });
  }

  function waitForOpen() {
    return new Promise((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
  }

  return { ws, messages, waitFor, waitForOpen };
}

describe('ws-dashboard', () => {
  let app;
  let sysBrokerService;

  const defaultState = {
    data: { clients_connected: 3, messages_received: 100 },
    topics: { '$SYS': { broker: { clients: { connected: '3' } } } },
  };

  beforeEach(async () => {
    sysBrokerService = createMockSysBrokerService(defaultState, true);

    app = Fastify({ logger: false });
    await app.register(fastifyWebSocket);
    app.decorate('sysBrokerService', sysBrokerService);
    await app.register(wsDashboard);
    await app.listen({ port: 0, host: '127.0.0.1' });
  });

  afterEach(async () => {
    await app.close();
  });

  function wsUrl() {
    const addr = app.server.address();
    return `ws://127.0.0.1:${addr.port}/ws/dashboard`;
  }

  it('sends initial sys_state on connect', async () => {
    const client = createClient(wsUrl());
    await client.waitForOpen();
    const msgs = await client.waitFor(2);
    client.ws.close();

    const sysStateMsg = msgs.find((m) => m.type === 'sys_state');
    expect(sysStateMsg).toBeDefined();
    expect(sysStateMsg.data.clients_connected).toBe(3);
    expect(sysStateMsg.topics['$SYS'].broker.clients.connected).toBe('3');
  });

  it('sends initial connection_status on connect', async () => {
    const client = createClient(wsUrl());
    await client.waitForOpen();
    const msgs = await client.waitFor(2);
    client.ws.close();

    const statusMsg = msgs.find((m) => m.type === 'connection_status');
    expect(statusMsg).toBeDefined();
    expect(statusMsg.connected).toBe(true);
  });

  it('broadcasts sys_state on sysBrokerService update event', async () => {
    const client = createClient(wsUrl());
    await client.waitForOpen();
    await client.waitFor(2); // initial messages

    // Simulate sysBrokerService emitting update
    sysBrokerService.emit('update', {
      data: { clients_connected: 5 },
      topics: { '$SYS': { broker: { clients: { connected: '5' } } } },
    });

    const msgs = await client.waitFor(3);
    const broadcast = msgs[2];
    expect(broadcast.type).toBe('sys_state');
    expect(broadcast.data.clients_connected).toBe(5);
    client.ws.close();
  });

  it('broadcasts connection_status on sysBrokerService event', async () => {
    const client = createClient(wsUrl());
    await client.waitForOpen();
    await client.waitFor(2);

    sysBrokerService.emit('connection_status', { connected: false });

    const msgs = await client.waitFor(3);
    const broadcast = msgs[2];
    expect(broadcast.type).toBe('connection_status');
    expect(broadcast.connected).toBe(false);
    client.ws.close();
  });

  it('handles multiple clients', async () => {
    const c1 = createClient(wsUrl());
    const c2 = createClient(wsUrl());
    await c1.waitForOpen();
    await c2.waitForOpen();
    await c1.waitFor(2);
    await c2.waitFor(2);

    sysBrokerService.emit('update', {
      data: { clients_connected: 10 },
      topics: {},
    });

    const msgs1 = await c1.waitFor(3);
    const msgs2 = await c2.waitFor(3);
    expect(msgs1[2].data.clients_connected).toBe(10);
    expect(msgs2[2].data.clients_connected).toBe(10);

    c1.ws.close();
    c2.ws.close();
  });

  it('removes disconnected clients from broadcast list', async () => {
    const c1 = createClient(wsUrl());
    const c2 = createClient(wsUrl());
    await c1.waitForOpen();
    await c2.waitForOpen();
    await c1.waitFor(2);
    await c2.waitFor(2);

    // Close c1 and wait for close to propagate
    c1.ws.close();
    await new Promise((r) => setTimeout(r, 100));

    // This should not throw even though c1 is gone
    sysBrokerService.emit('update', {
      data: { clients_connected: 1 },
      topics: {},
    });

    const msgs = await c2.waitFor(3);
    expect(msgs[2].data.clients_connected).toBe(1);
    c2.ws.close();
  });
});
