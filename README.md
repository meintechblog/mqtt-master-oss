# MQTT Master

A self-hosted MQTT broker dashboard and smart home bridge for Debian/Ubuntu.

MQTT Master provides a real-time web interface for monitoring your Mosquitto MQTT broker and bridges non-MQTT smart home systems into MQTT through an extensible plugin architecture.

## Features

### Dashboard
- Real-time metrics with sparkline trend charts (receive/send rate, clients, uptime)
- Live activity bar showing IN/OUT message throughput
- **Verbindungs-Info card**: hostname, LAN IPs, MQTT broker URL (`mqtt://…:1883`), MQTT WebSocket URL (`ws://…:9001`), and topic prefix — all click-to-copy
- **Update card**: running version, last GitHub poll, "Check now" button (updates are never installed from the UI)
- Plugin overview with status indicators and message counts
- Auto-updating every 2 seconds

### Update check (no auto-apply)
- Periodic GitHub poll (every 6 h, ETag-based conditional GET — no rate-limit churn); the Dashboard shows whether a newer main exists
- **No remote updates:** the service never installs anything by itself, and `POST /api/update/run` / `PUT /api/update/settings` answer `403 update_api_disabled`. Updates are deployed by hand on the host.
- The pipeline script (`mqtt-master-updater.service`: preflight → `git fetch` → `git reset --hard` → `npm install` → unit re-sync → restart → health-probe `/api/version`, rollback on failure) stays available for a manual run on the host

