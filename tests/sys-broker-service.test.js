import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { SysBrokerService } from '../server/services/sys-broker-service.js';

/** Minimal mock of MqttService */
function createMockMqtt(connected = true) {
  const mock = new EventEmitter();
  mock.subscribe = vi.fn();
  mock.isConnected = vi.fn(() => connected);
  return mock;
}

describe('SysBrokerService', () => {
  /** @type {ReturnType<typeof createMockMqtt>} */
  let mqttMock;
  /** @type {SysBrokerService} */
  let svc;

  beforeEach(() => {
    vi.useFakeTimers();
    mqttMock = createMockMqtt();
    svc = new SysBrokerService(mqttMock);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('subscribes to $SYS/# on construction', () => {
    expect(mqttMock.subscribe).toHaveBeenCalledWith('$SYS/#');
  });

  it('delegates isConnected to mqttService', () => {
    expect(svc.isConnected()).toBe(true);
    mqttMock.isConnected.mockReturnValue(false);
    expect(svc.isConnected()).toBe(false);
  });

  it('getState returns empty data and topics initially', () => {
    const state = svc.getState();
    expect(state).toHaveProperty('data');
    expect(state).toHaveProperty('topics');
    expect(Object.keys(state.data).length).toBe(0);
    expect(Object.keys(state.topics).length).toBe(0);
  });

  it('parses numeric $SYS values into numbers in data', () => {
    mqttMock.emit('message', { topic: '$SYS/broker/clients/connected', payload: '3', timestamp: Date.now() });
    vi.advanceTimersByTime(600);
    const state = svc.getState();
    expect(state.data.clients_connected).toBe(3);
  });

  it('parses float $SYS values', () => {
    mqttMock.emit('message', { topic: '$SYS/broker/load/publish/received/1min', payload: '2.4', timestamp: Date.now() });
    vi.advanceTimersByTime(600);
    expect(svc.getState().data.publish_received_1min).toBe(2.4);
  });

  it('keeps string values as strings (e.g., version)', () => {
    mqttMock.emit('message', { topic: '$SYS/broker/version', payload: 'mosquitto version 2.0.18', timestamp: Date.now() });
    vi.advanceTimersByTime(600);
    expect(svc.getState().data.version).toBe('mosquitto version 2.0.18');
  });

  it('parses uptime as seconds number', () => {
    mqttMock.emit('message', { topic: '$SYS/broker/uptime', payload: '86400 seconds', timestamp: Date.now() });
    vi.advanceTimersByTime(600);
    expect(svc.getState().data.uptime).toBe(86400);
  });

  it('builds hierarchical topics tree', () => {
    mqttMock.emit('message', { topic: '$SYS/broker/clients/connected', payload: '3', timestamp: Date.now() });
    vi.advanceTimersByTime(600);
    const topics = svc.getState().topics;
    expect(topics['$SYS'].broker.clients.connected).toBe('3');
  });

  it('ignores non-$SYS topics', () => {
    mqttMock.emit('message', { topic: 'home/temp', payload: '22', timestamp: Date.now() });
    vi.advanceTimersByTime(600);
    const state = svc.getState();
    expect(Object.keys(state.data).length).toBe(0);
    expect(Object.keys(state.topics).length).toBe(0);
  });

  it('emits update event with 500ms debounce', () => {
    const handler = vi.fn();
    svc.on('update', handler);

    // Send two messages rapidly
    mqttMock.emit('message', { topic: '$SYS/broker/clients/connected', payload: '3', timestamp: Date.now() });
    mqttMock.emit('message', { topic: '$SYS/broker/messages/received', payload: '100', timestamp: Date.now() });

    // Not yet emitted
    expect(handler).not.toHaveBeenCalled();

    // After 500ms debounce
    vi.advanceTimersByTime(500);
    expect(handler).toHaveBeenCalledTimes(1);

    const emitted = handler.mock.calls[0][0];
    expect(emitted.data.clients_connected).toBe(3);
    expect(emitted.data.messages_received).toBe(100);
  });

  it('debounce resets on new messages within window', () => {
    const handler = vi.fn();
    svc.on('update', handler);

    mqttMock.emit('message', { topic: '$SYS/broker/clients/connected', payload: '3', timestamp: Date.now() });
    vi.advanceTimersByTime(300);
    // Send another message before 500ms expires
    mqttMock.emit('message', { topic: '$SYS/broker/messages/received', payload: '100', timestamp: Date.now() });
    vi.advanceTimersByTime(300);
    // Original timer would have fired at 500ms, but it was reset
    expect(handler).not.toHaveBeenCalled();

    vi.advanceTimersByTime(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('emits connection_status on mqttService connected', () => {
    const handler = vi.fn();
    svc.on('connection_status', handler);
    mqttMock.emit('connected');
    expect(handler).toHaveBeenCalledWith({ connected: true });
  });

  it('emits connection_status on mqttService disconnected', () => {
    const handler = vi.fn();
    svc.on('connection_status', handler);
    mqttMock.emit('disconnected');
    expect(handler).toHaveBeenCalledWith({ connected: false });
  });

  it('maps all known $SYS topics to flat keys', () => {
    const topics = [
      ['$SYS/broker/clients/connected', '5'],
      ['$SYS/broker/messages/received', '1000'],
      ['$SYS/broker/messages/sent', '800'],
      ['$SYS/broker/load/publish/received/1min', '2.5'],
      ['$SYS/broker/load/publish/sent/1min', '1.2'],
      ['$SYS/broker/subscriptions/count', '10'],
      ['$SYS/broker/heap/current', '524288'],
      ['$SYS/broker/heap/maximum', '1048576'],
      ['$SYS/broker/load/messages/received/1min', '5.2'],
      ['$SYS/broker/load/messages/received/5min', '4.1'],
      ['$SYS/broker/load/messages/received/15min', '3.8'],
      ['$SYS/broker/version', 'mosquitto version 2.0.18'],
      ['$SYS/broker/uptime', '86400 seconds'],
    ];

    for (const [topic, payload] of topics) {
      mqttMock.emit('message', { topic, payload, timestamp: Date.now() });
    }
    vi.advanceTimersByTime(600);

    const { data } = svc.getState();
    expect(data.clients_connected).toBe(5);
    expect(data.messages_received).toBe(1000);
    expect(data.messages_sent).toBe(800);
    expect(data.publish_received_1min).toBe(2.5);
    expect(data.publish_sent_1min).toBe(1.2);
    expect(data.subscriptions_count).toBe(10);
    expect(data.heap_current).toBe(524288);
    expect(data.heap_maximum).toBe(1048576);
    expect(data.load_received_1min).toBe(5.2);
    expect(data.load_received_5min).toBe(4.1);
    expect(data.load_received_15min).toBe(3.8);
    expect(data.version).toBe('mosquitto version 2.0.18');
    expect(data.uptime).toBe(86400);
  });

  it('getState returns copies (not references)', () => {
    mqttMock.emit('message', { topic: '$SYS/broker/clients/connected', payload: '3', timestamp: Date.now() });
    vi.advanceTimersByTime(600);
    const state1 = svc.getState();
    const state2 = svc.getState();
    expect(state1).not.toBe(state2);
    expect(state1.data).not.toBe(state2.data);
  });
});
