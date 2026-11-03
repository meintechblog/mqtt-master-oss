/**
 * Unit tests for webapp/js/lib/transform-utils.js — quick 260521-inv.
 *
 * Covers the additive `invert` arg on `previewTransform` and the new
 * `applyInvert` helper that mirrors the backend pipeline so the wizard's
 * Preview line matches what `applyBindings` will forward to Loxone.
 */
import { describe, it, expect } from 'vitest';
import { previewTransform, applyInvert } from '../../webapp/js/lib/transform-utils.js';

describe('previewTransform — invert composition', () => {
  it('previewTransform(340, "div1000", false) → "0.340" (unchanged baseline)', () => {
    expect(previewTransform(340, 'div1000', false)).toBe('0.340');
  });

  it('previewTransform(340, "div1000", true) → "-0.340" (× −1 after ÷1000)', () => {
    expect(previewTransform(340, 'div1000', true)).toBe('-0.340');
  });

  it('previewTransform(0.34, "", true) → "-0.34" (invert without transform)', () => {
    expect(previewTransform(0.34, '', true)).toBe('-0.34');
  });

  it('previewTransform(null, "", true) → "--" (non-numeric input short-circuits)', () => {
    expect(previewTransform(null, '', true)).toBe('--');
  });

  it('previewTransform(340, "div1000") with no invert arg → "0.340" (backwards compat)', () => {
    // Two-arg legacy callers must keep working without specifying invert.
    expect(previewTransform(340, 'div1000')).toBe('0.340');
  });

  it('previewTransform(10, "round1", true) → "-10.0" (preserves branch precision)', () => {
    expect(previewTransform(10, 'round1', true)).toBe('-10.0');
  });
});

describe('applyInvert — webapp mirror of backend helper', () => {
  it('flips positive finite number: 0.34 → -0.34', () => {
    expect(applyInvert(0.34, true)).toBe(-0.34);
  });

  it('invert=false is a no-op', () => {
    expect(applyInvert(0.34, false)).toBe(0.34);
  });

  it('non-numeric string "on" passes through unchanged', () => {
    expect(applyInvert('on', true)).toBe('on');
  });
});
