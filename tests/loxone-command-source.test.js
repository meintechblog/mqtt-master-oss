/**
 * The Dreame plugin trusts a
 * command value only when the Loxone plugin shows it from the Miniserver. If a
 * broker client could set that Loxone control through the Loxone plugin's own
 * write paths (…/cmd, by-uuid/…/cmd, sendControlCommand for REST, bindings and
 * the MQTT bridge), the Miniserver would report the injected value back and the
 * confirmation would pass. So the Loxone plugin refuses writes to every control
 * behind a topic another plugin takes commands from.
 */
import { describe, it, expect, vi } from 'vitest';
import LoxonePlugin from '../plugins/loxone/plugin.js';

const CTRL = '1a2b3c4d-0000-0000-ffff000000000001';  // Sauger EG (virtual input)
const STATE = '1a2b3c4d-0000-0000-ffff000000000002'; // its value state
const SUB = '1a2b3c4d-0000-0000-ffff000000000003';   // subcontrol of Sauger EG
const SUBSTATE = '1a2b3c4d-0000-0000-ffff000000000004';
const LICHT = '1a2b3c4d-0000-0000-ffff000000000005';
const LICHT_STATE = '1a2b3c4d-0000-0000-ffff000000000006';

const META = {
  [CTRL]: { uuid: CTRL, name: 'Sauger EG', type: 'Switch', room: 'EG', topic: 'loxone/eg/sauger-eg' },
  [STATE]: { uuid: STATE, name: 'Sauger EG', type: 'Switch', room: 'EG', topic: 'loxone/eg/sauger-eg/value', stateKey: 'value' },
  [SUB]: { uuid: SUB, name: 'Teil', type: 'Switch', room: 'EG', topic: 'loxone/eg/sauger-eg/teil' },
  [SUBSTATE]: { uuid: SUBSTATE, name: 'Teil', type: 'Switch', room: 'EG', topic: 'loxone/eg/sauger-eg/teil/value', stateKey: 'value' },
  [LICHT]: { uuid: LICHT, name: 'Licht', type: 'Switch', room: 'EG', topic: 'loxone/eg/licht' },
  [LICHT_STATE]: { uuid: LICHT_STATE, name: 'Licht', type: 'Switch', room: 'EG', topic: 'loxone/eg/licht/value', stateKey: 'value' },
};
const TOPICS = { 'loxone/eg/sauger-eg': CTRL, 'loxone/eg/sauger-eg/teil': SUB, 'loxone/eg/licht': LICHT };

function makePlugin({ sources = ['loxone/eg/sauger-eg/value/state'], dreame, more = [] } = {}) {
  const plugin = new LoxonePlugin();
  plugin._config = {};
  plugin._prefix = 'loxone';
  plugin._moodMappings = {};
  const sourcePlugin = dreame === undefined ? { commandSourceTopics: vi.fn(() => sources) } : dreame;
  const pluginManager = {
    getInstance: vi.fn((id) => (id === 'dreame' ? sourcePlugin : null)),
    getInstancesByType: vi.fn((type) => (type === 'dreame' ? [sourcePlugin, ...more].filter(Boolean) : [])),
  };
  plugin._ctx = {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    mqttService: { publish: vi.fn(), unsubscribe: vi.fn(), removeListener: vi.fn() },
    pluginManager,
  };
  plugin._structure = {
    getMeta: (uuid) => META[uuid] ?? undefined,
    topicToUuid: (topic) => TOPICS[topic],
    getControlTree: () => [
      { uuid: CTRL, states: [{ key: 'value', uuid: STATE }], subControls: [{ uuid: SUB, states: [{ key: 'value', uuid: SUBSTATE }] }] },
      { uuid: LICHT, states: [{ key: 'value', uuid: LICHT_STATE }] },
    ],
  };
  plugin._ws = { sendCommand: vi.fn() };
  return plugin;
}

const cmd = (plugin, topic, payload = '1') => plugin._onMqttMessage({ topic, payload: Buffer.from(payload) });

