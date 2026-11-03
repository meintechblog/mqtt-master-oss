/**
 * Unit tests for webapp/js/lib/bindings-io.js — quick 260520-bei.
 *
 * Covers the pure-JS surface: validatePluginImport, validateAllImport,
 * buildPluginExport, buildAllExport, mergeBindingArrays. Browser I/O helpers
 * (downloadJson, pickJsonFile) are smoke-checked but the heavy lifting
 * happens in the manual smoke step in the SUMMARY.
 */
import { describe, it, expect } from 'vitest';
import {
  EXPORT_TYPE,
  EXPORT_VERSION,
  buildPluginExport,
  buildAllExport,
  validatePluginImport,
  validateAllImport,
  mergeBindingArrays,
  copyBindingArrays,
} from '../../webapp/js/lib/bindings-io.js';

describe('buildPluginExport', () => {
  it('produces a v1 file with scope=plugin and the supplied bindings', () => {
    const out = buildPluginExport({
      pluginId: 'gateway1',
      pluginType: 'loxone',
      displayName: 'Gateway1',
      bindings: [{ id: 'b1', mqttTopic: 't/1' }],
    });
    expect(out.type).toBe(EXPORT_TYPE);
    expect(out.version).toBe(EXPORT_VERSION);
    expect(out.scope).toBe('plugin');
    expect(out.pluginId).toBe('gateway1');
    expect(out.pluginType).toBe('loxone');
    expect(out.displayName).toBe('Gateway1');
    expect(out.bindings).toEqual([{ id: 'b1', mqttTopic: 't/1' }]);
    expect(typeof out.exportedAt).toBe('string');
    expect(out.exportedAt.length).toBeGreaterThan(0);
  });

  it('falls back to pluginId for displayName and [] for bindings when missing', () => {
    const out = buildPluginExport({ pluginId: 'venus' });
    expect(out.displayName).toBe('venus');
    expect(out.bindings).toEqual([]);
    expect(out.pluginType).toBeNull();
  });
});

describe('buildAllExport', () => {
  it('produces a v1 file with scope=all and the supplied plugins map', () => {
    const out = buildAllExport({
      plugins: {
        gateway1: { pluginType: 'loxone', displayName: 'Gateway1', bindings: [] },
      },
    });
    expect(out.type).toBe(EXPORT_TYPE);
    expect(out.version).toBe(EXPORT_VERSION);
    expect(out.scope).toBe('all');
    expect(out.plugins.gateway1.pluginType).toBe('loxone');
  });
});

describe('validatePluginImport', () => {
  it('rejects file without type/version', () => {
    const r1 = validatePluginImport({}, 'gateway1');
    expect(r1.ok).toBe(false);
    expect(r1.errors.length).toBeGreaterThan(0);

    const r2 = validatePluginImport({ type: 'something-else', version: 1, scope: 'plugin', bindings: [] }, 'gateway1');
    expect(r2.ok).toBe(false);
    expect(r2.errors.some(e => /file type/i.test(e))).toBe(true);

    const r3 = validatePluginImport({ type: EXPORT_TYPE, version: 99, scope: 'plugin', bindings: [] }, 'gateway1');
    expect(r3.ok).toBe(false);
    expect(r3.errors.some(e => /version/i.test(e))).toBe(true);

    const r4 = validatePluginImport({ type: EXPORT_TYPE, version: 1, scope: 'all' }, 'gateway1');
    expect(r4.ok).toBe(false);
    expect(r4.errors.some(e => /scope/i.test(e))).toBe(true);

    const r5 = validatePluginImport({ type: EXPORT_TYPE, version: 1, scope: 'plugin' }, 'gateway1');
    expect(r5.ok).toBe(false);
    expect(r5.errors.some(e => /bindings/i.test(e))).toBe(true);

    // null / non-object
    expect(validatePluginImport(null, 'x').ok).toBe(false);
    expect(validatePluginImport('not json', 'x').ok).toBe(false);
  });

  it('warns when pluginId differs but still returns bindings', () => {
    const payload = {
      type: EXPORT_TYPE,
      version: 1,
      scope: 'plugin',
      pluginId: 'venus',
      bindings: [{ id: 'b1', mqttTopic: 't/1' }],
    };
    const r = validatePluginImport(payload, 'gateway1');
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]).toMatch(/venus/);
    expect(r.warnings[0]).toMatch(/gateway1/);
    expect(r.bindings).toEqual(payload.bindings);
  });

  it('no warning when pluginId matches target', () => {
    const r = validatePluginImport({
      type: EXPORT_TYPE, version: 1, scope: 'plugin',
      pluginId: 'gateway1', bindings: [],
    }, 'gateway1');
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([]);
  });
});

