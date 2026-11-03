import { html, render } from 'htm/preact';
import { signal, computed } from '@preact/signals';
import { Sidebar, menuOpen, toggleMenu } from './components/sidebar.js';
import { Hamburger } from './components/hamburger.js';
import { Dashboard } from './pages/dashboard.js';
import { Messages } from './pages/messages.js';
import { PluginConfig } from './pages/plugin-config.js';
import { LoxoneControls } from './pages/loxone-controls.js';
import { UnifiPorts } from './pages/unifi-ports.js';
import { UnifiWan } from './pages/unifi-wan.js';
import { UnifiClients } from './pages/unifi-clients.js';
import { InputBindings } from './pages/input-bindings.js';
import { BridgeElements } from './pages/bridge-elements.js';
import { MoodMappings } from './pages/mood-mappings.js';
import { NotFound } from './pages/not-found.js';
import { Docs } from './pages/docs.js';
import { Backup } from './pages/backup.js';
import { Bridges } from './pages/bridges.js';

const currentHash = signal(window.location.hash || '#/dashboard');

// Set default hash if none present
if (!window.location.hash) {
  window.location.hash = '#/dashboard';
}

/**
 * Global navigation guard. If set, called before hash navigation.
 * Return false to block the navigation.
 * @type {{ check: (() => boolean) | null }}
 */
export const navGuard = { check: null };

// Listen for hash changes (with navigation guard)
let lastHash = window.location.hash || '#/dashboard';
window.addEventListener('hashchange', () => {
  if (navGuard.check && !navGuard.check()) {
    // Block navigation — revert hash
    window.history.replaceState(null, '', lastHash);
    return;
  }
  lastHash = window.location.hash;
  currentHash.value = window.location.hash;
  menuOpen.value = false;
});

// Static route map
const routes = {
  '#/dashboard': Dashboard,
  '#/messages': Messages,
  '#/bridges': Bridges,
  '#/docs': Docs,
  '#/backup': Backup,
};

/**
 * Resolve route: static routes first, then #/plugins/:id pattern, then NotFound.
 * Returns { component, props } to support parameterized routes.
 */
const currentRoute = computed(() => {
  const hash = currentHash.value;

  // Static routes
  if (routes[hash]) {
    return { component: routes[hash], props: {} };
  }

  // Plugin sub-pages: #/plugins/:id/controls, #/plugins/:id/elements, #/plugins/:id/bindings
  const pluginSubMatch = hash.match(/^#\/plugins\/([^/]+)\/(\w+)$/);
  if (pluginSubMatch) {
    const [, pluginId, subPage] = pluginSubMatch;
    if (subPage === 'controls') {
      return { component: LoxoneControls, props: { pluginId } };
    }
    if (subPage === 'ports') {
      return { component: UnifiPorts, props: { pluginId } };
    }
    if (subPage === 'wan') {
      return { component: UnifiWan, props: { pluginId } };
    }
    if (subPage === 'clients') {
      return { component: UnifiClients, props: { pluginId } };
    }
    if (subPage === 'moods') {
      return { component: MoodMappings, props: { pluginId } };
    }
    if (subPage === 'elements') {
      return { component: BridgeElements, props: { pluginId } };
    }
    if (subPage === 'bindings') {
      return { component: InputBindings, props: { pluginId } };
    }
  }

  // Dynamic plugin route: #/plugins/:id
  if (hash.startsWith('#/plugins/')) {
    const pluginId = hash.slice('#/plugins/'.length);
    if (pluginId) {
      return { component: PluginConfig, props: { pluginId } };
    }
  }

  return { component: NotFound, props: {} };
});

function App() {
  const { component: Page, props } = currentRoute.value;
  return html`
    <${Hamburger} onClick=${toggleMenu} />
    <div class="app-layout">
      <${Sidebar} currentHash=${currentHash} />
      <main class="content">
        <${Page} ...${props} />
      </main>
    </div>
  `;
}

render(html`<${App} />`, document.getElementById('app'));
