import { html } from 'htm/preact';

export function Hamburger({ onClick }) {
  return html`<button class="hamburger" onClick=${onClick} aria-label="Toggle menu">\u2630</button>`;
}
