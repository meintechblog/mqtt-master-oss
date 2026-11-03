import { html } from 'htm/preact';

export function StatCard({ label, value, unit }) {
  const display = value != null ? value : '--';
  return html`
    <div class="ve-card">
      <div class="stat-value">
        ${display}${unit ? html`<span class="stat-unit">${unit}</span>` : null}
      </div>
      <div class="stat-label">${label}</div>
    </div>
  `;
}
