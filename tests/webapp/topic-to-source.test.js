/**
 * Unit tests for webapp/js/lib/topic-to-source.js — quick 260521-bsh.
 *
 * Covers `topicToSource` and `isRawScalarPayload` after their extraction
 * from `webapp/js/pages/input-bindings.js`, with particular focus on the
 * two new safety branches (`noPayload`, `emptyJson`) that replace the
 * old `{ key: 'value', path: 'value' }` blind fallback — the wizard
 * footgun that produced unforwardable bindings on raw-scalar topics.
 */
import { describe, it, expect } from 'vitest';
import { topicToSource, isRawScalarPayload, detectSourceMode } from '../../webapp/js/lib/topic-to-source.js';

describe('topicToSource', () => {
  it('null payload → isRaw + noPayload flags', () => {
    const src = topicToSource('t/no-payload', null, null);
    expect(src.isRaw).toBe(true);
    expect(src.noPayload).toBe(true);
    expect(src.emptyJson).toBeUndefined();
    expect(src.fields).toHaveLength(1);
    expect(src.fields[0].isRaw).toBe(true);
    expect(src.fields[0].path).toBe('');
    expect(src.fields[0].key).toMatch(/no payload/i);
  });

  it('empty string payload → isRaw + noPayload flags', () => {
    const src = topicToSource('t/empty-string', '   ', null);
    expect(src.isRaw).toBe(true);
    expect(src.noPayload).toBe(true);
    expect(src.fields[0].path).toBe('');
  });

  it('raw scalar string "297" → isRaw, fields[0].path === ""', () => {
    const src = topicToSource('lulubude/CT200', '297', 12345);
    expect(src.isRaw).toBe(true);
    expect(src.noPayload).toBeUndefined();
    expect(src.emptyJson).toBeUndefined();
    expect(src.fields).toHaveLength(1);
    expect(src.fields[0].path).toBe('');
    expect(src.fields[0].sample).toBe(297);
    expect(src.fields[0].type).toBe('number');
  });

  it('raw scalar number 0 (zero) → isRaw, no false-negative', () => {
    // Regression guard: `0` is a valid scalar payload and must not be
    // mis-classified as "no payload" by a truthy-check.
    const src = topicToSource('t/motion', 0, 1);
    expect(src.isRaw).toBe(true);
    expect(src.noPayload).toBeUndefined();
    expect(src.fields[0].path).toBe('');
    expect(src.fields[0].sample).toBe(0);
    expect(src.fields[0].type).toBe('number');
  });

  it('JSON object {"value": 5} → JSON branch with picked field', () => {
    const src = topicToSource('t/json', '{"value": 5}', 1);
    expect(src.isRaw).toBeUndefined();
    expect(src.fields.length).toBeGreaterThanOrEqual(1);
    const valueField = src.fields.find(f => f.path === 'value');
    expect(valueField).toBeTruthy();
    expect(valueField.type).toBe('number');
    expect(valueField.sample).toBe(5);
  });

  it('JSON object with nested {"ENERGY": {"Power": 12}} → nested path', () => {
    const src = topicToSource('tele/tasmota/SENSOR', '{"ENERGY":{"Power":12}}', 1);
    expect(src.isRaw).toBeUndefined();
    const powerField = src.fields.find(f => f.path === 'ENERGY.Power');
    expect(powerField).toBeTruthy();
    expect(powerField.type).toBe('number');
    expect(powerField.sample).toBe(12);
  });

  it('JSON empty object {} → isRaw + emptyJson flags', () => {
    const src = topicToSource('t/empty-json', '{}', 1);
    expect(src.isRaw).toBe(true);
    expect(src.emptyJson).toBe(true);
    expect(src.noPayload).toBeUndefined();
    expect(src.fields).toHaveLength(1);
    expect(src.fields[0].path).toBe('');
    expect(src.fields[0].key).toMatch(/empty JSON/i);
    // Critically: the trap fallback `{ key: 'value', path: 'value' }` must
    // NOT show up here — that was the lulubude footgun.
    expect(src.fields[0].path).not.toBe('value');
    expect(src.fields[0].key).not.toBe('value');
  });

  it('JSON array [1,2,3] → isRaw (arrays are not object-shaped)', () => {
    const src = topicToSource('t/array', '[1,2,3]', 1);
    expect(src.isRaw).toBe(true);
    expect(src.fields[0].path).toBe('');
  });

  it('Invalid JSON "{foo" → isRaw (parse failure routes to raw)', () => {
    const src = topicToSource('t/broken', '{foo', 1);
    expect(src.isRaw).toBe(true);
    expect(src.fields[0].path).toBe('');
  });
});

describe('isRawScalarPayload', () => {
  it('null / undefined → true', () => {
    expect(isRawScalarPayload(null)).toBe(true);
    expect(isRawScalarPayload(undefined)).toBe(true);
  });

  it('bare strings and numbers → true', () => {
    expect(isRawScalarPayload('297')).toBe(true);
    expect(isRawScalarPayload('on')).toBe(true);
    expect(isRawScalarPayload(0)).toBe(true);
    expect(isRawScalarPayload(42)).toBe(true);
  });

  it('JSON arrays → true', () => {
    expect(isRawScalarPayload('[1,2,3]')).toBe(true);
    expect(isRawScalarPayload([1, 2, 3])).toBe(true);
  });

  it('JSON objects → false', () => {
    expect(isRawScalarPayload('{"a":1}')).toBe(false);
    expect(isRawScalarPayload({ a: 1 })).toBe(false);
  });

  it('malformed JSON object literal → true (falls back to raw)', () => {
    expect(isRawScalarPayload('{foo')).toBe(true);
  });
});

// Unit tests for detectSourceMode — quick 260528-4lf (auto source-mode default in new-binding wizard).
describe('detectSourceMode', () => {
  it("stat/POWER → 'event' (Tasmota stat tree, single-segment leaf)", () => {
    expect(detectSourceMode('stat/POWER')).toBe('event');
  });

  it("stat/wasserboiler/POWER1 → 'event' (multi-segment under stat/)", () => {
    expect(detectSourceMode('stat/wasserboiler/POWER1')).toBe('event');
  });

  it("tele/wasserboiler/SENSOR → 'cyclic' (Tasmota telemetry, periodic)", () => {
    expect(detectSourceMode('tele/wasserboiler/SENSOR')).toBe('cyclic');
  });

  it("loxone-gateway1/Wasserboiler/Temperature/state → 'cyclic' (our own bridge republishes periodically)", () => {
    expect(detectSourceMode('loxone-gateway1/Wasserboiler/Temperature/state')).toBe('cyclic');
  });

  it("inverter-proxy/device/abc/state → 'cyclic' (plain non-stat prefix)", () => {
    expect(detectSourceMode('inverter-proxy/device/abc/state')).toBe('cyclic');
  });

  it("'' (empty string) → 'cyclic' (safe default)", () => {
    expect(detectSourceMode('')).toBe('cyclic');
  });

  it("null → 'cyclic' (non-string input, must not throw)", () => {
    expect(detectSourceMode(null)).toBe('cyclic');
  });

  it("undefined → 'cyclic' (non-string input, must not throw)", () => {
    expect(detectSourceMode(undefined)).toBe('cyclic');
  });
});
