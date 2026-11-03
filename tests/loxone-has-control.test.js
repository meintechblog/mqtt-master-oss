/**
 * hasControl() bestätigt nur Controls und Subcontrols der
 * geladenen Struktur – Grundlage für die UUID-Prüfung der Befehlsroute.
 */
import { describe, it, expect } from 'vitest';
import LoxonePlugin from '../plugins/loxone/plugin.js';

describe('LoxonePlugin.hasControl', () => {
  it('is false without a loaded structure', () => {
    const plugin = new LoxonePlugin();
    expect(plugin.hasControl('1a2b3c4d-0000-0000-ffff00000000c001')).toBe(false);
  });

  it('accepts controls and subcontrols, refuses everything else', () => {
    const plugin = new LoxonePlugin();
    plugin._structure = {
      getControlTree: () => [
        { uuid: 'aaaaaaaa-0000-0000-0000000000000001', subControls: [{ uuid: 'aaaaaaaa-0000-0000-0000000000000002' }] },
        { uuid: 'bbbbbbbb-0000-0000-0000000000000003', subControls: [] },
      ],
    };
    expect(plugin.hasControl('aaaaaaaa-0000-0000-0000000000000001')).toBe(true);
    expect(plugin.hasControl('aaaaaaaa-0000-0000-0000000000000002')).toBe(true);
    expect(plugin.hasControl('bbbbbbbb-0000-0000-0000000000000003')).toBe(true);
    expect(plugin.hasControl('cccccccc-0000-0000-0000000000000004')).toBe(false);
  });
});
