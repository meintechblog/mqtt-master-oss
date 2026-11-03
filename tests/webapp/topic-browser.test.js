/**
 * Unit tests for the pure Topic Browser helpers — quick 260526-pwd.
 *
 * Locks in the search-driven auto-expand fix: every internal node along a
 * matching branch must be keyed by its full slash-prefixed path so the
 * recursion in `TopicNode` and the Set returned by `autoExpandAll` agree.
 */
import { describe, it, expect } from 'vitest';
import {
  buildTopicTree,
  autoExpandAll,
  buildChildName,
} from '../../webapp/js/components/topic-browser-helpers.js';

describe('buildTopicTree — 5-level topic shape', () => {
  it('places the full topic string on the deepest leaf', () => {
    const map = new Map([
      ['loxone-house1/room1/control1/value/state', { value: 1, payload: '1', ts: 1 }],
      ['loxone-house1/room1/control1/error/state', { value: 0, payload: '0', ts: 2 }],
    ]);
    const tree = buildTopicTree(map);
    const leaf = tree
      .children['loxone-house1']
      .children['room1']
      .children['control1']
      .children['value']
      .children['state'];
    expect(leaf.topic).toBe('loxone-house1/room1/control1/value/state');
  });
});

describe('autoExpandAll — full slash paths at every depth', () => {
  it('contains every internal node along both leaf branches', () => {
    const map = new Map([
      ['loxone-house1/room1/control1/value/state', { value: 1, payload: '1', ts: 1 }],
      ['loxone-house1/room1/control1/error/state', { value: 0, payload: '0', ts: 2 }],
    ]);
    const set = autoExpandAll(buildTopicTree(map));
    expect(set.has('loxone-house1')).toBe(true);
    expect(set.has('loxone-house1/room1')).toBe(true);
    expect(set.has('loxone-house1/room1/control1')).toBe(true);
    expect(set.has('loxone-house1/room1/control1/value')).toBe(true);
    expect(set.has('loxone-house1/room1/control1/error')).toBe(true);
  });
});

describe('buildChildName — regression lock for depth-0→1 prefix', () => {
  it('non-leaf parent: always returns name + "/" + childName (no depth special case)', () => {
    // THE regression-locking assertion: must NOT drop the parent prefix at depth 0.
    expect(buildChildName({ topic: null }, 'loxone-house1', 'room1'))
      .toBe('loxone-house1/room1');
  });

  it('deeper recursion: continues to chain slash-prefixed paths', () => {
    expect(buildChildName({ topic: null }, 'loxone-house1/room1', 'control1'))
      .toBe('loxone-house1/room1/control1');
  });

  it('leaf-with-children parent: uses node.topic as the prefix base', () => {
    expect(buildChildName({ topic: 'a/b' }, 'ignored', 'c')).toBe('a/b/c');
  });
});
