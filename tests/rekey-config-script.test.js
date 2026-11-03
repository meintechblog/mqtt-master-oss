/**
 * scripts/rekey-config.mjs – einmaliges Umschlüsseln von config.json auf dem
 * Host. Beide Geheimnisse kommen aus der Umgebung, nie
 * aus der Befehlszeile (sonst stünden sie in `ps`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createCipheriv, randomBytes, scryptSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ConfigService } from '../server/services/config-service.js';

const SCRIPT = resolve(__dirname, '../scripts/rekey-config.mjs');
const OLD = 'old-secret-0123456789abcdef';
const NEW = 'new-secret-fedcba9876543210';

function runScript(args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf-8',
  });
}

describe('scripts/rekey-config.mjs', () => {
  let dir;
  let configPath;
  let savedSecret;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mqtt-master-rekey-'));
    configPath = join(dir, 'config.json');
    savedSecret = process.env.ENCRYPTION_SECRET;
    process.env.ENCRYPTION_SECRET = OLD;
    const svc = new ConfigService(configPath);
    svc.set('plugins.house1', { password: 'geheim-123' });
    await svc.save();
  });

  afterEach(async () => {
    process.env.ENCRYPTION_SECRET = savedSecret;
    await rm(dir, { recursive: true, force: true });
  });

  it('re-encrypts config.json so the service starts with the new secret', async () => {
    const res = runScript([configPath], { ENCRYPTION_SECRET_ALT: OLD, ENCRYPTION_SECRET: NEW });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('1 ');

    process.env.ENCRYPTION_SECRET = NEW;
    const svc = new ConfigService(configPath);
    await svc.load();
    expect(svc.get('plugins.house1.password')).toBe('geheim-123');
  });

  it('exits with code 2 and changes nothing when a secret is missing', async () => {
    const res = runScript([configPath], { ENCRYPTION_SECRET: NEW });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('ENCRYPTION_SECRET_ALT');

    const svc = new ConfigService(configPath);
    await svc.load();
    expect(svc.get('plugins.house1.password')).toBe('geheim-123');
  });

  it('migrates a legacy enc: (CBC) config written with the old fallback key', async () => {
    const key = scryptSync('change-me-in-production', `mqtt-master:${configPath}`, 32);
    const iv = randomBytes(16);
    const c = createCipheriv('aes-256-cbc', key, iv);
    const legacy = `enc:${iv.toString('hex')}:${c.update('alt-geheim', 'utf8', 'hex')}${c.final('hex')}`;
    await writeFile(configPath, JSON.stringify({ plugins: { house1: { password: legacy } } }));

    const res = runScript([configPath], { ENCRYPTION_SECRET_ALT: 'change-me-in-production', ENCRYPTION_SECRET: NEW });
    expect(res.status).toBe(0);

    process.env.ENCRYPTION_SECRET = NEW;
    const svc = new ConfigService(configPath);
    await svc.load();
    expect(svc.get('plugins.house1.password')).toBe('alt-geheim');
  });

  it('--pruefen exits 0 when config.json decrypts with ENCRYPTION_SECRET and 1 otherwise', async () => {
    expect(runScript(['--pruefen', configPath], { ENCRYPTION_SECRET: OLD }).status).toBe(0);
    expect(runScript(['--pruefen', configPath], { ENCRYPTION_SECRET: NEW }).status).toBe(1);
    expect(runScript(['--pruefen', configPath], {}).status).toBe(1);
  });
});
