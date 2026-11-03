/**
 * protected-ports invariant test — Phase 07-01 safety floor.
 *
 * Asserts the hardcoded controller-uplink allowlist ships in this plan so
 * Phase 9's PoE write path cannot accidentally omit it. See 07-CONTEXT.md
 * `<domain>` for the verbatim user-confirmed safety constraint and T-07-05
 * in the threat register.
 */
import { describe, it, expect } from 'vitest';
import { PROTECTED_PORTS, isProtectedPort } from '../../../plugins/unifi/protected-ports.js';

describe('PROTECTED_PORTS safety invariant', () => {
  it('exports a frozen array (mutation guard)', () => {
    expect(Array.isArray(PROTECTED_PORTS)).toBe(true);
    expect(Object.isFrozen(PROTECTED_PORTS)).toBe(true);
    expect(PROTECTED_PORTS.length).toBeGreaterThanOrEqual(1);
  });

  it('contains the Main switch dev-UDM port-1 entry verbatim (MAC 02:00:00:00:00:fa / port_idx 1)', () => {
    const main = PROTECTED_PORTS.find(p => p.mac === '02:00:00:00:00:fa' && p.port_idx === 1);
    expect(main).toBeDefined();
    expect(main.mac).toBe('02:00:00:00:00:fa');
    expect(main.port_idx).toBe(1);
    expect(typeof main.label).toBe('string');
    expect(main.label.length).toBeGreaterThan(0);
  });

  it('isProtectedPort matches MAC case-insensitively (UI may pass uppercase)', () => {
    expect(isProtectedPort('02:00:00:00:00:FA', 1)).toBe(true);
    expect(isProtectedPort('02:00:00:00:00:fa', 1)).toBe(true);
    expect(isProtectedPort('02:00:00:00:00:fa', 1)).toBe(true);
  });

  it('isProtectedPort returns false for unrelated MAC OR unrelated port_idx', () => {
    expect(isProtectedPort('02:00:00:00:00:fa', 2)).toBe(false);
    expect(isProtectedPort('02:00:00:00:00:fa', 16)).toBe(false);
    expect(isProtectedPort('ff:ff:ff:ff:ff:ff', 1)).toBe(false);
    expect(isProtectedPort('aa:bb:cc:dd:ee:ff', 99)).toBe(false);
    // Sanity: non-string / non-number inputs do not throw
    expect(isProtectedPort(null, 1)).toBe(false);
    expect(isProtectedPort('02:00:00:00:00:fa', 'one')).toBe(false);
  });
});
