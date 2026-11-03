import { html } from 'htm/preact';

export function StatusDot({ status }) {
  return html`<span class="status-dot status-dot--${status}"></span>`;
}
