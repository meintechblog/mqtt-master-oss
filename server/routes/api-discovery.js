import dgram from 'node:dgram';
import { networkInterfaces } from 'node:os';

const LOXONE_DISCOVERY_PORT = 7777;
const LOXONE_PROBE = Buffer.from('LoxLIVE\r\n', 'ascii');

/**
 * Every IPv4 broadcast address bound on this host. Includes the generic
 * 255.255.255.255 plus the per-interface directed broadcast.
 */
function broadcastAddresses() {
  const out = new Set(['255.255.255.255']);
  const ifaces = networkInterfaces();
  for (const addrs of Object.values(ifaces || {})) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      if (ip.length !== 4 || mask.length !== 4) continue;
      const bcast = ip.map((p, i) => (p | (~mask[i] & 0xff)));
      out.add(bcast.join('.'));
    }
  }
  return [...out];
}

/**
 * Best-effort parse of a Loxone UDP discovery response. Firmware versions
 * vary, so we try a few patterns and always preserve the raw payload.
 */
function parseUdpResponse(text, fromIp) {
  const result = { ip: fromIp, port: 80, source: 'udp', raw: text.trim() };
  const ipPort = text.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d{1,5})/);
  if (ipPort) { result.ip = ipPort[1]; result.port = Number(ipPort[2]); }
  const mac = text.match(/([0-9A-F]{2}[:\-]){5}[0-9A-F]{2}/i);
  if (mac) result.mac = mac[0].toUpperCase().replace(/-/g, ':');
  const nameKv = text.match(/name\s*[=:]\s*"?([^",\r\n]+)"?/i);
  if (nameKv) result.name = nameKv[1].trim();
  const fw = text.match(/\b(\d+\.\d+\.\d+\.\d+)\b(?!:\d)/);
  if (fw && fw[1] !== result.ip) result.firmware = fw[1];
  return result;
}

/**
 * UDP broadcast probe. Older Miniservers respond on port 7777; newer ones
 * may not. We do this in parallel with the HTTP scan so users on either
 * generation get instant results.
 */
async function udpScan({ durationMs, log }) {
  return await new Promise((resolve) => {
    const found = new Map();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      try { socket.close(); } catch { /* ignored */ }
      resolve([...found.values()]);
    };

    socket.on('message', (msg, rinfo) => {
      const info = parseUdpResponse(msg.toString('utf8'), rinfo.address);
      if (!found.has(info.ip)) found.set(info.ip, info);
    });
    socket.on('error', (err) => { log?.warn?.({ err }, 'udp-discovery error'); finish(); });

    socket.bind(0, () => {
      try { socket.setBroadcast(true); } catch { /* ignored */ }
      for (const addr of broadcastAddresses()) {
        socket.send(LOXONE_PROBE, LOXONE_DISCOVERY_PORT, addr, () => {});
      }
      setTimeout(finish, durationMs);
    });
  });
}

/**
 * Iterate every host in this machine's IPv4 subnets (excluding network /
 * broadcast addresses). Skips subnets larger than /22 (1022 hosts) so a
 * misconfigured /16 doesn't fan out into 65k probes.
 */
function* hostIpsInLocalSubnets() {
  const seen = new Set();
  const ifaces = networkInterfaces();
  for (const addrs of Object.values(ifaces || {})) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      const maskInt = (mask[0] << 24) | (mask[1] << 16) | (mask[2] << 8) | mask[3];
      const ipInt = (ip[0] << 24) | (ip[1] << 16) | (ip[2] << 8) | ip[3];
      const network = (ipInt & maskInt) >>> 0;
      const hostBits = 32 - mask.reduce((c, b) => c + (b.toString(2).match(/1/g) || []).length, 0);
      if (hostBits === 0 || hostBits > 10) continue; // skip larger than /22
      const total = (1 << hostBits) >>> 0;
      for (let i = 1; i < total - 1; i++) {
        const h = (network + i) >>> 0;
        const dotted = `${(h >>> 24) & 0xff}.${(h >>> 16) & 0xff}.${(h >>> 8) & 0xff}.${h & 0xff}`;
        if (!seen.has(dotted)) {
          seen.add(dotted);
          yield dotted;
        }
      }
    }
  }
}

