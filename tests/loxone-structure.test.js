import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LoxoneStructure } from '../plugins/loxone/loxone-structure.js';

// Realistic mock LoxAPP3.json structure
const MOCK_LOXAPP3 = {
  msInfo: { serialNr: '504F9412345' },
  rooms: {
    '0a1b2c3d-0001-0002-ffff-aabbccddeeff': { name: 'Living Room', uuid: '0a1b2c3d-0001-0002-ffff-aabbccddeeff' },
    '0a1b2c3d-0001-0002-ffff-112233445566': { name: 'Bedroom', uuid: '0a1b2c3d-0001-0002-ffff-112233445566' },
  },
  cats: {
    'cat-uuid-0001-0002-ffff-aabbccddeeff': { name: 'Lighting', uuid: 'cat-uuid-0001-0002-ffff-aabbccddeeff' },
    'cat-uuid-0001-0002-ffff-112233445566': { name: 'Blinds', uuid: 'cat-uuid-0001-0002-ffff-112233445566' },
  },
  controls: {
    // Simple switch in Living Room
    '1a2b3c4d-0001-0002-ffff-aabbccddeeff': {
      name: 'Ceiling Light',
      type: 'Switch',
      uuidAction: '1a2b3c4d-0001-0002-ffff-aabbccddeeff',
      room: '0a1b2c3d-0001-0002-ffff-aabbccddeeff',
      cat: 'cat-uuid-0001-0002-ffff-aabbccddeeff',
      states: {
        active: '1a2b3c4d-1111-2222-ffff-aabbccddeeff',
      },
      subControls: {},
    },
    // Light controller in Living Room with sub-states
    '2a3b4c5d-0001-0002-ffff-aabbccddeeff': {
      name: 'Light Controller',
      type: 'LightController',
      uuidAction: '2a3b4c5d-0001-0002-ffff-aabbccddeeff',
      room: '0a1b2c3d-0001-0002-ffff-aabbccddeeff',
      cat: 'cat-uuid-0001-0002-ffff-aabbccddeeff',
      states: {
        activeMoods: '2a3b4c5d-1111-2222-ffff-aabbccddeeff',
        moodList: '2a3b4c5d-3333-4444-ffff-aabbccddeeff',
      },
      subControls: {
        '2a3b4c5d-0001-0002-ffff-sub1sub1sub1': {
          name: 'Mood Switch',
          type: 'Switch',
          uuidAction: '2a3b4c5d-0001-0002-ffff-sub1sub1sub1',
          states: {
            active: '2a3b4c5d-0001-0002-ffff-sub1active01',
          },
        },
      },
    },
    // Jalousie in Bedroom
    '3a4b5c6d-0001-0002-ffff-aabbccddeeff': {
      name: 'Window Blind',
      type: 'Jalousie',
      uuidAction: '3a4b5c6d-0001-0002-ffff-aabbccddeeff',
      room: '0a1b2c3d-0001-0002-ffff-112233445566',
      cat: 'cat-uuid-0001-0002-ffff-112233445566',
      states: {
        position: '3a4b5c6d-1111-2222-ffff-aabbccddeeff',
        up: '3a4b5c6d-3333-4444-ffff-aabbccddeeff',
        down: '3a4b5c6d-5555-6666-ffff-aabbccddeeff',
      },
      subControls: {},
    },
    // Control with no room
    '4a5b6c7d-0001-0002-ffff-aabbccddeeff': {
      name: 'Orphan Sensor',
      type: 'InfoOnlyAnalog',
      uuidAction: '4a5b6c7d-0001-0002-ffff-aabbccddeeff',
      room: '',
      cat: 'cat-uuid-0001-0002-ffff-aabbccddeeff',
      states: {
        value: '4a5b6c7d-1111-2222-ffff-aabbccddeeff',
      },
      subControls: {},
    },
  },
};

