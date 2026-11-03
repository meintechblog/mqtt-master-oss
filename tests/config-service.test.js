import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConfigService } from '../server/services/config-service.js';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Own temp dir per test: a shared /tmp/mqtt-master-test was removed here
// while bridge-service.test.js was still writing into it (parallel files).
let TMP_DIR;

describe('ConfigService', () => {
  beforeEach(async () => {
    TMP_DIR = await mkdtemp(join(tmpdir(), 'mqtt-master-config-'));
  });

  afterEach(async () => {
    await rm(TMP_DIR, { recursive: true, force: true });
  });

  it('returns defaults when config file does not exist', async () => {
    const svc = new ConfigService(join(TMP_DIR, 'nonexistent.json'));
    await svc.load();
    expect(svc.get('mqtt.broker')).toBe('mqtt://localhost:1883');
    expect(svc.get('web.port')).toBe(80);
  });

  it('merges file config over defaults', async () => {
    const cfgPath = join(TMP_DIR, 'config.json');
    await writeFile(cfgPath, JSON.stringify({ mqtt: { broker: 'mqtt://other:1883' } }));
    const svc = new ConfigService(cfgPath);
    await svc.load();
    expect(svc.get('mqtt.broker')).toBe('mqtt://other:1883');
    expect(svc.get('web.port')).toBe(80); // default preserved
  });

  it('refuses to start on a corrupt config.json instead of continuing with defaults', async () => {
    // defaults would be written back by the
    // next save() (e.g. the 6-h update check) and destroy the plugin configs.
    const cfgPath = join(TMP_DIR, 'bad.json');
    await writeFile(cfgPath, 'not json');
    const svc = new ConfigService(cfgPath);
    await expect(svc.load()).rejects.toThrow(/bad\.json/);
  });

  it('get() returns fallback for missing keys', async () => {
    const svc = new ConfigService(join(TMP_DIR, 'nonexistent.json'));
    await svc.load();
    expect(svc.get('nonexistent', 'fallback')).toBe('fallback');
  });

  it('get() traverses nested keys', async () => {
    const svc = new ConfigService(join(TMP_DIR, 'nonexistent.json'));
    await svc.load();
    expect(svc.get('mqtt.broker')).toBe('mqtt://localhost:1883');
  });
});
