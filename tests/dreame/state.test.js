import { describe, it, expect } from 'vitest';
import { mapState, STATE_MAP, ZUSTAENDE } from '../../plugins/dreame/dreame-state.js';

describe('Dreame state mapping', () => {
  it('maps the documented Dreame state codes to the plan vocabulary', () => {
    const table = {
      1: 'reinigt', 7: 'reinigt', 12: 'reinigt', 25: 'reinigt', 27: 'reinigt',
      3: 'pausiert', 21: 'pausiert',
      5: 'zurueck', 10: 'zurueck', 17: 'zurueck', 18: 'zurueck', 28: 'zurueck',
      8: 'station', 9: 'station', 22: 'station', 30: 'station', 35: 'station',
      6: 'laedt', 13: 'laedt', 24: 'laedt',
      4: 'fehler',
    };
    for (const [code, expected] of Object.entries(table)) {
      expect(mapState(Number(code), 0), `code ${code}`).toBe(expected);
    }
  });

  it('only ever yields vocabulary values', () => {
    for (const code of Object.keys(STATE_MAP)) {
      expect(ZUSTAENDE).toContain(mapState(Number(code), 0));
    }
  });

  it('returns unbekannt for unknown, idle, missing or non-numeric codes', () => {
    expect(mapState(999, 0)).toBe('unbekannt');
    expect(mapState(2, 0)).toBe('unbekannt');
    expect(mapState(undefined, 0)).toBe('unbekannt');
    expect(mapState(null, 0)).toBe('unbekannt');
    expect(mapState('abc', 0)).toBe('unbekannt');
  });

  it('accepts numeric strings', () => {
    expect(mapState('1', 0)).toBe('reinigt');
  });

  it('reports fehler for state 4 regardless of the error code', () => {
    expect(mapState(4, 0)).toBe('fehler');
    expect(mapState(4, 12)).toBe('fehler');
  });

  it('keeps the robot state when a non-zero error code accompanies a non-error state', () => {
    // unbelegt on real devices: error code can linger while state already moved on.
    expect(mapState(6, 12)).toBe('laedt');
  });
});
