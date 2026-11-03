import { html } from 'htm/preact';
import { useState } from 'preact/hooks';
import { copyToClipboard } from '../lib/clipboard.js';

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    copyToClipboard(text).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return html`
    <button class="docs-copy-btn" onClick=${handleCopy} title="Copy">
      ${copied ? 'Copied!' : 'Copy'}
    </button>
  `;
}

function CodeBlock({ code, lang }) {
  return html`
    <div class="docs-code-block">
      <${CopyButton} text=${code} />
      <pre><code>${code}</code></pre>
    </div>
  `;
}

function Section({ id, title, children }) {
  return html`
    <section class="docs-section" id=${id}>
      <h2 class="docs-section-title">${title}</h2>
      ${children}
    </section>
  `;
}

export function Docs() {
  return html`
    <div class="docs-page">
      <h1 class="page-header">Documentation</h1>
      <p class="docs-intro">
        MQTT Master is a real-time web dashboard for managing Mosquitto MQTT brokers and connected devices.
        It supports Loxone Miniservers, Venus OS (Victron), and custom MQTT bridges via a plugin system.
      </p>

      <!-- Table of contents -->
      <nav class="docs-toc">
        <div class="docs-toc-title">Contents</div>
        <a href="#install" class="docs-toc-link">Installation</a>
        <a href="#install-proxmox" class="docs-toc-link docs-toc-sub">Proxmox LXC</a>
        <a href="#install-debian" class="docs-toc-link docs-toc-sub">Debian / Ubuntu</a>
        <a href="#update" class="docs-toc-link">Updating</a>
        <a href="#auto-update" class="docs-toc-link docs-toc-sub">Auto-Update</a>
        <a href="#config" class="docs-toc-link">Configuration</a>
        <a href="#connection-info" class="docs-toc-link">Connection Info</a>
        <a href="#quickstart" class="docs-toc-link">Quick Start</a>
        <a href="#plugins" class="docs-toc-link">Plugins</a>
        <a href="#plugins-loxone" class="docs-toc-link docs-toc-sub">Loxone</a>
        <a href="#plugins-mqtt-bridge" class="docs-toc-link docs-toc-sub">MQTT Bridge</a>
        <a href="#bindings" class="docs-toc-link">Input Bindings</a>
        <a href="#mqtt" class="docs-toc-link">MQTT Topics</a>
        <a href="#api" class="docs-toc-link">REST API</a>
        <a href="#troubleshooting" class="docs-toc-link">Troubleshooting</a>
        <a href="#uninstall" class="docs-toc-link">Uninstall</a>
      </nav>

      <!-- Installation -->
      <${Section} id="install" title="Installation">
        <p>MQTT Master can be installed with a single command. Choose the method that fits your setup.</p>

        <h3 class="docs-h3" id="install-proxmox">Option 1: Proxmox LXC (recommended)</h3>
        <p>
          Run this on your <strong>Proxmox host</strong>. It automatically creates a Debian LXC container
          and installs everything inside — no manual container setup needed.
        </p>
        <${CodeBlock} code="wget -qO- https://raw.githubusercontent.com/meintechblog/mqtt-master-oss/main/install-lxc.sh | bash" />
        <p>You can customize the container with environment variables:</p>
        <${CodeBlock} code=${`CTID=200 CT_HOSTNAME=mqtt CT_MEMORY=1024 CT_DISK=8 \\
  wget -qO- https://raw.githubusercontent.com/meintechblog/mqtt-master-oss/main/install-lxc.sh | bash`} />

        <div class="docs-table-wrap">
          <table class="docs-table">
            <thead><tr><th>Variable</th><th>Default</th><th>Description</th></tr></thead>
            <tbody>
              <tr><td><code>CTID</code></td><td>next free</td><td>Container ID</td></tr>
              <tr><td><code>CT_HOSTNAME</code></td><td>mqtt-master</td><td>Container hostname</td></tr>
              <tr><td><code>CT_MEMORY</code></td><td>1024</td><td>RAM in MB</td></tr>
              <tr><td><code>CT_SWAP</code></td><td>512</td><td>Swap in MB</td></tr>
              <tr><td><code>CT_DISK</code></td><td>8</td><td>Disk size in GB</td></tr>
              <tr><td><code>CT_BRIDGE</code></td><td>vmbr0</td><td>Network bridge</td></tr>
              <tr><td><code>CT_STORAGE</code></td><td>local-lvm</td><td>Storage backend</td></tr>
            </tbody>
          </table>
        </div>

        <h3 class="docs-h3" id="install-debian">Option 2: Direct Install (Debian / Ubuntu)</h3>
        <p>Run this directly on a Debian 12+ or Ubuntu 22.04+ machine:</p>
        <${CodeBlock} code="wget -qO- https://raw.githubusercontent.com/meintechblog/mqtt-master-oss/main/install.sh | bash" />

        <div class="docs-callout docs-callout--info">
          <strong>Note:</strong> If you accidentally run this on a Proxmox host, it will detect PVE and
          abort with a hint to use the LXC installer instead.
        </div>

        <h3 class="docs-h3">What gets installed</h3>
        <ul class="docs-list">
          <li>Node.js 20 LTS</li>
          <li>Mosquitto MQTT broker (port 1883 + WebSocket 9001)</li>
          <li>MQTT Master as systemd service with auto-restart</li>
        </ul>
      </${Section}>

      <!-- Updating -->
      <${Section} id="update" title="Updating">
        <p>Run the same install command again. It detects the existing installation, pulls the latest code, and preserves your config:</p>
        <${CodeBlock} code="wget -qO- https://raw.githubusercontent.com/meintechblog/mqtt-master-oss/main/install.sh | bash" />
        <p>For Proxmox LXC containers, enter the container first:</p>
        <${CodeBlock} code=${`pct enter <CTID>
wget -qO- https://raw.githubusercontent.com/meintechblog/mqtt-master-oss/main/install.sh | bash`} />

        <h3 class="docs-h3" id="auto-update">Auto-Update</h3>
        <p>
          The Dashboard ships with an <strong>Auto-Update</strong> card next to Verbindungs-Info.
          MQTT Master polls <code>api.github.com/repos/meintechblog/mqtt-master-oss/commits/main</code>
          every 6 hours (with ETag-based conditional GETs, so it doesn't burn rate limit), shows the
          latest commit when an update is available. Nothing is installed from
          the UI or automatically: auto-apply was removed and the update API answers <code>403</code>.
          Updates are deployed by hand on the host.
        </p>
        <ul class="docs-list">
          <li><strong>Check now</strong> — force a fresh GitHub poll without applying.</li>
        </ul>
        <p>
          The actual update runs in a sibling <code>mqtt-master-updater.service</code> systemd unit
          so the <code>systemctl restart mqtt-master</code> in the middle of the pipeline cannot
          terminate the updater itself. Pipeline: preflight → <code>git fetch</code> →
          <code>git reset --hard</code> → <code>npm install</code> (skipped when no
          <code>package.json</code> / <code>package-lock.json</code> change) → systemd unit re-sync
          → restart → health-probe <code>/api/version</code> until it reports the new SHA.
          Any failure after <code>git fetch</code> triggers an automatic rollback to the previous SHA.
        </p>
        <p>Tail the journal during a manual run:</p>
        <${CodeBlock} code=${`journalctl -fu mqtt-master-updater`} />
      </${Section}>

      <!-- Configuration -->
      <${Section} id="config" title="Configuration">
        <p>The main configuration file is located at:</p>
        <${CodeBlock} code="/opt/mqtt-master/config.json" />
        <p>Default configuration:</p>
        <${CodeBlock} code=${`{
  "mqtt": { "broker": "mqtt://localhost:1883" },
  "web": { "port": 80 },
  "logLevel": "info"
}`} />

        <div class="docs-table-wrap">
          <table class="docs-table">
            <thead><tr><th>Setting</th><th>Default</th><th>Description</th></tr></thead>
            <tbody>
              <tr><td><code>mqtt.broker</code></td><td>mqtt://localhost:1883</td><td>MQTT broker connection URL</td></tr>
              <tr><td><code>web.port</code></td><td>80</td><td>Web dashboard port (HTTP)</td></tr>
              <tr><td><code>logLevel</code></td><td>info</td><td>Log level: debug, info, warn, error</td></tr>
            </tbody>
          </table>
        </div>

        <div class="docs-callout docs-callout--info">
          <strong>Migration:</strong> Older installations defaulted to port 3000. Re-running the
          installer migrates <code>web.port: 3000</code> to <code>80</code> automatically; any
          custom port (e.g. 8080) is preserved.
        </div>

        <p>After editing, restart the service:</p>
        <${CodeBlock} code="systemctl restart mqtt-master" />

        <h3 class="docs-h3">Service Management</h3>
        <${CodeBlock} code=${`systemctl status mqtt-master     # Check status
systemctl restart mqtt-master    # Restart
systemctl stop mqtt-master       # Stop
journalctl -u mqtt-master -f     # View live logs`} />
      </${Section}>

      <!-- Connection Info -->
      <${Section} id="connection-info" title="Connection Info">
        <p>
          The dashboard shows a <strong>Verbindungs-Info</strong> card at the top with all the
          addresses other devices on your LAN need:
        </p>
        <ul class="docs-list">
          <li><strong>Hostname</strong> — the friendly name of the host (e.g. <code>mqtt-master</code>)</li>
          <li><strong>Dashboard</strong> — the URL of this web UI (port 80 by default, no port shown)</li>
          <li><strong>MQTT-Broker</strong> — the TCP MQTT URL for native MQTT clients (port 1883)</li>
          <li><strong>MQTT WebSocket</strong> — the WebSocket URL for browser-based MQTT clients (port 9001)</li>
          <li><strong>LAN-IPs</strong> — every non-loopback IPv4 address bound on the host</li>
          <li><strong>Topic-Prefix</strong> — the prefix MQTT Master uses for its own topics</li>
        </ul>
        <p>Click any value to copy it to the clipboard.</p>

        <p>The same data is exposed as JSON for scripts and integrations:</p>
        <${CodeBlock} code="GET /api/system/info" />
        <${CodeBlock} code=${`{
  "hostname": "mqtt-master",
  "lanIps": [{ "iface": "eth0", "address": "192.0.2.10" }],
  "web": { "port": 80 },
  "mqtt": {
    "configuredUrl": "mqtt://localhost:1883",
    "protocol": "mqtt",
    "host": "localhost",
    "port": 1883,
    "websocketPort": 9001
  },
  "topicPrefix": "mqtt-master"
}`} />
      </${Section}>

      <!-- Quick Start -->
      <${Section} id="quickstart" title="Quick Start">
        <ol class="docs-list docs-list--ordered">
          <li>Open the dashboard at <code>http://&lt;server-ip&gt;</code></li>
          <li>Click the <strong>+</strong> button next to "Plugins" in the sidebar</li>
          <li>Choose a plugin type: <strong>Loxone</strong> or <strong>MQTT Bridge</strong></li>
          <li>Enter connection details and click <strong>Save</strong></li>
          <li>Click <strong>Start</strong> to connect the plugin</li>
        </ol>
      </${Section}>

      <!-- Plugins -->
      <${Section} id="plugins" title="Plugins">
        <p>MQTT Master uses a plugin system to connect to different devices and services.</p>

        <h3 class="docs-h3" id="plugins-loxone">Loxone</h3>
        <p>Connects to a Loxone Miniserver via WebSocket. All controls, rooms, and categories are auto-discovered.</p>
        <ul class="docs-list">
          <li><strong>Elements:</strong> Browse all controls with live values. Test commands, copy MQTT topics.</li>
          <li><strong>Mood Mapping:</strong> Map Loxone moods to MQTT topics for room-by-room scene control.</li>
          <li><strong>Input Bindings:</strong> Write MQTT values back to Loxone virtual inputs.</li>
        </ul>
        <div class="docs-callout docs-callout--info">
          <strong>Tip:</strong> All Loxone state changes are published in real-time via MQTT,
          so other systems (Home Assistant, Node-RED, etc.) can subscribe and react immediately.
        </div>

        <h3 class="docs-h3" id="plugins-mqtt-bridge">MQTT Bridge</h3>
        <p>Bridges a remote MQTT broker into your local Mosquitto. Useful for connecting Venus OS (Victron), Zigbee2MQTT, or any other MQTT-based system.</p>
        <ul class="docs-list">
          <li>Choose from presets (Venus OS, Zigbee2MQTT) or configure manually.</li>
          <li><strong>Elements:</strong> Browse all discovered topics from the remote broker with live values.</li>
          <li><strong>Input Bindings:</strong> Map local MQTT topics to remote broker commands.</li>
        </ul>
      </${Section}>

      <!-- MQTT Topics -->
      <${Section} id="bindings" title="Input Bindings">
        <p>
          Input Bindings push values from any MQTT topic into a target plugin's control —
          typically forwarding Tasmota / Venus OS / Shelly readings into Loxone Virtual
          Inputs. Open <code>#/plugins/&lt;plugin&gt;/bindings</code> on any running plugin
          and click <strong>+ New</strong> for the wizard.
        </p>
        <h3 class="docs-h3">The wizard (4 steps)</h3>
        <ol class="docs-list docs-list--ordered">
          <li><strong>Topic Browser</strong> — pick the source MQTT topic from a tree of every topic the broker has seen. Bound topics show a green ⇄ badge with the existing binding.</li>
          <li><strong>Field</strong> — pick which JSON path inside the payload to forward. Nested objects are flattened automatically (<code>ENERGY.Power</code>, <code>Wifi.RSSI</code>).</li>
          <li><strong>Target</strong> — pick a Loxone control to write to. Already-bound controls are greyed out.</li>
          <li><strong>Review</strong> — set the label, transform (<code>÷ 1000</code> for W → kW etc.), display unit, and keepalive. Save.</li>
        </ol>
        <h3 class="docs-h3">Live diagnostics on each card</h3>
        <p>The binding card is a 3-column flow: <strong>From MQTT → forwarded value → To Loxone</strong>:</p>
        <ul class="docs-list">
          <li>The middle pill shows the value our plugin most recently forwarded, with the chosen unit.</li>
          <li>"Loxone reports: X" on the right shows the current state Loxone broadcasts back, fetched in the same instant — drift between the two means another source on the Loxone side is overwriting our writes.</li>
          <li>Below the flow row a colour-coded diagnostic line shows forward count, last reason (<code>changed</code> / <code>keepalive</code> / <code>dedup</code>), and any send/parse error in red.</li>
        </ul>
        <div class="docs-callout docs-callout--info">
          <strong>Heads-up:</strong> <code>jdev/sps/io/&lt;uuid&gt;/&lt;value&gt;</code> only persists on
          writable controls (Virtual Inputs, Switches, push buttons, …). On read-only types like
          <code>InfoOnlyAnalog</code> Loxone accepts the request silently but reverts to its
          internal source — the binding card surfaces this as drift between "we sent" and
          "Loxone reports".
        </div>
      </${Section}>

      <${Section} id="mqtt" title="MQTT Topics">
        <p>MQTT Master publishes all data under structured topic hierarchies:</p>
        <${CodeBlock} code=${`# Loxone plugin
mqtt-master/<plugin-id>/status/<room>/<control>    # State values
mqtt-master/<plugin-id>/cmd/<control-uuid>          # Send commands

# MQTT Bridge
mqtt-master/<plugin-id>/bridge/<remote-topic>       # Bridged values`} />
        <p>Use the <strong>Live Messages</strong> page in the sidebar to explore all topics in real-time with wildcard subscriptions.</p>
      </${Section}>

      <!-- REST API -->
      <${Section} id="api" title="REST API">
        <div class="docs-table-wrap">
          <table class="docs-table">
            <thead><tr><th>Endpoint</th><th>Method</th><th>Description</th></tr></thead>
            <tbody>
              <tr><td><code>/api/plugins</code></td><td>GET</td><td>List all plugins with status</td></tr>
              <tr><td><code>/api/plugins/create</code></td><td>POST</td><td>Create a new plugin</td></tr>
              <tr><td><code>/api/plugins/:id</code></td><td>GET</td><td>Get plugin config</td></tr>
              <tr><td><code>/api/plugins/:id</code></td><td>PUT</td><td>Update plugin config</td></tr>
              <tr><td><code>/api/plugins/:id</code></td><td>DELETE</td><td>Delete a plugin</td></tr>
              <tr><td><code>/api/plugins/:id/start</code></td><td>POST</td><td>Start plugin</td></tr>
              <tr><td><code>/api/plugins/:id/stop</code></td><td>POST</td><td>Stop plugin</td></tr>
              <tr><td><code>/api/plugins/:id/bindings</code></td><td>GET / PUT</td><td>List / replace input bindings</td></tr>
              <tr><td><code>/api/plugins/:id/bindings/stats</code></td><td>GET</td><td>Live per-binding stats (value, sendCount, lastError, loxoneValue)</td></tr>
              <tr><td><code>/api/bindings</code></td><td>GET</td><td>Flat list of all bindings across plugins</td></tr>
              <tr><td><code>/api/mqtt/topics</code></td><td>GET</td><td>Search the topic-cache (every topic since startup). Filters: <code>?q=</code> substring, <code>?regex=</code> JS regex, <code>?filter=</code> MQTT wildcard (+/#); <code>?limit=</code> (default 500), <code>?values=false</code> to drop payloads, <code>?envelope=true</code> to wrap. Returns a flat array of <code>{topic,payload,retained,ts,ageMs,count}</code> (newest first), or <code>{count,total,topics:[…]}</code> with <code>?envelope=true</code></td></tr>
              <tr><td><code>/api/mqtt/publish</code></td><td>POST</td><td>Publish a message to the broker</td></tr>
              <tr><td><code>/api/discovery/loxone</code></td><td>POST</td><td>Scan LAN for Loxone Miniservers (UDP+HTTP)</td></tr>
              <tr><td><code>/api/system/info</code></td><td>GET</td><td>Hostname, LAN IPs, broker URLs</td></tr>
              <tr><td><code>/api/version</code></td><td>GET</td><td>Running git SHA, tag, dirty flag — used by the updater health probe</td></tr>
              <tr><td><code>/api/update/status</code></td><td>GET</td><td>Current version + GitHub-poll state (autoApply is always false)</td></tr>
              <tr><td><code>/api/update/check</code></td><td>POST</td><td>Force a fresh GitHub /commits/main poll</td></tr>
              <tr><td><code>/api/update/run</code></td><td>POST</td><td>Disabled (403 update_api_disabled)</td></tr>
              <tr><td><code>/api/update/log?lines=N</code></td><td>GET</td><td>Last N journalctl lines from mqtt-master-updater</td></tr>
              <tr><td><code>/api/update/settings</code></td><td>PUT</td><td>Disabled (403 update_api_disabled)</td></tr>
            </tbody>
          </table>
        </div>
      </${Section}>

      <!-- Troubleshooting -->
      <${Section} id="troubleshooting" title="Troubleshooting">
        <h3 class="docs-h3">Service won't start</h3>
        <${CodeBlock} code=${`journalctl -u mqtt-master --no-pager -n 50
systemctl status mqtt-master`} />

        <h3 class="docs-h3">MQTT broker not reachable</h3>
        <${CodeBlock} code=${`systemctl status mosquitto
mosquitto_sub -t '#' -v    # Test broker locally`} />

        <h3 class="docs-h3">Port already in use</h3>
        <p>Edit <code>/opt/mqtt-master/config.json</code> and change <code>web.port</code>, then restart.</p>

        <h3 class="docs-h3">Loxone plugin shows "error"</h3>
        <ul class="docs-list">
          <li>Check that the Miniserver IP, port, user, and password are correct.</li>
          <li>Ensure the Miniserver is reachable from the MQTT Master machine.</li>
          <li>Check logs: <code>journalctl -u mqtt-master -f</code></li>
        </ul>
      </${Section}>

      <!-- Uninstall -->
      <${Section} id="uninstall" title="Uninstall">
        <h3 class="docs-h3">Direct installation</h3>
        <${CodeBlock} code=${`systemctl stop mqtt-master
systemctl disable mqtt-master
rm /etc/systemd/system/mqtt-master.service
systemctl daemon-reload
rm -rf /opt/mqtt-master
userdel mqtt-master`} />

        <h3 class="docs-h3">Proxmox LXC container</h3>
        <${CodeBlock} code=${`pct stop <CTID>
pct destroy <CTID>`} />
      </${Section}>

      <div class="docs-footer">
        <a href="https://github.com/meintechblog/mqtt-master-oss" target="_blank" rel="noopener" class="docs-footer-link">
          GitHub Repository
        </a>
      </div>
    </div>
  `;
}
