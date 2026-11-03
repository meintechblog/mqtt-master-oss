import { hostname, networkInterfaces } from 'node:os';

/**
 * Collect non-internal IPv4 addresses for all network interfaces.
 * Returns objects like `{ iface: 'eth0', address: '203.0.113.178' }` so the
 * UI can show users which interface they're looking at.
 */
function collectLanIps() {
  const out = [];
  const ifaces = networkInterfaces();
  for (const [iface, addrs] of Object.entries(ifaces || {})) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        out.push({ iface, address: addr.address });
      }
    }
  }
  return out;
}

/**
 * Parse a broker URL like `mqtt://localhost:1883` into its parts.
 * Tolerant of missing protocol/port.
 */
function parseBrokerUrl(raw) {
  if (!raw) return { protocol: 'mqtt', host: 'localhost', port: 1883 };
  let url = raw;
  if (!/^[a-z]+:\/\//i.test(url)) url = 'mqtt://' + url;
  try {
    const u = new URL(url);
    const proto = (u.protocol || 'mqtt:').replace(':', '') || 'mqtt';
    const host = u.hostname || 'localhost';
    const port = Number(u.port) || (proto === 'mqtts' ? 8883 : 1883);
    return { protocol: proto, host, port };
  } catch {
    return { protocol: 'mqtt', host: 'localhost', port: 1883 };
  }
}

/**
 * /api/system/info — connection info for the dashboard.
 *
 * Returns the data needed to tell a user which network address to use to
 * reach the MQTT broker and the web dashboard from other machines on the LAN.
 */
export default async function apiSystem(app) {
  app.get('/api/system/info', async () => {
    const config = app.configService;
    const broker = parseBrokerUrl(config.get('mqtt.broker', 'mqtt://localhost:1883'));

    return {
      hostname: hostname(),
      lanIps: collectLanIps(),
      web: {
        port: config.get('web.port', 80),
      },
      mqtt: {
        // Configured broker URL (may be mqtt://localhost:1883 — useful internally)
        configuredUrl: config.get('mqtt.broker', 'mqtt://localhost:1883'),
        protocol: broker.protocol,
        host: broker.host,
        port: broker.port,
        // Mosquitto's WebSocket listener (configured by install.sh on port 9001)
        websocketPort: 9001,
      },
      topicPrefix: config.get('topicPrefix', 'mqtt-master'),
    };
  });

  app.put('/api/system/box', async (request, reply) => {
    const label = request.body?.box;
    if (typeof label !== 'string' || label.length === 0 || label.length > 64 || !/^[a-z0-9_-]+$/i.test(label)) {
      reply.code(400);
      return {
        error: 'invalid_box_label',
        hint: 'box must be a 1-64 char string matching [a-zA-Z0-9_-]',
      };
    }
    app.configService.set('box', label);
    await app.configService.save();
    return { ok: true, box: label };
  });
}
