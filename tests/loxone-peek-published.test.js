/**
 * peekPublishedValue() nennt den Wert, den das Loxone-Plugin
 * selbst auf einem Zustandsthema veröffentlicht hat, aus dem Zustand der
 * Miniserver-Verbindung. Das Sauger-Plugin prüft Befehle dagegen, damit ein
 * fremder Publisher am Broker keinen Befehl einschleusen kann.
 */
import { describe, it, expect, vi } from 'vitest';
import LoxonePlugin from '../plugins/loxone/plugin.js';

const UUID = '1a2b3c4d-0000-0000-ffff000000000001';

function makePlugin() {
  const plugin = new LoxonePlugin();
  plugin._config = {};
  plugin._prefix = 'loxone';
  plugin._ctx = { mqttService: { publish: vi.fn(), unsubscribe: vi.fn(), removeListener: vi.fn() } };
  plugin._topicOf = 'loxone/eg/sauger-eg';
  plugin._structure = {
    getMeta: (uuid) => (uuid === UUID
      ? { uuid: UUID, name: 'Sauger EG', type: 'Switch', room: 'EG', topic: plugin._topicOf, stateKey: 'value' }
      : null),
    getControlTree: () => [{ uuid: UUID, states: [{ key: 'value', uuid: UUID }] }],
  };
  return plugin;
}

describe('LoxonePlugin.peekPublishedValue', () => {
  it('returns the current value for both topics the plugin published', () => {
    const plugin = makePlugin();
    plugin._onValueEvent(UUID, 1);
    expect(plugin.peekPublishedValue('loxone/eg/sauger-eg/state')).toBe(1);
    expect(plugin.peekPublishedValue(`loxone/by-uuid/${UUID}/state`)).toBe(1);
    plugin._onValueEvent(UUID, 2);
    expect(plugin.peekPublishedValue('loxone/eg/sauger-eg/state')).toBe(2);
  });

  it('is null for topics the plugin never published', () => {
    const plugin = makePlugin();
    expect(plugin.peekPublishedValue('loxone/eg/sauger-eg/state')).toBeNull();
    plugin._onValueEvent(UUID, 1);
    expect(plugin.peekPublishedValue('loxone/eg/anders/state')).toBeNull();
    expect(plugin.peekPublishedValue(undefined)).toBeNull();
  });

  it('is null for a disabled control (nothing published) and after stop', async () => {
    const plugin = makePlugin();
    plugin._config = { disabledControls: [UUID] };
    plugin._onValueEvent(UUID, 1);
    expect(plugin.peekPublishedValue('loxone/eg/sauger-eg/state')).toBeNull();

    const p2 = makePlugin();
    p2._onValueEvent(UUID, 1);
    p2._running = true;
    await p2.stop();
    expect(p2.peekPublishedValue('loxone/eg/sauger-eg/state')).toBeNull();
  });

  // a value only counts when the Miniserver reported it, not when this
  // plugin merely sent it (MQTT input, bindings) and caches it ahead of the confirmation.
  it('ignores values cached from sent commands', () => {
    const plugin = makePlugin();
    plugin._onValueEvent(UUID, 0);
    plugin._cacheSentValue(UUID, '1');
    expect(plugin._stateCache.get(UUID).value).toBe(1); // display cache still optimistic
    expect(plugin.peekPublishedValue('loxone/eg/sauger-eg/state')).toBe(0);
    plugin._onValueEvent(UUID, 1); // the Miniserver confirms
    expect(plugin.peekPublishedValue('loxone/eg/sauger-eg/state')).toBe(1);
  });

  // stale topics, disabled controls and a lost connection give no value.
  it('is null for a topic the control no longer publishes on', () => {
    const plugin = makePlugin();
    plugin._onValueEvent(UUID, 1);
    plugin._topicOf = 'loxone/og/sauger-eg'; // renamed / moved room in a new structure
    expect(plugin.peekPublishedValue('loxone/eg/sauger-eg/state')).toBeNull();
    expect(plugin.peekPublishedValue(`loxone/by-uuid/${UUID}/state`)).toBe(1);
  });

  it('is null after the control was disabled', () => {
    const plugin = makePlugin();
    plugin._onValueEvent(UUID, 1);
    plugin._config = { disabledControls: [UUID] };
    expect(plugin.peekPublishedValue('loxone/eg/sauger-eg/state')).toBeNull();
    expect(plugin.peekPublishedValue(`loxone/by-uuid/${UUID}/state`)).toBeNull();
  });

  it('is null while the Miniserver connection is lost, until it reports again', () => {
    const plugin = makePlugin();
    plugin._onValueEvent(UUID, 1);
    plugin._onWsDisconnected();
    expect(plugin.peekPublishedValue('loxone/eg/sauger-eg/state')).toBeNull();
    plugin._onValueEvent(UUID, 1); // the Miniserver sends all states again after the reconnect
    expect(plugin.peekPublishedValue('loxone/eg/sauger-eg/state')).toBe(1);
  });
});
