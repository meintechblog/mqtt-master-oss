import { describe, it, expect, afterAll } from 'vitest';
import { start } from '../server/index.js';

let app;

afterAll(async () => {
  if (app) {
    // Close MQTT client to avoid hanging connections
    if (app.mqttService && app.mqttService.client) {
      app.mqttService.client.end(true);
    }
    await app.close();
  }
});

describe('Fastify server', () => {
  it('starts and serves index.html', async () => {
    app = await start({
      port: 0,
      configPath: '/tmp/mqtt-master-test-no-exist.json',
      host: '127.0.0.1',
    });
    const addr = app.server.address();
    const res = await fetch(`http://127.0.0.1:${addr.port}/`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('MQTT Master');
  });
});
