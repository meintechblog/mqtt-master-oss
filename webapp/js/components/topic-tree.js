import { html } from 'htm/preact';
import { useState } from 'preact/hooks';

function TreeNode({ name, node, depth, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen || false);

  // Leaf node: string or number value
  if (node === null || node === undefined || typeof node !== 'object') {
    return html`
      <div class="tree-node tree-leaf" style="padding-left: ${depth * 16}px">
        <span class="tree-toggle"></span>
        <span>${name}</span>
        <span class="tree-leaf-value">${String(node)}</span>
      </div>
    `;
  }

  // Branch node: object with children
  const keys = Object.keys(node);
  const toggle = () => setOpen(!open);

  return html`
    <div class="tree-node">
      <div class="tree-branch" style="padding-left: ${depth * 16}px" onClick=${toggle}>
        <span class="tree-toggle">${open ? '\u25BC' : '\u25B6'}</span>
        <span>${name}</span>
      </div>
      ${open && keys.map(key => html`
        <${TreeNode} key=${key} name=${key} node=${node[key]} depth=${depth + 1} defaultOpen=${false} />
      `)}
    </div>
  `;
}

export function TopicTree({ topics }) {
  if (!topics || Object.keys(topics).length === 0) {
    return html`
      <div class="ve-panel topic-tree">
        <div class="topic-tree-header">Topic Tree</div>
        <div class="tree-leaf" style="color: var(--ve-text-dim)">Waiting for data...</div>
      </div>
    `;
  }

  const keys = Object.keys(topics);
  return html`
    <div class="ve-panel topic-tree">
      <div class="topic-tree-header">Topic Tree</div>
      ${keys.map(key => html`
        <${TreeNode} key=${key} name=${key} node=${topics[key]} depth=${0} defaultOpen=${true} />
      `)}
    </div>
  `;
}
