/**
 * plugins/lib/slug.js — slugify + macSlug tests (Phase 8-01 Task 1).
 *
 * Drives the implementation. `slugify` MUST be character-for-character
 * equivalent to LoxoneStructure.slugify so Loxone and UniFi produce identical
 * topic shapes for the same input (D-M-02). `macSlug` normalises MAC addresses
 * for use as topic segments (D-T-04 — `by-mac/{mac-with-dashes}`).
 */
import { describe, it, expect, test } from 'vitest';
import { slugify, macSlug } from '../../../plugins/lib/slug.js';
import { LoxoneStructure } from '../../../plugins/loxone/loxone-structure.js';

describe('slugify', () => {
  it('1.1 — slugify("Gateway1") → "gateway1"', () => {
    expect(slugify('Gateway1')).toBe('gateway1');
  });

  it('1.2 — German umlauts in mid-string: "Wohnzimmer Wärmepumpe" → "wohnzimmer-waermepumpe"', () => {
    expect(slugify('Wohnzimmer Wärmepumpe')).toBe('wohnzimmer-waermepumpe');
  });

  it('1.3 — All four umlauts: "ÄÖÜß" → "aeoeuess" (ä→ae, ö→oe, ü→ue, ß→ss)', () => {
    // Trace: "äöüß" → "aeöüß" → "aeoeüß" → "aeoeueß" → "aeoeuess"
    expect(slugify('ÄÖÜß')).toBe('aeoeuess');
  });

  it('1.4 — Non-alphanum collapsed: "Main / Switch #1" → "main-switch-1"', () => {
    expect(slugify('Main / Switch #1')).toBe('main-switch-1');
  });

  it('1.5 — Leading/trailing trim: "---abc---" → "abc"', () => {
    expect(slugify('---abc---')).toBe('abc');
  });

  it('1.6 — null → "unknown"', () => {
    expect(slugify(null)).toBe('unknown');
  });

  it('1.7 — "" → "unknown"', () => {
    expect(slugify('')).toBe('unknown');
  });

  it('1.8 — multi-dash collapse: "a--b--c" → "a-b-c"', () => {
    expect(slugify('a--b--c')).toBe('a-b-c');
  });

  it('1.9 — digits kept: "123" → "123"', () => {
    expect(slugify('123')).toBe('123');
  });

  // 1.10 — parameterised cross-check against LoxoneStructure.slugify.
  const lox = new LoxoneStructure();
  test.each([
    ['Gateway1'],
    ['Wärmepumpe'],
    ['Main / Switch #1'],
    ['a--b'],
    [''],
    ['ÄÖÜß'],
  ])('1.10 — slugify(%j) equals LoxoneStructure.slugify(%j)', (input) => {
    expect(slugify(input)).toBe(lox.slugify(input));
  });
});

describe('macSlug', () => {
  it('2.1 — colon form upper: "02:00:00:00:00:FA" → "02-00-00-00-00-fa"', () => {
    expect(macSlug('02:00:00:00:00:FA')).toBe('02-00-00-00-00-fa');
  });

  it('2.2 — already dash form idempotent: "02-00-00-00-00-fa" → "02-00-00-00-00-fa"', () => {
    expect(macSlug('02-00-00-00-00-fa')).toBe('02-00-00-00-00-fa');
  });

  it('2.3 — bare hex: "0200000000fa" → "02-00-00-00-00-fa"', () => {
    expect(macSlug('0200000000fa')).toBe('02-00-00-00-00-fa');
  });

  it('2.4 — non-hex rejected: "ZZ:ZZ:ZZ:ZZ:ZZ:ZZ" → "unknown-mac"', () => {
    expect(macSlug('ZZ:ZZ:ZZ:ZZ:ZZ:ZZ')).toBe('unknown-mac');
  });

  it('2.5 — null → "unknown-mac"', () => {
    expect(macSlug(null)).toBe('unknown-mac');
  });

  it('2.6 — empty string → "unknown-mac"', () => {
    expect(macSlug('')).toBe('unknown-mac');
  });

  it('2.7 — wrong length rejected: "1c:6a" → "unknown-mac"', () => {
    expect(macSlug('1c:6a')).toBe('unknown-mac');
  });
});
