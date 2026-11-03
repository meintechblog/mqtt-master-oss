import { describe, it, expect, vi, afterEach } from 'vitest';
import { MqttService } from '../server/services/mqtt-service.js';

describe('MqttService', () => {
  /** @type {MqttService|null} */
  let svc = null;

  afterEach(() => {
    if (svc && svc.client) {
      svc.client.end(true); // force-close to prevent lingering connections
    }
    svc = null;
  });

  it('constructor sets initial state', () => {
    svc = new MqttService('mqtt://localhost:1883');
    expect(svc.brokerUrl).toBe('mqtt://localhost:1883');
    expect(svc.connected).toBe(false);
    expect(svc.client).toBeNull();
  });

  it('connect resolves even without broker', async () => {
    svc = new MqttService('mqtt://127.0.0.1:19999');
    await svc.connect(); // should resolve within timeout, not throw
    expect(svc.isConnected()).toBe(false);
  }, 10000);

  it('isConnected returns false before connect', () => {
    svc = new MqttService('mqtt://localhost:1883');
    expect(svc.isConnected()).toBe(false);
  });

  it('unsubscribe does nothing when client is null', () => {
    svc = new MqttService('mqtt://localhost:1883');
    // Should not throw
    expect(() => svc.unsubscribe('test/#')).not.toThrow();
  });

  it('unsubscribe calls client.unsubscribe when connected', async () => {
    svc = new MqttService('mqtt://127.0.0.1:19999');
    await svc.connect();
    // Even if not connected to a real broker, the client object exists
    if (svc.client) {
      const spy = vi.spyOn(svc.client, 'unsubscribe');
      svc.unsubscribe('test/#');
      expect(spy).toHaveBeenCalledWith('test/#');
    }
  }, 10000);
});