/**
 * Probe a single IP for Loxone's `/jdev/cfg/api`. The Miniserver always
 * answers this even without auth, returning JSON with `snr` (MAC) and
 * `version`. A `LL.Code === "200"` plus a recognisable `value` is our cue.
 */
async function probeLoxoneHttp(ip, timeoutMs = 800) {
  const url = `http://${ip}/jdev/cfg/api`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'manual' });
    if (!res.ok) return null;
    const text = await res.text();
    if (!/Loxone|LL|snr|control/i.test(text)) return null;
    const result = { ip, port: 80, source: 'http' };
    // Loxone wraps payload as `{"LL":{"control":"dev/cfg/api","value":"{'snr':'..','version':'..'}","Code":"200"}}`
    let parsed;
    try { parsed = JSON.parse(text); } catch { /* sometimes the inner value is single-quoted; massage it */ }
    if (parsed && parsed.LL && typeof parsed.LL.value === 'string') {
      // The inner value is often single-quoted JSON-ish: `{'snr':'...'}`
      const fixed = parsed.LL.value.replace(/'/g, '"');
      try {
        const inner = JSON.parse(fixed);
        if (inner.snr) result.mac = String(inner.snr).toUpperCase();
        if (inner.version) result.firmware = String(inner.version);
      } catch { /* leave as-is */ }
    }
    // Best-effort: try the unauthenticated `/jdev/cfg/version` and a couple
    // of other safe endpoints. We skip LoxAPP3.json because it requires auth
    // on every modern firmware and the WWW-Authenticate realm is just the
    // path ("data") rather than the device name.
    try {
      const nameCtl = new AbortController();
      const nameTimer = setTimeout(() => nameCtl.abort(), 600);
      const verRes = await fetch(`http://${ip}/jdev/cfg/version`, {
        signal: nameCtl.signal,
        redirect: 'manual',
      });
      clearTimeout(nameTimer);
      if (verRes.ok) {
        const body = await verRes.text();
        try {
          const j = JSON.parse(body);
          if (j?.LL?.value && !result.firmware) result.firmware = String(j.LL.value);
        } catch { /* ignore */ }
      }
    } catch { /* timeouts and aborts are expected */ }
    return result;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pool-bounded HTTP scan. Returns Loxone-shaped results for every host that
 * replies on /jdev/cfg/api within the timeout.
 */
async function httpScan({ concurrency = 48, perHostTimeoutMs = 800, log }) {
  const found = new Map();
  const ips = [...hostIpsInLocalSubnets()];
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= ips.length) return;
      const ip = ips[i];
      const hit = await probeLoxoneHttp(ip, perHostTimeoutMs).catch(() => null);
      if (hit) found.set(hit.ip, hit);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  log?.debug?.({ scanned: ips.length, found: found.size }, 'loxone http scan done');
  return [...found.values()];
}

export default async function apiDiscovery(app) {
  app.post('/api/discovery/loxone', async (request) => {
    const durationMs = Math.min(
      Math.max(Number(request.body?.durationMs) || 4000, 1000),
      10000
    );

    // Run UDP and HTTP probes in parallel — UDP wins for old firmwares
    // (instant), HTTP catches everything else.
    const [udpResults, httpResults] = await Promise.all([
      udpScan({ durationMs: Math.min(durationMs, 3500), log: app.log }),
      httpScan({ perHostTimeoutMs: Math.min(durationMs, 1200), log: app.log }),
    ]);

    // Merge by IP; HTTP results win because they include richer fields
    // (firmware, mac via snr, name from realm) even when UDP also replies.
    const merged = new Map();
    for (const r of udpResults) merged.set(r.ip, r);
    for (const r of httpResults) {
      const prev = merged.get(r.ip);
      merged.set(r.ip, prev ? { ...prev, ...r } : r);
    }

    return [...merged.values()].sort((a, b) => a.ip.localeCompare(b.ip));
  });
}
