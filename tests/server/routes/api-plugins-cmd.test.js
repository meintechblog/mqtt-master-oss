/**
 * POST /api/plugins/:id/controls/:uuid/cmd nimmt
 * nur UUIDs aus der geladenen Struktur und nur einfache Befehle an, damit über
 * den Pfad jdev/sps/io/<uuid>/<command> kein anderer Miniserver-Befehl
 * zusammengesetzt werden kann.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import apiPlugins from '../../../server/routes/api-plugins.js';

const KNOWN = '1a2b3c4d-0000-0000-ffff00000000c001';
const UNKNOWN = '1a2b3c4d-0000-0000-ffff00000000c002';

describe('POST /api/plugins/:id/controls/:uuid/cmd', () => {
  let app;
  let instance;

  beforeEach(async () => {
    instance = {
      sendControlCommand: vi.fn(),
      hasControl: vi.fn((uuid) => uuid === KNOWN),
    };
    app = Fastify({ logger: false });
    app.decorate('pluginManager', { getInstance: vi.fn(() => instance) });
    await app.register(apiPlugins);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  const send = (uuid, command) => app.inject({
    method: 'POST',
    url: `/api/plugins/house1/controls/${uuid}/cmd`,
    payload: { command },
  });

  it('sends a simple command to a control from the structure', async () => {
    const res = await send(KNOWN, 'changeTo/2');
    expect(res.statusCode).toBe(200);
    expect(instance.sendControlCommand).toHaveBeenCalledWith(KNOWN, 'changeTo/2');
  });

  it('refuses a UUID that is not in the loaded structure with 404', async () => {
    const res = await send(UNKNOWN, 'on');
    expect(res.statusCode).toBe(404);
    expect(instance.sendControlCommand).not.toHaveBeenCalled();
  });

  it('refuses malformed UUIDs with 400', async () => {
    const res = await send('..%2F..%2Fdev%2Fsys', 'on');
    expect(res.statusCode).toBe(400);
    expect(instance.sendControlCommand).not.toHaveBeenCalled();
  });

  for (const bad of ['../sps/restart', 'on/../../x', 'a..b', '...', 'on/x..', 'a b', 'on?x=1', 'x'.repeat(65), '']) {
    it(`refuses the command ${JSON.stringify(bad.slice(0, 20))} with 400`, async () => {
      const res = await send(KNOWN, bad);
      expect(res.statusCode).toBe(400);
      expect(instance.sendControlCommand).not.toHaveBeenCalled();
    });
  }

  it('refuses commands when the plugin cannot confirm the UUID (no hasControl)', async () => {
    delete instance.hasControl;
    const res = await send(KNOWN, 'on');
    expect(res.statusCode).toBe(400);
    expect(instance.sendControlCommand).not.toHaveBeenCalled();
  });
});
