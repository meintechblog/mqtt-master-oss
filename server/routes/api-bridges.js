/**
 * REST endpoints for mosquitto-native broker bridges.
 *
 *   GET    /api/bridges        — list (passwords masked to "***")
 *   GET    /api/bridges/status — { <connectionName>: 'connected'|'disconnected'|'unknown' }
 *   GET    /api/bridges/:id    — full bridge, password masked too ("***" back = unchanged)
 *   POST   /api/bridges        — create
 *   PUT    /api/bridges/:id    — update
 *   DELETE /api/bridges/:id    — delete
 *   POST   /api/bridges/apply  — regenerate+reload from current config
 *
 *   Response shape conventions:
 *     - 200 + { ok: true, bridge?, reloadStderr? } on success
 *     - 400 + { ok: false, error } on validation failure
 *     - 404 + { error: 'not_found' } for unknown :id
 *     - 500 + { ok: false, error: 'reload_failed', stderr } on systemctl reload failure
 */
export default async function apiBridges(app) {
  // ── Reads ────────────────────────────────────────────────────────
  app.get('/api/bridges', async () => {
    return app.bridgeService.listBridges();
  });

  // Place /status before /:id so it doesn't get caught by the dynamic route.
  app.get('/api/bridges/status', async () => {
    return app.bridgeService.getStatus();
  });

  app.get('/api/bridges/:id', async (request, reply) => {
    const b = app.bridgeService.getBridge(request.params.id);
    if (!b) return reply.status(404).send({ error: 'not_found' });
    return b;
  });

  // ── Writes ───────────────────────────────────────────────────────
  app.post('/api/bridges', async (request, reply) => {
    const body = request.body || {};
    // Disallow client-supplied id on create — server derives it from
    // connectionName so the POST/PUT distinction stays clean (POST is new,
    // PUT targets an existing slot).
    const { id: _ignored, ...rest } = body;
    const res = await app.bridgeService.upsertBridge(rest);
    return mapResponse(reply, res);
  });

  app.put('/api/bridges/:id', async (request, reply) => {
    const body = request.body || {};
    // Force the id from the URL so the path is authoritative.
    const incoming = { ...body, id: request.params.id };
    const res = await app.bridgeService.upsertBridge(incoming);
    return mapResponse(reply, res);
  });

  app.delete('/api/bridges/:id', async (request, reply) => {
    const res = await app.bridgeService.deleteBridge(request.params.id);
    if (!res.ok && res.error === 'not_found') {
      return reply.status(404).send(res);
    }
    if (!res.ok && res.error === 'reload_failed') {
      return reply.status(500).send(res);
    }
    return res;
  });

  app.post('/api/bridges/apply', async (request, reply) => {
    const res = await app.bridgeService.applyNow();
    if (!res.ok) return reply.status(500).send(res);
    return res;
  });
}

/**
 * Translate a BridgeService result into a Fastify response with the right
 * status code. reload_failed → 500 (broker stayed in the previous state),
 * everything else with ok=false is a 400 validation error.
 */
function mapResponse(reply, res) {
  if (res.ok) return res;
  if (res.error === 'reload_failed') {
    return reply.status(500).send(res);
  }
  return reply.status(400).send(res);
}
