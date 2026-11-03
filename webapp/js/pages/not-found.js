import { html } from 'htm/preact';

export function NotFound() {
  return html`
    <div>
      <h1 class="page-header">Page Not Found</h1>
      <p class="page-placeholder">The page you're looking for doesn't exist.</p>
      <a href="#/dashboard" style="color: var(--ve-blue); text-decoration: none; margin-top: 12px; display: inline-block;">Go to Dashboard</a>
    </div>
  `;
}
