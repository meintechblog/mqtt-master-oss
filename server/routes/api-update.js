import { getCurrentVersion } from '../services/version-service.js';

export default async function apiUpdate(app) {
  // Lightweight identity endpoint used by the updater script's health probe.
  // Must always answer 200 with a stable shape so `run-update.sh` can compare
  // SHAs after a restart.
  app.get('/api/version', async () => {
    const v = await getCurrentVersion();
    return {
      sha: v.sha,
      shortSha: v.shortSha,
      tag: v.tag,
      version: v.version,
      isDev: v.isDev,
      isDirty: v.isDirty,
      commitDate: v.commitDate || null,
      commitSubject: v.commitSubject || null,
    };
  });

  app.get('/api/update/status', async () => {
    return await app.updateService.getStatus();
  });

  app.post('/api/update/check', async () => {
    return await app.updateService.checkNow({ manual: true });
  });

  // installing over HTTP is disabled. Without a login
  // anyone in the LAN could otherwise install a main state as root or turn
  // auto-apply back on. The maintainer deploys a reviewed commit by hand.
  // Refused in onRequest, i.e. before body parsing, so every request gets
  // the 403 (no 400/413/415 for odd bodies).
  const updateApiDisabled = {
    onRequest: async (request, reply) => reply.status(403).send({
      ok: false,
      error: 'update_api_disabled',
      message: 'Updates are installed by hand by the maintainer.',
    }),
  };

  app.post('/api/update/run', updateApiDisabled, async () => ({ ok: false }));

  app.get('/api/update/log', async (request) => {
    const lines = Math.min(Math.max(Number(request.query?.lines) || 200, 1), 5000);
    const content = await app.updateService.readUpdaterJournal({ lines });
    return { content, lines };
  });

  app.put('/api/update/settings', updateApiDisabled, async () => ({ ok: false }));
}