### Live Messages
- **Stream view**: subscribe to topic patterns, watch messages flow in real-time with filtering
- **Topic Browser**: server-side cache of every topic seen since startup (decoupled from slow republish cadences like Tasmota's 5-min `tele/.../STATE`), live updates over WebSocket, search filter, click-to-copy values
- **Bound-topic markers**: topics that already have an input binding are tinted green with a ⇄ badge listing every binding (plugin, label, jsonField) that targets them
- **Inline binding creation**: click any topic → Create-Binding dialog with live JSON-field picker (auto-flattens nested objects like `ENERGY.Power`, `Wifi.RSSI`), live preview of the selected field including transform output

### Plugin System
- Add/remove plugins from the web UI (no filesystem access needed)
- **Presets**: pre-configured templates for common devices (e.g. Venus OS)
- Custom display names per plugin instance
- Multiple instances of the same plugin type (e.g. two Loxone Miniservers)
- Plugin templates: Loxone, MQTT-Bridge (extensible)
- Connection status indicators (green/orange/red dots)
- Message rate display per plugin
- Auto-start: plugins restart automatically on server reboot
- **Topic-prefix visible per entry**: each plugin in the sidebar shows its MQTT topic root (e.g. `loxone-house1/`) as a monospaced third line — click to copy
- **Config change auto-applies**: PUT `/api/plugins/:id/config` (or saving from the UI) now reloads a running plugin so prefix / IP / port / credential changes take effect immediately — no manual restart

### Loxone Miniserver Bridge
- **Network discovery**: scan the LAN for Miniservers via UDP broadcast (port 7777) AND HTTP fan-out on `/jdev/cfg/api`. Click a result to fill IP/port into the plugin config.
- Bidirectional bridge with auto-discovery from LoxAPP3.json
- Human-readable MQTT topics: `loxone/{room}/{control}/state`
- **UUID-based stable topics**: `loxone/by-uuid/{uuid}/cmd` — survive control renames in Loxone Config
- Proper German umlaut handling: ä→ae, ö→oe, ü→ue, ß→ss
- Token-based authentication (firmware v16.x)
- **Elements page** with live values, copy-to-clipboard on all topics, search/filter
- **Inline command testing**: dropdown with all available commands per control type, instant trigger
  - Switch: On, Off, Pulse
  - Dimmer: On, Off, +, −
  - LightControllerV2: Stimmung +/−, changeTo/{name}, On, Off
  - Jalousie: Up, Down, Full Up/Down, Stop
  - Gate, Alarm, IRoomController, Ventilation: type-specific commands
- **Mood Mapping** for LightControllerV2: configurable mood ID → name resolution
  - Fixed grid of all 35 mood slots (IDs -1, 1-31, 777, 778) — just fill in names
  - Locked system moods: Manuell (-1), Viel Licht (777), Aus (778)
  - Default mappings (Nacht, Abend, Tag) + per-controller overrides via web UI
  - `changeTo/{name}` commands auto-translated to IDs (e.g. changeTo/Evening → changeTo/31)
  - Active mood name published as `loxone/{room}/{control}/mood/state`
  - Unsaved changes warning on navigation with Save/Discard buttons
- Direction indicators showing data flow (outgoing/incoming)
- Structure change detection (auto-cleanup on rename/remove)
- **Structure Inspector**: per-plugin debug card on the detail page with type/room/category counts, "ohne Raum"/"ohne Kategorie" warning chips, and a manual `Refresh` button — verify after every "In Miniserver speichern" what the Miniserver actually exports without trawling logs (`GET /api/plugins/:id/structure/raw`, `POST /api/plugins/:id/structure/refresh`)
- Self-healing reconnect chain: keeps retrying with exponential backoff even when the Miniserver returns HTML during a Save/reboot cycle (no more stuck-at-`totalReconnects:0` after a config push)
- **Retained state publishes + heartbeat republish**: every state topic is published with `retain: true` so subscribers see the last value immediately on connect — and the cached state is re-published every `republishIntervalSec` seconds (default 60, set 0 to disable) so HA/Grafana keep getting fresh timestamps even when a value is constant
- Home Assistant auto-detection via MQTT Discovery
- Grouped by category and room with search/filter

### UniFi Network Bridge (v1.1)
Bidirectional UniFi-controller integration over the documented Network HTTPS API. Targets UniFi-OS hardware (UDM / UDR / UCG / UCG-Max) with managed PoE switches and APs downstream.

- **Auth foundation**: local-only admin user (cookie session + CSRF rotation), `rememberMe: true` for 30-day tokens, retry-once-on-401 (no infinite re-auth loops per HA-known footgun), 2FA fail-fast with a clear `2FA admin not supported — create a local-only admin` status, JSON-content-type gate to survive controller reboots, self-signed cert accepted by default
- **Test Connection button** in the config form — probes login + controller name without persisting credentials. Shows SSO-account warning when the supplied user isn't local-only.
- **Multi-state status surface**: `connecting / connected / refreshing / auth_failed / network_down / session_expired_recovering` substates published in `getStatus()`; sidebar dot remains the existing 3-state (additive, non-breaking)
- **Auto-discovery** of all adopted devices (UDM gateway, USW PoE switches, UAP access points) via `/stat/device` polling — no manual mapping. MAC is the stable identity; human-readable slug is a secondary topic name that survives renames via a parallel `unifi/by-mac/{mac}/…` namespace (mirrors Loxone's `by-uuid/`)
- **Per-port telemetry** published as retained JSON on `unifi/{instance}/{device-slug}/port/{idx}/state`: `poe_mode`, `poe_power_w`, `poe_voltage_v`, `poe_current_ma`, `rx_bytes` / `tx_bytes`, `rx_rate_kbps` / `tx_rate_kbps`, `link_up`, `link_speed_mbps`, `full_duplex`, `link_down_count`, `connected_device` (LLDP-first, sta-list fallback) plus a structured `connected_device_detail` object with `{name, mac, ip, hostname, vlan, last_seen}`
- **Per-device telemetry**: `ip`, `cpu_pct`, `mem_pct`, `temperature_c`, `total_used_power_w`, `num_clients`, `overheating`, total rx/tx bytes
- **Site-level health rollup** at `{prefix}site/health` — `{wlan, wan, lan, www, vpn}` subsystem status chips
- **WAN telemetry per gateway**: `{prefix}{gateway}/wan/{1,2}/state` with `interface`, `up`, `ip`, `netmask`, `gateway_ip`, `latency_ms`, `availability_pct`, `max_speed_mbps`, `link_speed_mbps`, throughput, packet/error counters. Plus `{prefix}{gateway}/wan/isp/state` with `isp_name`, `isp_organization`, `asn`, `public_ip` (updated every 10th poll, low churn)
- **PoE switching via MQTT**: publish `on` / `off` / `cycle` to `unifi/.../port/{idx}/cmd` — both slug-based and by-mac namespaces route to the same handler. Results published non-retained on `…/result` with status enum (`ok | protected_port | rate_limited | read_failed | unknown_device | not_poe_capable | not_connected`)
- **Speedtest trigger**: publish `speedtest` to `{prefix}{gateway}/wan/cmd` — controller-native, rate-limited to 1 per 5 min per gateway
- **Read-modify-write safety** on `port_overrides`: every write reads the full current array, merges the target port, sends the entire array back — under a per-device in-process mutex. Prevents the HA #18267 partial-write footgun where two simultaneous PUTs each overwrite the other's overrides
- **`cycle` is the controller-native command** (`POST /cmd/devmgr {cmd:"power-cycle"}`) — NEVER decomposed into client-side off → sleep → on, so a network blip mid-sequence can't leave the port stuck off
- **Per-port cycle rate-limit** (10s default, configurable) — protects 802.3af PD recovery time, prevents button-mashing storms
- **Hardcoded protected-port allowlist** + LLDP-augmented runtime list: the controller-uplink port (where the UDM connects to its first downstream switch) refuses `off` and `cycle` from both MQTT and UI alike. Even forcing a click in DevTools triggers a JS-layer short-circuit before the publish. `on` is always allowed (recovery action)
- **`dryRun` mode** (default ON for v1.1 dev cycle) logs commands without executing — flip to OFF after E2E validation
- **Wireless + wired client tracking** (Phase 14): per-client MQTT state at `{prefix}clients/by-mac/{mac-slug}/state` with hostname, name (cross-joined from `/rest/user` friendly names), IP, SSID, AP MAC + name, signal RSSI, radio protocol (ac/ax/n/g), channel, tx/rx rates, vendor (OUI lookup + `dev_vendor` fingerprint), OS family, VLAN, network name. Aggregate publish on `{prefix}clients/summary` with totals by SSID/AP. Presence state machine: clients absent ≥ 5 min transition `home` → `not_home` (retained), absent ≥ 24h get retain-cleared
- **Plugin detail page UI** in the Venus-OS dark theme with three sub-tabs:
  - **Ports** — device list with PoE-on / port-counts, per-device port grid with live wattage badges (green / amber / red thresholds), inline `On` / `Off` / `Cycle` buttons (Off shows a confirmation dialog naming the connected device, Cycle does not — self-recovers in seconds), protected-port lock icon + tooltip, filter row (`has-PoE` / `link-up` / `PoE-on` / free-text search across name + connected-device hostname), structure inspector card with refresh button
  - **WAN** — ISP card (name, organization, ASN, public IP, latency), live throughput card with sparkline-style updates, speedtest card (last-run timestamp + download/upload Mbps + ping ms + Run-speedtest button), failover card (shown when WAN2 exists), site-health chip rollup
  - **Clients** — summary chips (total / wireless / wired / SSIDs / home / not_home), filter row (search across hostname/name/MAC/IP, SSID/AP/wired-wireless/state dropdowns, vendor multi-select), client table with state-dot + connection summary (`wired Sw:port` or `wifi SSID @ AP / ch / -67 dBm`), row-click detail drawer with copy-MAC button
- **Home Assistant MQTT Discovery**:
  - **Per port** — `switch` (PoE on/off via the cmd topic, with `value_template` extracting `poe_mode == 'auto'`), `button` (cycle, `device_class: restart`), `sensor` entities for power (W) / voltage (V) / current (mA) / link-speed (Mbit/s) / rx-rate / tx-rate / link-down-count, `binary_sensor` (connectivity)
  - **Per device** — one HA device card (identified by `unifi_{instanceId}_{mac}` so multiple plugin instances don't collide), `via_device: mqtt-master`
  - **Per gateway** — 10 WAN diagnostic sensors: `public_ip`, `latency_ms`, `rx_rate`, `tx_rate`, `isp_name`, `uptime_sec`, `speedtest_download_mbps` / `_upload_mbps` / `_ping_ms`, plus the speedtest `button` (restart-class)
  - **Per client** — `device_tracker` entity (state `home`/`not_home`, `source_type: router`, default disabled in HA so 26 known-device entries don't auto-clutter — user enables specific MACs like their iPhone for presence automations), plus per-client `signal_dbm` and `last_seen` sensors
- **Multiple UniFi instances** side-by-side (e.g. dev UDM + prod UDM) — instance-aware `unique_id` segments and `device.identifiers` ensure HA shows them as separate device cards even when both point at the same hardware MAC
- **Test fixtures** captured from real UCG-MAX probes (UniFi-OS 5.1.11) so unit tests run against realistic JSON shapes — CSRF rotation, rate-limit error codes, MFA cookies, `cmd/devmgr UnknownDevice` error shape, full 3-device site (gateway + 16-port PoE switch + AP)

### MQTT-Bridge (External Broker)
- Connect to any external MQTT broker
- **Venus OS preset**: pre-configured topic filter (`N/#`), local prefix, keepalive
- Auto-detects Venus OS portal ID
- Smart republishing: only forwards changed values, 30s keepalive for unchanged
- Bare IP auto-fix: entering `192.0.2.100` automatically becomes `mqtt://192.0.2.100:1883`
- Elements page with collapsible category tree and live values

### Input Bindings
- Feed external MQTT data into plugin controls (typically: forward Tasmota / Venus OS / Shelly readings into Loxone Virtual Inputs)
- 4-step guided wizard: Topic Browser → Pick field (with nested-path support) → Select target → Configure
- Smart throttling: instant on value change, configurable keepalive
- Auto-suggest transforms (e.g. W → kW) and units (°C, %, kW, V, A, …) based on the field name
- 32 standard units selectable per binding for human readability (display-only, doesn't affect what's sent)
- Per-plugin binding storage
- Already-bound targets greyed out to prevent duplicates
- Editable: label, transform, unit, keepalive on existing bindings
- **Live diagnostics per binding**: 3-column card (FROM MQTT → forwarded VALUE → TO Loxone) showing the value being pushed in real-time, plus what Loxone reports back from the same instant — surfaces silent dead-ends like read-only InfoOnlyAnalog targets immediately
- **Connection lifecycle logging**: every Loxone connect/disconnect/reconnect with code, session duration, and backoff delay lands in `journalctl -u mqtt-master`
- **Raw scalar payload support**: bindings whose source topic publishes a bare value (e.g. Tasmota motion sensors publishing `0`/`1` on `stat/.../Bewegungsmelder`) work without needing JSON — leave the JSON-field empty
- **Smart UI auto-detect**: when you pick a topic during binding creation, the form previews the cached retained payload and switches to "Roh-Payload erkannt — wird direkt übernommen" for scalar topics; JSON topics still get the field picker. Manual override checkbox available.
- **Timer-driven heartbeat per binding**: in addition to value-change forwarding, each binding has its own `setInterval` that re-sends the cached value every `keepaliveMs` (default 30s, set `0` to disable). Lets Loxone-side watchdogs detect a dead bridge even when the source sensor only publishes on transitions.
- **Export / Import per plugin**: download a plugin's bindings as JSON via the `↓ Export` button on the bindings page; restore later via `↑ Import` with Merge/Replace dialog. File format is validated on import (schema check + plugin-id check) so a wrong file can't silently overwrite a working set.
- **Per-binding health visibility**: the diag line of each binding card surfaces issues from `/api/bindings/health` directly — `input_stale` (warn, source seen but silent), `input_silent` (warn, never received), `field_missing` / `json_parse_failed` / `empty_payload` / `send_error` / `never_forwarded` (error). No more misleading green "forwarded N×" when the heartbeat is the only thing still firing.
- **Source-mode flag (cyclic / event)**: per-binding dropdown to suppress `input_stale` warnings for event-driven sources (Tasmota `stat/...` motion sensors, switches) — the wizard auto-picks the right mode based on topic prefix.
- **Topic-drift detection**: when a source topic goes silent but a live topic with the same trailing path exists in the broker's topic cache (e.g. `old-prefix/device/.../state` → `new-prefix/device/.../state`), the card offers a one-click **Umschalten** button to migrate the binding without re-running the wizard.
- **JSON-path free-text input**: StepPickField accepts arbitrary dot-notation paths (e.g. `ENERGY.Power`, `Außen.Temperature`) for nested payload structures alongside the existing top-level key list.

### MQTT Broker Bridges

UI-driven Mosquitto-native bridging between brokers — declare a bridge from the web UI, mqtt-master writes the drop-in `/etc/mosquitto/conf.d/` file and reloads mosquitto. Use case: mirror everything from another broker into yours (`topic # in 0`), migrate consumers off the old broker one by one, then retire it.

- **Top-level Bridges page** (`#/bridges`): list, create, edit, delete bridges with form-based UI
- **Per-bridge config**: remote host + port, optional auth, topic patterns each with direction (`in` / `out` / `both`) and QoS
- **Live status via $SYS subscription**: connection state retained on `$SYS/broker/connection/<bridge>/state`, surfaced as a dot per bridge — no log parsing, no polling
- **Atomic config writes with rollback**: writes to a tempfile + rename; if `systemctl reload mosquitto` fails the previous .conf is restored byte-identically (zero-downtime drift safety)
- **Quick-preset button**: one-click setup for the common "mirror everything from another broker" case
- **Loop-safe by default**: `try_private true` + per-bridge connection name prevents echo loops when both sides are bridged

### Cross-Box Health Monitoring

`GET /api/health/digest` exposes a compact, cross-plugin snapshot for external monitors (e.g. an external monitoring hub polling several mqtt-master instances). Response shape:

```json
{
  "box": "<label>",
  "host": "<ip>",
  "checked_at": "<ISO-8601-Z>",
  "ok_count": 12,
  "issues": [
    { "plugin": "...", "kind": "binding|plugin", "id": "...", "severity": "warn|error",
      "label": "...", "reason": "input_stale|...", "detail": "...", "last_event": "..." }
  ]
}
```

- **Binding-level reasons**: `input_silent`, `input_stale`, `field_missing`, `json_parse_failed`, `empty_payload`, `send_error`, `never_forwarded`
- **Plugin-level reasons**: `start_error`, `not_running`, `connection_lost`, `never_connected` — fires only for plugins that expose a `connection` field (Loxone, UniFi)
- **Box label**: resolved from `config.box` → env `MQTT_MASTER_BOX` → `os.hostname()`. Settable remotely via `PUT /api/system/box` with `{"box":"<label>"}`.
- **Defensive**: a single plugin throwing during digest computation skips that plugin but keeps the response valid for the rest.

### Backup & Migration
- Global backup at `#/backup`: one-click download of every plugin's bindings as a single JSON snapshot
- Restore from file with per-plugin Merge or Replace mode and a summary table of incoming vs. existing entries
- Use cases: pre-update safety net, moving bindings between mqtt-master instances, recovering from accidental wipes
- API endpoints `GET /api/bindings/export` and `POST /api/bindings/import` for scripted backups

### General
- Venus OS-inspired dark theme
- Responsive design (desktop, tablet, mobile)
- No database — JSON config + in-memory state
- Passwords encrypted at rest (AES-256-CBC)
- Auto-reconnect for all WebSocket connections
- No login: read access for the LAN; write requests only from the addresses in `web.writeAllow` (default: localhost)

## Installation

### Option 1: Proxmox LXC (recommended)

One command on your Proxmox host — creates a Debian LXC container and installs everything inside:

```bash
wget -qO- https://raw.githubusercontent.com/meintechblog/mqtt-master-oss/main/install-lxc.sh | bash
```

Customizable via environment variables:

```bash
wget -qO- https://raw.githubusercontent.com/meintechblog/mqtt-master-oss/main/install-lxc.sh | \
  CTID=200 CT_HOSTNAME=mqtt CT_MEMORY=1024 CT_DISK=8 bash
```

### Option 2: Direct install (Debian/Ubuntu)

One command on a fresh Debian 12+ or Ubuntu 22.04+ system:

```bash
wget -qO- https://raw.githubusercontent.com/meintechblog/mqtt-master-oss/main/install.sh | bash
```

Both options install:
- Node.js 20 LTS
- Mosquitto MQTT broker (port 1883 + WebSocket 9001, anonymous LAN access)
- MQTT Master as systemd service with auto-restart

After installation: `http://<your-server-ip>`

#### mDNS (`mqtt-master.local`)

The installer also brings up Avahi, so `http://mqtt-master.local` resolves
for clients on the same Layer-2 network as the server (mDNS is link-local
broadcast). Across a routed boundary — WireGuard, VPN, a VLAN without
mDNS reflection — use the server's IP directly or add a static entry on
your upstream resolver. If `.local` fails on a same-LAN client, confirm
`avahi-daemon` is running (`systemctl status avahi-daemon`).

## Updating

Same command — detects existing installation, pulls latest code, preserves config:

```bash
wget -qO- https://raw.githubusercontent.com/meintechblog/mqtt-master-oss/main/install.sh | bash
```

### Update check

The dashboard polls `https://api.github.com/repos/meintechblog/mqtt-master-oss/commits/main` every
6 hours and shows whether a newer main exists. Nothing is installed from
the UI or automatically: auto-apply was removed and the update API answers `403`. Updates are
deployed by hand on the host (sibling `mqtt-master-updater.service`, rollback to
the previous SHA on failure).

## Quick Start

1. Open the dashboard at `http://<server-ip>`
2. Click the **+** button next to "Plugins" in the sidebar
3. Choose **Loxone** or **MQTT-Bridge**
4. For MQTT-Bridge: pick a preset (e.g. Venus OS) or start with a custom config
5. Enter connection details and click **Start**

### Loxone Setup
0. **Prepare the Loxone user**: in Loxone Config, create or pick a user → enable **Webseite/Apps** → grant **Visualisierung erlaubt** for at least one element (or assign a group that already has these rights) → save the project to the Miniserver. Without these flags the plugin will sit on orange with a `401 Unauthorized` because LoxAPP3.json refuses to enumerate any controls for a user who isn't allowed to see them.
1. Add a Loxone plugin, enter Miniserver IP, port, username, password
2. Click **Save** — plugin connects automatically, controls are auto-discovered
3. Browse **Elements** to see live values, test commands via dropdown, copy MQTT topics
4. Configure **Mood Mapping** for LightControllerV2 mood names (defaults included)
5. Use **Input Bindings** to feed external data (PV inverters, energy meters) into Loxone

### Multiple Miniservers

Each Loxone instance uses its own **MQTT Topic Prefix** (configured in the plugin settings). This keeps all topics cleanly separated:

```
Miniserver 1:  prefix "loxone"         → loxone/room1/licht/cmd
Miniserver 2:  prefix "loxone-og"      → loxone-og/room2/dimmer/cmd
Miniserver 3:  prefix "loxone-house1" → loxone-house1/room1/licht/cmd
```

Each instance has its own Elements page, Mood Mappings, and Input Bindings.

### MQTT-Bridge Setup (Venus OS)
1. Add an MQTT-Bridge plugin → select the **Venus OS** preset
2. Enter the GX device IP (e.g. `192.0.2.100`) — protocol and port are added automatically
3. Start — all Venus OS topics are bridged to `venus/...` on your local broker
4. Use **Input Bindings** to forward Venus OS data to Loxone controls

## Configuration

Config file: `/opt/mqtt-master/config.json`

| Setting | Default | Description |
|---------|---------|-------------|
| `mqtt.broker` | `mqtt://localhost:1883` | Local MQTT broker URL |
| `web.port` | `80` | Web dashboard port |
| `logLevel` | `info` | Log level (trace, debug, info, warn, error) |
| `pluginDir` | `plugins/` | Plugin directory |
| `web.writeAllow` | `["127.0.0.1"]` | Client addresses allowed to send write requests (everyone else gets read access only) |

Plugin settings are managed through the web UI and stored under `plugins.*` in config.json. Passwords are automatically encrypted.

### Encryption secret

Stored passwords are encrypted with `ENCRYPTION_SECRET`, which the installer creates once in
`/etc/mqtt-master/env` (mode 0600). The service refuses to start without it. Never overwrite or
delete this file: values already stored in `config.json` can only be decrypted with the same
secret. If you restore a `config.json` that contains encrypted values (`enc2:` / `enc:`) onto a
new host, copy the matching `/etc/mqtt-master/env` along with it.

## MQTT Topic Reference

### Loxone Topics (name-based, human-readable)

```
loxone/{room}/{control}/state              ← state updates (JSON: value/text, name, type, uuid, room)
loxone/{room}/{control}/cmd                → commands (on, off, plus, minus, changeTo/Nacht, ...)
loxone/{room}/{control}/mood/state         ← resolved mood name (JSON: id, name, uuid)
loxone/{room}/{control}/{state}/state      ← sub-state (activeMoodsNum, position, presence, ...)
```

### Loxone Topics (UUID-based, rename-safe)

```
loxone/by-uuid/{uuid}/state               ← same payload as name-based
loxone/by-uuid/{uuid}/cmd                 → same commands as name-based
loxone/by-uuid/{uuid}/mood/state          ← same mood payload
```

Use UUID-based topics in automations — they survive control renames in Loxone Config.

### LightControllerV2 Commands

| Payload | Effect |
|---------|--------|
| `plus` | Next mood |
| `minus` | Previous mood |
| `changeTo/Nacht` | Set specific mood by name |
| `on` | Turn on (last active mood) |
| `off` | All off |

## Plugin Development

Plugins live in `plugins/{name}/plugin.js` and export a default class:

```javascript
export default class MyPlugin {
  async start(context) { }   // context: { mqttService, configService, logger, pluginId, pluginManager }
  async stop() { }
  getStatus() { }            // return { running, connected, messageCount, ... }
  getConfigSchema() { }      // JSON Schema → auto-generated config form
}
```

The `pluginId` in the context is the instance ID (e.g. `venus-os`), not the template type. Use it for reading config: `configService.get(\`plugins.${pluginId}\`)`.

Shared utilities available in `plugins/lib/`:
- `binding-utils.js` — input binding execution, field extraction, transforms
- `bindings-manager.js` — binding lifecycle management (apply, cleanup, persist)

### Adding Presets

Presets are defined in `server/services/plugin-manager.js` under the `PRESETS` constant. Each preset pre-fills config values when creating a new plugin instance:

```javascript
const PRESETS = {
  'mqtt-bridge': [
    {
      id: 'venus-os',
      label: 'Venus OS (Victron Energy)',
      description: 'GX device with MQTT enabled',
      suggestedId: 'venus-os',
      config: {
        displayName: 'Venus OS',
        subscribeTopic: 'N/#',
        localPrefix: 'venus',
        keepaliveEnabled: true,
        keepaliveIntervalMs: 30000,
      },
    },
  ],
};
```

## Service Management

```bash
systemctl status mqtt-master
systemctl restart mqtt-master
journalctl -u mqtt-master -f       # live logs
journalctl -u mqtt-master -n 50    # recent logs
```

## Development

```bash
git clone https://github.com/meintechblog/mqtt-master-oss.git
cd mqtt-master
npm install
npm run dev
npm test
```

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Web Browser (Preact SPA, no build step)        │
│  Dashboard │ Messages │ Elements │ Bindings     │
└──────────────┬──────────────────────────────────┘
               │ WebSocket + REST API
┌──────────────┴──────────────────────────────────┐
│  Fastify Server                                  │
│  ┌─────────────┐  ┌──────────────────────────┐  │
│  │ MQTT Service │  │ Plugin Manager           │  │
│  │ (mqtt.js)   │  │  ├─ Loxone Plugin        │  │
│  │             │  │  │  ├─ ha-discovery.js    │  │
│  │             │  │  │  ├─ mood-manager.js    │  │
│  │             │  │  │  └─ structure-monitor  │  │
│  │             │  │  ├─ MQTT-Bridge Plugin    │  │
│  │             │  │  │  (external broker)     │  │
│  │             │  │  └─ ... more plugins      │  │
│  └──────┬──────┘  └──────────────────────────┘  │
└─────────┼───────────────────────────────────────┘
          │
┌─────────┴───────────┐
│  Mosquitto Broker    │
│  Port 1883 + WS 9001│
└─────────────────────┘
```

## License

ISC
