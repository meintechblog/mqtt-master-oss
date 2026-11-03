/**
 * plugins/unifi/unifi-structure.js — snapshot + diff tests (Phase 8-01 Task 2).
 *
 * MAC-keyed analogue of plugins/loxone/structure-monitor.js. Tests exercise
 * the diff classifier against a real UCG-MAX /stat/device probe and against
 * crafted in-memory edits (rename, add, remove, combined).
 *
 * Per D-S-01..D-S-03:
 *  - snapshotDevices keys by lowercase MAC
 *  - diffStructure classifies events as added / renamed / removed / unchanged
 *  - Renames detected via MAC stable identity + nameSlug change
 *  - Removals carry the PREV entry so callers can clear topics on the old slug
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { snapshotDevices, diffStructure } from '../../../plugins/unifi/unifi-structure.js';
import { slugify } from '../../../plugins/lib/slug.js';

const fixturePath = path.resolve(
  __dirname,
  '../../fixtures/unifi/stat-device-3devices.json',
);
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

// Convenience handles for the three known devices.
const ucgRaw = fixture.data.find((d) => d.type === 'udm');
const uswRaw = fixture.data.find((d) => d.type === 'usw');
const uapRaw = fixture.data.find((d) => d.type === 'uap');

describe('snapshotDevices', () => {
  it('Test 1 — builds a 3-entry snapshot from the real fixture, keyed by lowercase MAC', () => {
    const snapshot = snapshotDevices(fixture.data);
    expect(snapshot.size).toBe(3);

    // Each MAC appears as a lowercase key.
    const keys = [...snapshot.keys()];
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(3); // distinct
    for (const k of keys) {
      expect(k).toBe(k.toLowerCase());
    }

    // UCG-MAX entry shape.
    const ucg = snapshot.get(ucgRaw.mac.toLowerCase());
    expect(ucg).toBeDefined();
    expect(ucg.name).toBe(ucgRaw.name);
    expect(ucg.nameSlug).toBe(slugify(ucgRaw.name));
    expect(ucg.model).toBe('UCGMAX');
    expect(ucg.type).toBe('udm');
    expect(ucg.portCount).toBe(ucgRaw.port_table.length);

    // USPM16P: 18 ports (16 PoE + 2 SFP+).
    const usw = snapshot.get(uswRaw.mac.toLowerCase());
    expect(usw.portCount).toBe(18);

    // U6 Pro: type uap.
    const uap = snapshot.get(uapRaw.mac.toLowerCase());
    expect(uap.type).toBe('uap');
  });

  it('Test 2 — MAC normalisation: upper-case input → lower-case key', () => {
    const snapshot = snapshotDevices([
      { mac: '02:00:00:00:00:FA', name: 'X', model: 'M', type: 'usw', port_table: [] },
    ]);
    expect([...snapshot.keys()]).toContain('02:00:00:00:00:fa');
  });

  it('Test 3 — defensive handling of empty/null/missing-mac input', () => {
    expect(snapshotDevices([]).size).toBe(0);
    expect(snapshotDevices(null).size).toBe(0);
    expect(snapshotDevices(undefined).size).toBe(0);
    // Entry without mac is silently skipped (does not throw).
    const snap = snapshotDevices([{ name: 'orphan', type: 'usw' }]);
    expect(snap.size).toBe(0);
  });

  it('Test 4 — captures Mongo `_id` when present (needed for /rest/device/{_id} RMW)', () => {
    const snap = snapshotDevices([
      { _id: '5f0000000000000000000001', mac: '02:00:00:00:00:fa', name: 'Main', model: 'USPM16P', type: 'usw', port_table: [] },
      { mac: 'aa:bb:cc:dd:ee:ff', name: 'NoIdDevice', type: 'uap', port_table: [] }, // no _id
    ]);
    expect(snap.get('02:00:00:00:00:fa')._id).toBe('5f0000000000000000000001');
    expect(snap.get('aa:bb:cc:dd:ee:ff')._id).toBeNull();
  });
});

describe('diffStructure', () => {
  it('Test 4 — first call (prev=null) classifies all devices as added', () => {
    const next = snapshotDevices(fixture.data);
    const diff = diffStructure(null, next);
    expect(diff.added).toHaveLength(3);
    expect(diff.renamed).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.unchanged).toBe(0);
  });

  it('Test 5 — same snapshot vs itself: all unchanged, no diff entries', () => {
    const snapshot = snapshotDevices(fixture.data);
    const diff = diffStructure(snapshot, snapshot);
    expect(diff.added).toHaveLength(0);
    expect(diff.renamed).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.unchanged).toBe(3);
  });

  it('Test 6 — rename detection: same MAC, different name → renamed (oldNameSlug + newNameSlug carried)', () => {
    const prev = snapshotDevices(fixture.data);
    const cloned = JSON.parse(JSON.stringify(fixture.data));
    const u6Index = cloned.findIndex((d) => d.type === 'uap');
    const originalName = cloned[u6Index].name;
    cloned[u6Index].name = 'U6 Pro Renamed';
    const next = snapshotDevices(cloned);
    const diff = diffStructure(prev, next);

    expect(diff.renamed).toHaveLength(1);
    expect(diff.renamed[0].mac).toBe(uapRaw.mac.toLowerCase());
    expect(diff.renamed[0].oldNameSlug).toBe(slugify(originalName));
    expect(diff.renamed[0].newNameSlug).toBe('u6-pro-renamed');
    expect(diff.renamed[0].entry).toBeDefined();
    expect(diff.renamed[0].entry.name).toBe('U6 Pro Renamed');
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.unchanged).toBe(2);
  });

  it('Test 7 — addition: prev has 2, next has 3 → 1 added, 2 unchanged', () => {
    const prev = snapshotDevices(fixture.data.slice(0, 2));
    const next = snapshotDevices(fixture.data);
    const diff = diffStructure(prev, next);
    expect(diff.added).toHaveLength(1);
    expect(diff.removed).toHaveLength(0);
    expect(diff.unchanged).toBe(2);
  });

  it('Test 8 — removal: removed entries carry the PREV entry (so caller can retain-clear the old slug)', () => {
    const prev = snapshotDevices(fixture.data);
    const next = snapshotDevices(fixture.data.slice(0, 2));
    const diff = diffStructure(prev, next);

    expect(diff.removed).toHaveLength(1);
    // The dropped device is fixture.data[2] (whatever it happens to be).
    const droppedRaw = fixture.data[2];
    expect(diff.removed[0].mac).toBe(droppedRaw.mac.toLowerCase());
    // Removed entry must be the PREV snapshot's entry (carries the slug from prev).
    expect(diff.removed[0].nameSlug).toBe(slugify(droppedRaw.name));
  });

  it('Test 9 — combined: rename + add + remove in one diff', () => {
    // Build [A, B, C] → prev
    const A = { mac: 'aa:aa:aa:aa:aa:aa', name: 'AlphaName', model: 'M', type: 'usw', port_table: [] };
    const B = { mac: 'bb:bb:bb:bb:bb:bb', name: 'BetaName',  model: 'M', type: 'usw', port_table: [] };
    const C = { mac: 'cc:cc:cc:cc:cc:cc', name: 'GammaName', model: 'M', type: 'usw', port_table: [] };
    const prev = snapshotDevices([A, B, C]);

    // Next: A unchanged, B renamed, C removed, D added.
    const Brenamed = { ...B, name: 'BetaRenamed' };
    const D = { mac: 'dd:dd:dd:dd:dd:dd', name: 'DeltaName', model: 'M', type: 'usw', port_table: [] };
    const next = snapshotDevices([A, Brenamed, D]);

    const diff = diffStructure(prev, next);
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0].mac).toBe('dd:dd:dd:dd:dd:dd');
    expect(diff.renamed).toHaveLength(1);
    expect(diff.renamed[0].mac).toBe('bb:bb:bb:bb:bb:bb');
    expect(diff.renamed[0].oldNameSlug).toBe('betaname');
    expect(diff.renamed[0].newNameSlug).toBe('betarenamed');
    expect(diff.removed).toHaveLength(1);
    expect(diff.removed[0].mac).toBe('cc:cc:cc:cc:cc:cc');
    expect(diff.unchanged).toBe(1);
  });

  it('Test 10 — invariant: model-case change with same (mac, name) is unchanged, NOT renamed', () => {
    const A = { mac: 'aa:aa:aa:aa:aa:aa', name: 'X', model: 'UCGMAX', type: 'udm', port_table: [] };
    const Aprime = { ...A, model: 'ucgmax' }; // pure model case change
    const prev = snapshotDevices([A]);
    const next = snapshotDevices([Aprime]);
    const diff = diffStructure(prev, next);
    expect(diff.unchanged).toBe(1);
    expect(diff.renamed).toHaveLength(0);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
  });
});
