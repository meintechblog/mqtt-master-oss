import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import Fastify from 'fastify';
import fastifyWebSocket from '@fastify/websocket';
import WebSocket from 'ws';
import wsMessages from '../server/routes/ws-messages.js';

/** Create a mock MqttService (EventEmitter with subscribe/unsubscribe as vi.fn()) */
function createMockMqttService() {
  const mock = new EventEmitter();
  mock.subscribe = vi.fn();
  mock.unsubscribe = vi.fn();
  return mock;
}

/**
 * Connect a WebSocket client that buffers all messages.
 * Returns { ws, messages, waitFor(count), waitForOpen() }.
 */
function createClient(url) {
  const ws = new WebSocket(url);
  const messages = [];
  const waiters = [];

  ws.on('message', (raw) => {
    messages.push(JSON.parse(raw.toString()));
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

describe('ws-messages', () => {
  let app;
  let mqttService;

  /** topicCacheService stub for the per-test replay assertions. Tests that
   *  don't care about replay leave this empty; the route just emits no
   *  cached messages. */
  let topicCacheStub;

  beforeEach(async () => {
    mqttService = createMockMqttService();
    topicCacheStub = { list: () => [] };

    app = Fastify({ logger: false });
    await app.register(fastifyWebSocket);
    app.decorate('mqttService', mqttService);
    app.decorate('topicCacheService', topicCacheStub);
    await app.register(wsMessages);
    await app.listen({ port: 0, host: '127.0.0.1' });
  });

  afterEach(async () => {
    await app.close();
  });

  function wsUrl() {
    const addr = app.server.address();
    return `ws://127.0.0.1:${addr.port}/ws/messages`;
  }

  it('subscribe replays matching cached retained messages newest-first', async () => {
    // Without this, pages that depend solely on retained MQTT topics (Clients,
    // any "latest value" panel) sit on their empty state until the publisher's
    // next poll cycle — for the UniFi clients poll that's 30 s of nothing on
    // every page reload.
    topicCacheStub.list = () => [
      { topic: 'unifi/clients/by-mac/aa-bb-cc-dd-ee-01/state', payload: '{"name":"deviceA"}', ts: 2000, count: 1 },
      { topic: 'unifi/clients/by-mac/aa-bb-cc-dd-ee-02/state', payload: '{"name":"deviceB"}', ts: 1000, count: 1 },
      { topic: 'other/topic',                                  payload: 'ignored',          ts: 3000, count: 1 },
    ];
    const client = createClient(wsUrl());
    await client.waitForOpen();

    client.ws.send(JSON.stringify({ action: 'subscribe', topic: 'unifi/clients/by-mac/+/state' }));
    // 1 subscribed confirmation + 2 replayed retained messages
    const msgs = await client.waitFor(3);
    expect(msgs[0]).toEqual({ type: 'subscribed', topic: 'unifi/clients/by-mac/+/state' });
    const replayed = msgs.slice(1).filter((m) => m.type === 'message');
    expect(replayed).toHaveLength(2);
    expect(replayed.map((m) => m.topic).sort()).toEqual([
      'unifi/clients/by-mac/aa-bb-cc-dd-ee-01/state',
      'unifi/clients/by-mac/aa-bb-cc-dd-ee-02/state',
    ]);
    // The non-matching topic must not leak across the subscription filter.
    expect(replayed.some((m) => m.topic === 'other/topic')).toBe(false);
    client.ws.close();
  });

  it('subscribe with no topicCacheService still works (zero replay, no crash)', async () => {
    // App may not have decorated the cache (older deployments / tests). The
    // route degrades gracefully — confirmation only, no replay.
    const client = createClient(wsUrl());
    await client.waitForOpen();
    client.ws.send(JSON.stringify({ action: 'subscribe', topic: '#' }));
    const msgs = await client.waitFor(1);
    expect(msgs[0]).toEqual({ type: 'subscribed', topic: '#' });
    client.ws.close();
  });

  it('subscribe returns confirmation (per-client filter, no broker call)', async () => {
    const client = createClient(wsUrl());
    await client.waitForOpen();

    client.ws.send(JSON.stringify({ action: 'subscribe', topic: '#' }));
    const msgs = await client.waitFor(1);

    expect(msgs[0]).toEqual({ type: 'subscribed', topic: '#' });
    // Broker subscription is owned by TopicCacheService, not the WS route
    expect(mqttService.subscribe).not.toHaveBeenCalled();
    client.ws.close();
  });

  it('unsubscribe returns confirmation (per-client filter, no broker call)', async () => {
    const client = createClient(wsUrl());
    await client.waitForOpen();

    client.ws.send(JSON.stringify({ action: 'subscribe', topic: 'test/#' }));
    await client.waitFor(1);

    client.ws.send(JSON.stringify({ action: 'unsubscribe', topic: 'test/#' }));
    const msgs = await client.waitFor(2);

    expect(msgs[1]).toEqual({ type: 'unsubscribed', topic: 'test/#' });
    expect(mqttService.unsubscribe).not.toHaveBeenCalled();
    client.ws.close();
  });

  it('forwards matching MQTT messages to subscribed client', async () => {
    const client = createClient(wsUrl());
    await client.waitForOpen();

    client.ws.send(JSON.stringify({ action: 'subscribe', topic: 'test/#' }));
    await client.waitFor(1);

    // Simulate an MQTT message arriving
    mqttService.emit('message', { topic: 'test/foo', payload: 'bar', timestamp: 1234567890 });

    const msgs = await client.waitFor(2);
    expect(msgs[1]).toEqual({
      type: 'message',
      topic: 'test/foo',
      payload: 'bar',
      timestamp: 1234567890,
    });
    client.ws.close();
  });

  it('does not forward messages after unsubscribing', async () => {
    const client = createClient(wsUrl());
    await client.waitForOpen();

    client.ws.send(JSON.stringify({ action: 'subscribe', topic: 'test/#' }));
    await client.waitFor(1);

    client.ws.send(JSON.stringify({ action: 'unsubscribe', topic: 'test/#' }));
    await client.waitFor(2);

    // Emit a message -- client should NOT receive it
    mqttService.emit('message', { topic: 'test/foo', payload: 'bar', timestamp: 999 });

    // Wait a bit and verify no new message arrived
    await new Promise((r) => setTimeout(r, 100));
    expect(client.messages.length).toBe(2); // only subscribed + unsubscribed
    client.ws.close();
  });

  it('client disconnect drops per-client filters but does not unsubscribe broker', async () => {
    const client = createClient(wsUrl());
    await client.waitForOpen();

    client.ws.send(JSON.stringify({ action: 'subscribe', topic: 'a/#' }));
    client.ws.send(JSON.stringify({ action: 'subscribe', topic: 'b/#' }));
    await client.waitFor(2);

    client.ws.close();
    await new Promise((r) => setTimeout(r, 100));

    expect(mqttService.unsubscribe).not.toHaveBeenCalled();
  });

  it('two clients with different subscriptions get only their own messages', async () => {
    const c1 = createClient(wsUrl());
    const c2 = createClient(wsUrl());
    await c1.waitForOpen();
    await c2.waitForOpen();

    c1.ws.send(JSON.stringify({ action: 'subscribe', topic: 'sensor/#' }));
    c2.ws.send(JSON.stringify({ action: 'subscribe', topic: 'control/#' }));
    await c1.waitFor(1);
    await c2.waitFor(1);

    // Message matching only c1
    mqttService.emit('message', { topic: 'sensor/temp', payload: '22', timestamp: 1 });
    // Message matching only c2
    mqttService.emit('message', { topic: 'control/light', payload: 'on', timestamp: 2 });

    const msgs1 = await c1.waitFor(2);
    const msgs2 = await c2.waitFor(2);

    // c1 got sensor/temp but NOT control/light
    expect(msgs1[1].topic).toBe('sensor/temp');
    expect(msgs1.length).toBe(2);

    // c2 got control/light but NOT sensor/temp
    expect(msgs2[1].topic).toBe('control/light');
    expect(msgs2.length).toBe(2);

    c1.ws.close();
    c2.ws.close();
  });

  it('invalid JSON from client is silently ignored', async () => {
    const client = createClient(wsUrl());
    await client.waitForOpen();

    client.ws.send('not valid json {{{');

    // Should not crash -- send a valid command after
    client.ws.send(JSON.stringify({ action: 'subscribe', topic: 'test' }));
    const msgs = await client.waitFor(1);
    expect(msgs[0].type).toBe('subscribed');
    client.ws.close();
  });

  it('empty topic in subscribe returns error', async () => {
    const client = createClient(wsUrl());
    await client.waitForOpen();

    client.ws.send(JSON.stringify({ action: 'subscribe', topic: '' }));
    const msgs = await client.waitFor(1);

    expect(msgs[0].type).toBe('error');
    expect(msgs[0].message).toBeDefined();
    client.ws.close();
  });

  it('missing topic in subscribe returns error', async () => {
    const client = createClient(wsUrl());
    await client.waitForOpen();

    client.ws.send(JSON.stringify({ action: 'subscribe' }));
    const msgs = await client.waitFor(1);

    expect(msgs[0].type).toBe('error');
    client.ws.close();
  });

  it('MQTT wildcard + matches single level', async () => {
    const client = createClient(wsUrl());
    await client.waitForOpen();

    client.ws.send(JSON.stringify({ action: 'subscribe', topic: 'home/+/temp' }));
    await client.waitFor(1);

    // Should match
    mqttService.emit('message', { topic: 'home/living/temp', payload: '21', timestamp: 1 });
    // Should NOT match (two levels where + expects one)
    mqttService.emit('message', { topic: 'home/living/room/temp', payload: '19', timestamp: 2 });
    // Should NOT match (different suffix)
    mqttService.emit('message', { topic: 'home/living/humidity', payload: '50', timestamp: 3 });

    const msgs = await client.waitFor(2);
    expect(msgs[1].topic).toBe('home/living/temp');

    await new Promise((r) => setTimeout(r, 100));
    expect(client.messages.length).toBe(2); // only subscribed + one match
    client.ws.close();
  });

  it('MQTT wildcard # matches multiple levels', async () => {
    const client = createClient(wsUrl());
    await client.waitForOpen();

    client.ws.send(JSON.stringify({ action: 'subscribe', topic: 'home/#' }));
    await client.waitFor(1);

    mqttService.emit('message', { topic: 'home/living/temp', payload: '21', timestamp: 1 });
    mqttService.emit('message', { topic: 'home/a/b/c', payload: 'deep', timestamp: 2 });
    mqttService.emit('message', { topic: 'office/temp', payload: '20', timestamp: 3 }); // should NOT match

    const msgs = await client.waitFor(3); // subscribed + 2 matches
    expect(msgs[1].topic).toBe('home/living/temp');
    expect(msgs[2].topic).toBe('home/a/b/c');

    await new Promise((r) => setTimeout(r, 100));
    expect(client.messages.length).toBe(3);
    client.ws.close();
  });
});