describe('LoxonePlugin refuses writes to command sources of other plugins', () => {
  it('refuses the name path of the control behind the command topic, before any value arrived', () => {
    const plugin = makePlugin();
    cmd(plugin, 'loxone/eg/sauger-eg/cmd');
    expect(plugin._ws.sendCommand).not.toHaveBeenCalled();
    expect(plugin._ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('command source'));
  });

  it('refuses the name path also after the state was published', () => {
    const plugin = makePlugin();
    plugin._onValueEvent(STATE, 0);
    cmd(plugin, 'loxone/eg/sauger-eg/cmd');
    expect(plugin._ws.sendCommand).not.toHaveBeenCalled();
  });

  it('refuses the by-uuid path for the control and for its state', () => {
    const plugin = makePlugin();
    cmd(plugin, `loxone/by-uuid/${CTRL}/cmd`);
    cmd(plugin, `loxone/by-uuid/${STATE}/cmd`);
    expect(plugin._ws.sendCommand).not.toHaveBeenCalled();
  });

  it('refuses by-uuid targets that are not a uuid of the loaded structure (name, other case)', () => {
    const plugin = makePlugin();
    cmd(plugin, 'loxone/by-uuid/Sauger EG/cmd');
    cmd(plugin, `loxone/by-uuid/${CTRL.toUpperCase()}/cmd`);
    cmd(plugin, 'loxone/by-uuid/gibt-es-nicht/cmd');
    expect(plugin._ws.sendCommand).not.toHaveBeenCalled();
  });

  it('protects parent controls when the command topic is a subcontrol state', () => {
    const plugin = makePlugin({ sources: ['loxone/eg/sauger-eg/teil/value/state'] });
    cmd(plugin, 'loxone/eg/sauger-eg/teil/cmd');
    cmd(plugin, 'loxone/eg/sauger-eg/cmd');
    cmd(plugin, `loxone/by-uuid/${SUBSTATE}/cmd`);
    expect(plugin._ws.sendCommand).not.toHaveBeenCalled();
  });

  it('resolves a by-uuid command topic to the same controls', () => {
    const plugin = makePlugin({ sources: [`loxone/by-uuid/${STATE}/state`] });
    cmd(plugin, 'loxone/eg/sauger-eg/cmd');
    cmd(plugin, `loxone/by-uuid/${CTRL}/cmd`);
    expect(plugin._ws.sendCommand).not.toHaveBeenCalled();
  });

  it('still forwards commands for other controls on both paths', () => {
    const plugin = makePlugin();
    cmd(plugin, 'loxone/eg/licht/cmd');
    cmd(plugin, `loxone/by-uuid/${LICHT}/cmd`, '0');
    expect(plugin._ws.sendCommand.mock.calls.map(([c]) => c)).toEqual([
      `jdev/sps/io/${LICHT}/1`, `jdev/sps/io/${LICHT}/0`,
    ]);
  });

  it('forwards everything when no plugin takes commands (Dreame missing or stopped)', () => {
    const missing = makePlugin({ dreame: null });
    cmd(missing, 'loxone/eg/sauger-eg/cmd');
    const stopped = makePlugin({ sources: [] });
    cmd(stopped, `loxone/by-uuid/${CTRL}/cmd`);
    expect(missing._ws.sendCommand).toHaveBeenCalledTimes(1);
    expect(stopped._ws.sendCommand).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the command sources cannot be read', () => {
    const plugin = makePlugin({ dreame: { commandSourceTopics: () => { throw new Error('kaputt'); } } });
    cmd(plugin, 'loxone/eg/licht/cmd');
    expect(plugin._ws.sendCommand).not.toHaveBeenCalled();
    expect(() => plugin.sendControlCommand(LICHT, '1')).toThrow();
  });

  it('sendControlCommand (REST, bindings, MQTT bridge) refuses the protected controls', () => {
    const plugin = makePlugin();
    expect(() => plugin.sendControlCommand(CTRL, '1')).toThrow(/command source/);
    expect(() => plugin.sendControlCommand(STATE, '1')).toThrow(/command source/);
    plugin.sendControlCommand(LICHT, '1');
    expect(plugin._ws.sendCommand.mock.calls.map(([c]) => c)).toEqual([`jdev/sps/io/${LICHT}/1`]);
  });

  it('asks every running Dreame instance, not only the one with the id dreame', () => {
    const second = { commandSourceTopics: vi.fn(() => ['loxone/eg/licht/value/state']) };
    const plugin = makePlugin({ more: [second] });
    cmd(plugin, 'loxone/eg/licht/cmd');
    cmd(plugin, `loxone/by-uuid/${LICHT_STATE}/cmd`);
    expect(() => plugin.sendControlCommand(LICHT, '1')).toThrow(/command source/);
    expect(plugin._ws.sendCommand).not.toHaveBeenCalled();
  });

  it('sendControlCommand refuses targets that are no lowercase Loxone uuid, e.g. a control name', () => {
    const plugin = makePlugin();
    expect(() => plugin.sendControlCommand('Sauger EG', '1')).toThrow();
    expect(() => plugin.sendControlCommand(CTRL.toUpperCase(), '1')).toThrow();
    expect(() => plugin.sendControlCommand('gibt-es-nicht', '1')).toThrow();
    expect(plugin._ws.sendCommand).not.toHaveBeenCalled();
  });

  // N1: virtual inputs that feed the command control in the
  // Miniserver logic are settable via jdev/sps/io as well, so they are blocked too
  it('refuses writes to the extra uuids a plugin names (inputs feeding the command control, N1)', () => {
    const VIRTUAL = '1a2b3c4d-0000-0000-ffff0000000000bb';
    const source = { commandSourceTopics: vi.fn(() => []), commandSourceUuids: vi.fn(() => [LICHT, VIRTUAL, 'Licht', 42]) };
    const plugin = makePlugin({ dreame: source });
    cmd(plugin, 'loxone/eg/licht/cmd');
    cmd(plugin, `loxone/by-uuid/${LICHT}/cmd`);
    cmd(plugin, `loxone/by-uuid/${LICHT_STATE}/cmd`);
    expect(() => plugin.sendControlCommand(LICHT, '1')).toThrow(/command source/);
    expect(() => plugin.sendControlCommand(VIRTUAL, '1')).toThrow(/command source/);
    expect(plugin._ws.sendCommand).not.toHaveBeenCalled();
    cmd(plugin, `loxone/by-uuid/${CTRL}/cmd`);
    expect(plugin._ws.sendCommand.mock.calls.map(([c]) => c)).toEqual([`jdev/sps/io/${CTRL}/1`]);
  });

  it('fails closed when the extra uuids cannot be read', () => {
    const plugin = makePlugin({ dreame: { commandSourceTopics: () => [], commandSourceUuids: () => { throw new Error('kaputt'); } } });
    cmd(plugin, 'loxone/eg/licht/cmd');
    expect(plugin._ws.sendCommand).not.toHaveBeenCalled();
    expect(() => plugin.sendControlCommand(LICHT, '1')).toThrow();
  });

  it('sendControlCommand still forwards virtual inputs that are not in the structure', () => {
    const plugin = makePlugin();
    const VIRTUAL = '1a2b3c4d-0000-0000-ffff0000000000aa';
    plugin.sendControlCommand(VIRTUAL, '1');
    expect(plugin._ws.sendCommand.mock.calls.map(([c]) => c)).toEqual([`jdev/sps/io/${VIRTUAL}/1`]);
  });
});