describe('validateAllImport', () => {
  it('rejects file with wrong scope', () => {
    const r = validateAllImport({ type: EXPORT_TYPE, version: 1, scope: 'plugin', bindings: [] });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => /scope/i.test(e))).toBe(true);
  });

  it('accepts a valid all-scope file', () => {
    const r = validateAllImport({
      type: EXPORT_TYPE, version: 1, scope: 'all',
      plugins: { gateway1: { bindings: [] } },
    });
    expect(r.ok).toBe(true);
    expect(r.plugins.gateway1).toBeDefined();
  });
});

describe('mergeBindingArrays', () => {
  it('skips entries with duplicate id', () => {
    const existing = [
      { id: 'a1', mqttTopic: 't/old', jsonField: 'v', targetUuid: 'u1' },
    ];
    const incoming = [
      { id: 'a1', mqttTopic: 't/different', jsonField: 'v', targetUuid: 'u2' },
      { id: 'a2', mqttTopic: 't/new', jsonField: 'v', targetUuid: 'u3' },
    ];
    const { merged, skipped } = mergeBindingArrays(existing, incoming);
    expect(merged).toHaveLength(2);
    expect(merged[0].id).toBe('a1');
    expect(merged[0].mqttTopic).toBe('t/old'); // existing kept
    expect(merged[1].id).toBe('a2');
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toBe('duplicate_id');
    expect(skipped[0].binding.id).toBe('a1');
  });

  it('skips entries with same topic+field+uuid even if new id', () => {
    const existing = [
      { id: 'a1', mqttTopic: 't/1', jsonField: 'v', targetUuid: 'u1' },
    ];
    const incoming = [
      // fresh id but identical wiring → same target binding, skip
      { id: 'fresh-from-other-machine', mqttTopic: 't/1', jsonField: 'v', targetUuid: 'u1' },
    ];
    const { merged, skipped } = mergeBindingArrays(existing, incoming);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe('a1');
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toBe('duplicate_target');
  });

  it('appends genuinely new bindings', () => {
    const existing = [{ id: 'a1', mqttTopic: 't/1', jsonField: 'v', targetUuid: 'u1' }];
    const incoming = [
      { id: 'a2', mqttTopic: 't/2', jsonField: 'v', targetUuid: 'u2' },
      { id: 'a3', mqttTopic: 't/3', jsonField: '',  targetUuid: 'u3' },
    ];
    const { merged, skipped } = mergeBindingArrays(existing, incoming);
    expect(merged).toHaveLength(3);
    expect(merged.map(b => b.id)).toEqual(['a1', 'a2', 'a3']);
    expect(skipped).toEqual([]);
  });

  it('tolerates non-array inputs', () => {
    expect(mergeBindingArrays(null, null).merged).toEqual([]);
    expect(mergeBindingArrays(undefined, [{ id: 'x', mqttTopic: 't', jsonField: '', targetUuid: 'u' }]).merged)
      .toHaveLength(1);
    expect(mergeBindingArrays([], 'not-array').merged).toEqual([]);
  });
});

