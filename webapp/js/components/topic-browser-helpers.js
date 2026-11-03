/**
 * Pure helpers for the Topic Browser tree.
 *
 * Extracted from `topic-browser.js` so they can be unit-tested without
 * pulling in `htm/preact` (which is not a devDependency). The preact
 * component re-imports these names from `topic-browser.js`, which itself
 * re-exports from this module — runtime behavior is unchanged.
 */

export function buildTopicTree(topicMap) {
  const root = { children: {}, count: 0 };
  for (const [topic, data] of topicMap) {
    const parts = topic.split('/');
    let node = root;
    for (const part of parts) {
      if (!node.children[part]) {
        node.children[part] = { children: {}, count: 0, topic: null, value: null, payload: null, ts: null };
      }
      node = node.children[part];
    }
    node.topic = topic;
    node.value = data.value;
    node.payload = data.payload;
    node.ts = data.ts;
    root.count++;
  }
  return root;
}

export function autoExpandAll(tree, prefix = '') {
  const set = new Set();
  for (const [name, node] of Object.entries(tree.children)) {
    const path = prefix ? prefix + '/' + name : name;
    set.add(path);
    const sub = autoExpandAll(node, path);
    for (const s of sub) set.add(s);
  }
  return set;
}

// Always propagate the full slash-prefixed path to children. The previous
// implementation had a `depth === 0 ? childName` branch that dropped the
// parent prefix at the depth-0→1 boundary, which broke search-driven
// auto-expand for any leaf >2 levels deep (the keys produced here have to
// match the Set returned by `autoExpandAll`).
export function buildChildName(node, name, childName) {
  return node.topic ? node.topic + '/' + childName : name + '/' + childName;
}