describe('LoxoneStructure', () => {
  let structure;

  beforeEach(() => {
    structure = new LoxoneStructure('loxone');
  });

  describe('slugify', () => {
    it('converts "Living Room" to "living-room"', () => {
      expect(structure.slugify('Living Room')).toBe('living-room');
    });

    it('converts German umlauts: "Bär/Office" to "baer-office"', () => {
      expect(structure.slugify('Bär/Office')).toBe('baer-office');
    });

    it('converts all German special characters', () => {
      expect(structure.slugify('Netzzähler')).toBe('netzzaehler');
      expect(structure.slugify('Türöffner')).toBe('tueroeffner');
      expect(structure.slugify('Außentemperatur')).toBe('aussentemperatur');
      expect(structure.slugify('Kühlschränke')).toBe('kuehlschraenke');
    });

    it('returns "unknown" for empty string', () => {
      expect(structure.slugify('')).toBe('unknown');
    });

    it('trims leading and trailing hyphens', () => {
      expect(structure.slugify('--hello--')).toBe('hello');
    });

    it('collapses multiple hyphens', () => {
      expect(structure.slugify('a   b   c')).toBe('a-b-c');
    });
  });

  describe('buildMap', () => {
    beforeEach(() => {
      structure.buildMap(MOCK_LOXAPP3);
    });

    it('maps simple control with room to {prefix}/{room-slug}/{control-slug}', () => {
      const topic = structure.uuidToTopic('1a2b3c4d-0001-0002-ffff-aabbccddeeff');
      expect(topic).toBe('loxone/living-room/ceiling-light');
    });

    it('maps sub-control states to {prefix}/{room}/{control}/{stateKey}', () => {
      // activeMoods state of Light Controller
      const topic = structure.uuidToTopic('2a3b4c5d-1111-2222-ffff-aabbccddeeff');
      expect(topic).toBe('loxone/living-room/light-controller/activeMoods');
    });

    it('maps another sub-state', () => {
      const topic = structure.uuidToTopic('2a3b4c5d-3333-4444-ffff-aabbccddeeff');
      expect(topic).toBe('loxone/living-room/light-controller/moodList');
    });

    it('maps controls with no room to {prefix}/unknown/{control-slug}', () => {
      const topic = structure.uuidToTopic('4a5b6c7d-0001-0002-ffff-aabbccddeeff');
      expect(topic).toBe('loxone/unknown/orphan-sensor');
    });

    it('maps control state UUIDs for simple controls', () => {
      // "active" state of Ceiling Light
      const topic = structure.uuidToTopic('1a2b3c4d-1111-2222-ffff-aabbccddeeff');
      expect(topic).toBe('loxone/living-room/ceiling-light/active');
    });

    it('maps jalousie states correctly', () => {
      const posTopic = structure.uuidToTopic('3a4b5c6d-1111-2222-ffff-aabbccddeeff');
      expect(posTopic).toBe('loxone/bedroom/window-blind/position');
    });

    it('maps subControls under parent topic', () => {
      const topic = structure.uuidToTopic('2a3b4c5d-0001-0002-ffff-sub1sub1sub1');
      expect(topic).toBe('loxone/living-room/light-controller/mood-switch');
    });

    it('maps subControl state UUIDs', () => {
      const topic = structure.uuidToTopic('2a3b4c5d-0001-0002-ffff-sub1active01');
      expect(topic).toBe('loxone/living-room/light-controller/mood-switch/active');
    });
  });

  describe('uuidToTopic / topicToUuid', () => {
    beforeEach(() => {
      structure.buildMap(MOCK_LOXAPP3);
    });

    it('returns undefined for unknown UUID', () => {
      expect(structure.uuidToTopic('ffffffff-ffff-ffff-ffff-ffffffffffff')).toBeUndefined();
    });

    it('topicToUuid returns correct UUID for control-level topic', () => {
      const uuid = structure.topicToUuid('loxone/living-room/ceiling-light');
      expect(uuid).toBe('1a2b3c4d-0001-0002-ffff-aabbccddeeff');
    });

    it('topicToUuid returns undefined for unknown topic', () => {
      expect(structure.topicToUuid('loxone/nonexistent/thing')).toBeUndefined();
    });
  });

  describe('getMeta', () => {
    beforeEach(() => {
      structure.buildMap(MOCK_LOXAPP3);
    });

    it('returns metadata for known control UUID', () => {
      const meta = structure.getMeta('1a2b3c4d-0001-0002-ffff-aabbccddeeff');
      expect(meta).toEqual({
        topic: 'loxone/living-room/ceiling-light',
        name: 'Ceiling Light',
        type: 'Switch',
        room: 'Living Room',
        uuid: '1a2b3c4d-0001-0002-ffff-aabbccddeeff',
        category: 'Lighting',
      });
    });

    it('returns metadata with stateKey for state UUID', () => {
      const meta = structure.getMeta('1a2b3c4d-1111-2222-ffff-aabbccddeeff');
      expect(meta).toMatchObject({
        topic: 'loxone/living-room/ceiling-light/active',
        stateKey: 'active',
        uuid: '1a2b3c4d-1111-2222-ffff-aabbccddeeff',
      });
    });

    it('returns undefined for unknown UUID', () => {
      expect(structure.getMeta('ffffffff-ffff-ffff-ffff-ffffffffffff')).toBeUndefined();
    });
  });

  describe('getAll', () => {
    it('returns array of all control-level mappings', () => {
      structure.buildMap(MOCK_LOXAPP3);
      const all = structure.getAll();
      // 4 top-level controls + 1 subControl = at least 4 control-level entries
      expect(all.length).toBeGreaterThanOrEqual(4);
      expect(all.some((c) => c.name === 'Ceiling Light')).toBe(true);
      expect(all.some((c) => c.name === 'Window Blind')).toBe(true);
      expect(all.some((c) => c.name === 'Orphan Sensor')).toBe(true);
    });
  });

  describe('duplicate slug disambiguation', () => {
    it('appends UUID suffix for duplicate slugs in same room', () => {
      const dupeStructure = {
        rooms: {
          'room-uuid-0001-0002-ffff-aabbccddeeff': { name: 'Kitchen', uuid: 'room-uuid-0001-0002-ffff-aabbccddeeff' },
        },
        cats: {},
        controls: {
          'ctrl-aaaa-0001-0002-ffff-aabbccddeeff': {
            name: 'Light',
            type: 'Switch',
            uuidAction: 'ctrl-aaaa-0001-0002-ffff-aabbccddeeff',
            room: 'room-uuid-0001-0002-ffff-aabbccddeeff',
            cat: '',
            states: {},
            subControls: {},
          },
          'ctrl-bbbb-0001-0002-ffff-aabbccddeeff': {
            name: 'Light',
            type: 'Switch',
            uuidAction: 'ctrl-bbbb-0001-0002-ffff-aabbccddeeff',
            room: 'room-uuid-0001-0002-ffff-aabbccddeeff',
            cat: '',
            states: {},
            subControls: {},
          },
        },
      };

      structure.buildMap(dupeStructure);

      const topicA = structure.uuidToTopic('ctrl-aaaa-0001-0002-ffff-aabbccddeeff');
      const topicB = structure.uuidToTopic('ctrl-bbbb-0001-0002-ffff-aabbccddeeff');

      // Both should be different
      expect(topicA).not.toBe(topicB);
      // One keeps original, other gets disambiguated
      expect([topicA, topicB]).toContain('loxone/kitchen/light');
      const other = topicA === 'loxone/kitchen/light' ? topicB : topicA;
      expect(other).toMatch(/^loxone\/kitchen\/light-[a-z0-9]{8}$/);
    });
  });

  describe('fetchStructure', () => {
    it('fetches LoxAPP3.json via HTTP basic auth', async () => {
      const mockJson = { msInfo: {}, rooms: {}, cats: {}, controls: {} };
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockJson),
      });

      const result = await structure.fetchStructure('192.0.2.10', 80, 'admin', 'secret');

      const expectedAuth = Buffer.from('admin:secret').toString('base64');
      expect(global.fetch).toHaveBeenCalledWith(
        'http://192.0.2.10:80/data/LoxAPP3.json',
        { headers: { 'Authorization': `Basic ${expectedAuth}` } }
      );
      expect(result).toEqual(mockJson);

      delete global.fetch;
    });

    it('401 with "last edit of user" body → actionable permission hint', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: async () =>
          '<errortext>Unauthorized</errortext>' +
          '<description>last edit of user: 2026-05-20 23:48:00</description>',
      });

      let caught;
      try {
        await structure.fetchStructure('192.0.2.10', 80, 'lulu', 'pw');
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(Error);
      expect(caught.message).toContain('Webseite/Apps');
      expect(caught.message).toContain('Visualisierung');
      expect(caught.message).toContain('"lulu"');
      expect(caught.message).toContain('401 Unauthorized');

      delete global.fetch;
    });

    it('401 without "last edit of user" → wrong-credentials hint', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: async () => '<errortext>Unauthorized</errortext>',
      });

      let caught;
      try {
        await structure.fetchStructure('192.0.2.10', 80, 'lulu', 'pw');
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(Error);
      expect(caught.message).toContain('check username and password');
      expect(caught.message).toContain('"lulu"');
      // Must NOT carry the permission-specific advice
      expect(caught.message).not.toContain('Webseite/Apps');

      delete global.fetch;
    });

    it('empty username on 401 renders as "<empty>" placeholder', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: async () =>
          '<description>last edit of user: 2026-05-20</description>',
      });

      let caught;
      try {
        await structure.fetchStructure('192.0.2.10', 80, '', 'pw');
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(Error);
      expect(caught.message).toContain('"<empty>"');
      // Sanity: no bare `Loxone user ""` slipping through
      expect(caught.message).not.toMatch(/Loxone user ""\s/);

      delete global.fetch;
    });

    it('non-401 HTTP error falls through to the generic message', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Server Error',
        text: async () => '',
      });

      await expect(structure.fetchStructure('192.0.2.10', 80, 'admin', 'pw'))
        .rejects.toThrow('Failed to fetch LoxAPP3.json: 500 Server Error');

      delete global.fetch;
    });
  });
});