describe('copyBindingArrays', () => {
  it('appends every incoming binding — M onto N yields M+N', () => {
    const existing = [
      { id: 'a1', mqttTopic: 't/1', jsonField: 'v', targetUuid: 'u1', label: 'One' },
      { id: 'a2', mqttTopic: 't/2', jsonField: 'v', targetUuid: 'u2', label: 'Two' },
    ];
    const incoming = [
      { id: 'x1', mqttTopic: 't/3', jsonField: 'v', targetUuid: 'u3', label: 'Three' },
      { id: 'x2', mqttTopic: 't/4', jsonField: 'v', targetUuid: 'u4', label: 'Four' },
      { id: 'x3', mqttTopic: 't/5', jsonField: 'v', targetUuid: 'u5', label: 'Five' },
    ];
    const { merged } = copyBindingArrays(existing, incoming);
    expect(merged).toHaveLength(5);
  });

  it('never skips duplicates — duplicate id/triple is still appended', () => {
    const existing = [
      { id: 'a1', mqttTopic: 't/1', jsonField: 'v', targetUuid: 'u1', label: 'One' },
    ];
    const incoming = [
      // same id AND identical wiring as an existing binding
      { id: 'a1', mqttTopic: 't/1', jsonField: 'v', targetUuid: 'u1', label: 'One' },
    ];
    const { merged } = copyBindingArrays(existing, incoming);
    expect(merged).toHaveLength(2);
    // the appended clone must NOT carry the colliding id
    expect(merged[1].id).not.toBe('a1');
  });

  it('mints a unique id for every clone within the batch', () => {
    const incoming = Array.from({ length: 10 }, (_, i) => ({
      id: 'dup', mqttTopic: 't/x', jsonField: 'v', targetUuid: 'u', label: `L${i}`,
    }));
    const { merged } = copyBindingArrays([], incoming);
    expect(merged).toHaveLength(10);
    const ids = merged.map(b => b.id);
    expect(new Set(ids).size).toBe(10);
  });

  it('suffixes every clone label with " (copy)"', () => {
    const incoming = [
      { id: 'x1', mqttTopic: 't/1', jsonField: 'v', targetUuid: 'u1', label: 'Heating' },
      { id: 'x2', mqttTopic: 't/2', jsonField: 'v', targetUuid: 'u2', label: 'Cooling' },
    ];
    const { merged } = copyBindingArrays([], incoming);
    expect(merged[0].label).toBe('Heating (copy)');
    expect(merged[1].label).toBe('Cooling (copy)');
  });

  it('suffixes a label even when the incoming binding has none', () => {
    const incoming = [{ id: 'x1', mqttTopic: 't/1', jsonField: 'v', targetUuid: 'u1' }];
    const { merged } = copyBindingArrays([], incoming);
    expect(typeof merged[0].label).toBe('string');
    expect(merged[0].label.endsWith('(copy)')).toBe(true);
  });

  it('leaves existing bindings byte-identical', () => {
    const existing = [
      { id: 'a1', mqttTopic: 't/1', jsonField: 'v', targetUuid: 'u1', label: 'One' },
    ];
    const snapshot = JSON.parse(JSON.stringify(existing));
    const incoming = [{ id: 'x1', mqttTopic: 't/2', jsonField: 'v', targetUuid: 'u2', label: 'Two' }];
    const { merged } = copyBindingArrays(existing, incoming);
    expect(merged[0]).toEqual(snapshot[0]);
    // input array not mutated
    expect(existing).toEqual(snapshot);
    // input array not the same reference as merged
    expect(merged).not.toBe(existing);
  });

  it('does not mutate incoming binding objects', () => {
    const incoming = [{ id: 'x1', mqttTopic: 't/1', jsonField: 'v', targetUuid: 'u1', label: 'Two' }];
    const snapshot = JSON.parse(JSON.stringify(incoming));
    copyBindingArrays([], incoming);
    expect(incoming).toEqual(snapshot);
  });

  it('tolerates non-array inputs', () => {
    expect(copyBindingArrays(null, null).merged).toEqual([]);
    expect(copyBindingArrays(undefined, [{ id: 'x', mqttTopic: 't', jsonField: '', targetUuid: 'u', label: 'L' }]).merged)
      .toHaveLength(1);
    expect(copyBindingArrays([], 'not-array').merged).toEqual([]);
  });

  it('skips non-object incoming entries', () => {
    const incoming = [null, 42, { id: 'x1', mqttTopic: 't/1', jsonField: 'v', targetUuid: 'u1', label: 'L' }];
    const { merged } = copyBindingArrays([], incoming);
    expect(merged).toHaveLength(1);
  });
});
