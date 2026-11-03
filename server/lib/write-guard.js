/**
 * Write guard.
 *
 * Until the web UI has a real login, every request that is not read-only
 * (anything but GET/HEAD/OPTIONS) is only accepted from an allowlist of
 * addresses – by default only localhost (configurable via `web.writeAllow`). Everyone else in
 * the LAN keeps read access and gets 403 for writes.
 *
 * The address is the TCP peer (request.socket.remoteAddress), never a
 * forwarded header: the app runs without trustProxy, so X-Forwarded-For
 * cannot be used to borrow an allowed address.
 */

const READ_ONLY = new Set(['GET', 'HEAD', 'OPTIONS']);

export const DEFAULT_WRITE_ALLOW = ['127.0.0.1'];

/** Normalise IPv6 forms of IPv4 addresses so the allowlist stays plain IPv4. */
export function normalizeIp(ip) {
  if (!ip) return '';
  if (ip === '::1') return '127.0.0.1';
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  return ip;
}

export function isWriteAllowed(ip, allow) {
  const addr = normalizeIp(ip);
  return addr !== '' && allow.includes(addr);
}

/**
 * Register the guard as a root-level onRequest hook. Must be called on the
 * root instance before routes are registered so it covers every route.
 */
export function installWriteGuard(app, { allow = DEFAULT_WRITE_ALLOW } = {}) {
  const list = allow.map(normalizeIp);
  app.addHook('onRequest', async (request, reply) => {
    if (READ_ONLY.has(request.method)) return;
    const peer = request.socket?.remoteAddress;
    if (isWriteAllowed(peer, list)) return;
    request.log.warn({ method: request.method, url: request.url, remoteAddress: normalizeIp(peer) }, 'write refused');
    return reply.code(403).send({ ok: false, error: 'write_not_allowed' });
  });
}
