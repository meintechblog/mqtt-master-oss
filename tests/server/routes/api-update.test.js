/**
 * Updates werden nicht mehr über die Weboberfläche
 * eingespielt. POST /api/update/run und PUT /api/update/settings sind
 * gesperrt (ohne Anmeldung könnte sonst jeder im LAN einen main-Stand als
 * root einspielen oder das Auto-Apply wieder einschalten). Lesende Routen
 * bleiben erreichbar.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import apiUpdate from '../../../server/routes/api-update.js';

function makeUpdateService() {
  return {
    getStatus: vi.fn(async () => ({ autoApply: false, hasUpdate: false })),
    checkNow: vi.fn(async () => ({ ok: true })),
    runUpdate: vi.fn(async () => ({ started: true })),
    readUpdaterJournal: vi.fn(async () => ''),
    setAutoApply: vi.fn(async () => {}),
    setAutoUpdateHour: vi.fn(async () => {}),
  };
}

describe('api-update', () => {
  let app;
  let updateService;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    updateService = makeUpdateService();
    app.decorate('updateService', updateService);
    await app.register(apiUpdate);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('POST /api/update/run is refused with 403 and never starts the updater', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/update/run', payload: {} });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ ok: false, error: 'update_api_disabled' });
    expect(updateService.runUpdate).not.toHaveBeenCalled();
  });

  it('PUT /api/update/settings is refused with 403 and changes nothing', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/update/settings',
      payload: { autoApply: true, autoUpdateHour: 4 },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ ok: false, error: 'update_api_disabled' });
    expect(updateService.setAutoApply).not.toHaveBeenCalled();
    expect(updateService.setAutoUpdateHour).not.toHaveBeenCalled();
  });

  it('GET /api/update/status stays readable', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/update/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ autoApply: false });
  });

  it('refuses POST /api/update/run with 403 even for a broken JSON body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/update/run',
      headers: { 'content-type': 'application/json' },
      payload: '{',
    });
    expect(res.statusCode).toBe(403);
    expect(updateService.runUpdate).not.toHaveBeenCalled();
  });

  it('refuses PUT /api/update/settings with 403 even for an unsupported content type', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/update/settings',
      headers: { 'content-type': 'text/plain' },
      payload: 'autoApply=true',
    });
    expect(res.statusCode).toBe(403);
    expect(updateService.setAutoApply).not.toHaveBeenCalled();
  });
});
