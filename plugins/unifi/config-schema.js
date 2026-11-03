/**
 * UniFi plugin config-form schema.
 *
 * Auto-rendered by the webapp's plugin-config page into form fields. The shape
 * mirrors the existing Loxone schema (type/title/description/default/format)
 * so the existing renderer in `webapp/js/pages/plugin-config.js` handles every
 * field without per-plugin special-cases.
 *
 * Field semantics — locked in `07-CONTEXT.md`:
 *   - D-04 — `tlsVerify` defaults to `false` because UDMs ship with a self-
 *            signed cert. Advanced users can flip to true once cert pinning
 *            ships (UNIFI-FU follow-up).
 *   - D-10 — Username + password live here as plain ConfigService entries
 *            (LAN-trusted, mirrors the existing Loxone storage model).
 *   - D-12 — The Test-Connection button in the webapp form lives next to
 *            these fields; it consumes the same values WITHOUT persisting.
 *   - D-14 — `topicPrefix` is auto-derived on first connect; user may
 *            override (sets `autoNamed:false` internally so subsequent
 *            connects never overwrite).
 *   - D-15 — `displayName` defaults to `UniFi {host}` pre-connect, replaced
 *            by `UniFi {controller_name}` after the first sysinfo round-trip
 *            when `autoNamed` is still true.
 *   - Phase boundary — `dryRun` defaults to `true` for the v1.1 dev cycle.
 *            Phase 9's PoE writes consult this flag; phase 12 E2E validation
 *            is the gate for flipping it to `false`.
 *
 * Hidden internals — NOT surfaced in the form:
 *   - `autoNamed` (managed by plugin.js based on whether user edits prefix)
 *
 * @returns {object} JSON-Schema-shaped config form definition.
 */
export function getConfigSchema() {
  return {
    type: 'object',
    properties: {
      displayName: {
        type: 'string',
        title: 'Display Name',
        description: 'Name shown in the sidebar. Defaults to "UniFi {host}" before first connect; replaced by "UniFi {controller_name}" after the first successful login (D-15).',
      },
      host: {
        type: 'string',
        title: 'Controller Host',
        description: 'IP or hostname of the UDM / UCG / UDR controller (e.g. 192.0.2.1).',
      },
      username: {
        type: 'string',
        title: 'Local Admin Username',
        description: 'Use a local-only admin (NOT an SSO/Ubiquiti account) — see README. SSO admins trigger a 2FA fail-fast (D-21).',
      },
      password: {
        type: 'string',
        title: 'Password',
        format: 'password',
      },
      site: {
        type: 'string',
        title: 'Site',
        default: 'default',
        description: "UniFi site identifier — usually 'default' for single-site setups (D-03).",
      },
      topicPrefix: {
        type: 'string',
        title: 'MQTT Topic Prefix',
        description: 'Auto-derived from the controller name after the first successful connect (e.g. "unifi-gateway1" — no trailing slash; the publish layer adds it). Edit to override — once edited, the auto-derivation will never overwrite (D-14).',
      },
      autoStart: {
        type: 'boolean',
        title: 'Auto-start',
        default: false,
        description: 'Start this plugin automatically when the server boots.',
      },
      pollDeviceListSec: {
        type: 'integer',
        title: 'Device-List Poll Interval (s)',
        default: 30,
        minimum: 5,
        description: 'How often to fetch the full device list (/stat/device). 30s default. Floor 5s (D-P-01 two-loop polling; D-P-02 default — anything lower stresses UDM CPU per PITFALLS Pitfall 13).',
      },
      pollPortStateSec: {
        type: 'integer',
        title: 'Port-State Poll Interval (s)',
        default: 5,
        minimum: 2,
        description: 'How often to poll per-port telemetry. 5s default. Floor 2s (D-P-01 two-loop polling; D-P-02 default).',
      },
      heartbeatSec: {
        type: 'integer',
        title: 'Heartbeat Republish Interval (s)',
        default: 60,
        minimum: 0,
        description: 'Heartbeat re-publishes cached state every N seconds with retain=true. 0 disables (D-H-01). Staleness-gated (D-H-02): disconnected devices stop republishing after 2x port-state poll.',
      },
      cyclePortRateLimitMs: {
        type: 'integer',
        title: 'PoE Cycle Per-Port Rate Limit (ms)',
        default: 10000,
        minimum: 1000,
        description: 'Minimum interval between cycle commands targeting the same (device-MAC, port-idx). 10s default protects 802.3af PD recovery time (D-RL-01 / D-RL-03; PITFALLS Pitfall 5).',
      },
      dryRun: {
        type: 'boolean',
        title: 'Dry-Run Mode (recommended for v1.1)',
        default: true,
        description: 'Phase 9 PoE writes are logged but not sent to the controller while this is on. Flip to OFF only after Phase 12 E2E validation.',
      },
      haDiscovery: {
        type: 'boolean',
        title: 'Home Assistant MQTT Discovery',
        default: true,
        description: 'Publish HA Discovery config payloads so each UniFi device appears as one HA device with per-PoE-port switch / button / sensors / binary_sensor entities. See D-CFG-01 (Phase 11). Disable per instance if running multiple UniFi plugins where only one should expose to HA.',
      },
      haDiscoveryPrefix: {
        type: 'string',
        title: 'HA Discovery Topic Prefix',
        default: 'homeassistant',
        description: 'MQTT topic prefix HA listens on for auto-discovery. Default "homeassistant" matches the HA convention; override only if your HA install uses a non-default discovery_prefix (D-CFG-01).',
      },
      tlsVerify: {
        type: 'boolean',
        title: 'Verify TLS Certificate',
        default: false,
        description: 'UDM ships with a self-signed certificate. Leave OFF unless you have cert pinning configured (D-04 — advanced).',
      },
      clientsEnabled: {
        type: 'boolean',
        title: 'Track Wireless / Wired Clients',
        default: true,
        description: 'Publish per-client presence + HA device_tracker entities (D-P14-CFG-01). Disable per instance if you only need device/PoE telemetry.',
      },
      pollClientsSec: {
        type: 'integer',
        title: 'Clients Poll Interval (s)',
        default: 30,
        minimum: 10,
        description: 'How often to fetch /stat/sta and publish per-client state. 30s default. Floor 10s — anything lower hammers the UDM CPU on busy networks (D-P14-DATA-01).',
      },
      clientsStaleAfterSec: {
        type: 'integer',
        title: 'Client Stale Threshold (s)',
        default: 300,
        minimum: 60,
        description: 'A client absent from /stat/sta for this many seconds transitions home → not_home (D-P14-TOPIC-03). 5 min default — long enough to skip brief WiFi handovers, short enough for "I just left the house" automations to fire.',
      },
      clientsCleanupAfterSec: {
        type: 'integer',
        title: 'Client Cleanup Threshold (s)',
        default: 86400,
        minimum: 60,
        description: 'A client absent for this many seconds is fully removed (retain-clear + HA Discovery teardown). 24h default — strikes the balance between not surprising users with stale entries and not erasing devices that legitimately roam off-site (D-P14-TOPIC-03).',
      },
      clientsMaxPublished: {
        type: 'integer',
        title: 'Max Clients to Publish (defensive cap)',
        default: 200,
        minimum: 1,
        description: 'Safety cap against pathological client counts. When /stat/sta returns more than this many, only the most-recently-seen are published (D-P14-PERF-01). Most home networks stay well under 50.',
      },
    },
  };
}
