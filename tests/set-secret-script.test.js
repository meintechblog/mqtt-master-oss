/**
 * scripts/set-secret.mjs – stores one secret encrypted in config.json on the host. The
 * secret comes on stdin only, never on the command line or in any output.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdtemp, readdir, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ConfigService } from '../server/services/config-service.js';

const SCRIPT = resolve(__dirname, '../scripts/set-secret.mjs');
const SECRET = 'enc-secret-0123456789abcdef';
const PW = 'neu-Kennwort!42 mit Leerzeichen';

function runScript(args, input, env = { ENCRYPTION_SECRET: SECRET }) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    env: { PATH: process.env.PATH, ...env },
    input,
    encoding: 'utf-8',
  });
}

describe('scripts/set-secret.mjs', () => {
  let dir;
  let configPath;
  let savedSecret;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mqtt-master-secret-'));
    configPath = join(dir, 'config.json');
    savedSecret = process.env.ENCRYPTION_SECRET;
    process.env.ENCRYPTION_SECRET = SECRET;
    const svc = new ConfigService(configPath);
    svc.set('plugins.house1', { password: 'loxone-alt' });
    svc.set('plugins.dreame', { username: 'me@example.org', devices: [{ key: 'eg' }] });
    await svc.save();
  });

  afterEach(async () => {
    process.env.ENCRYPTION_SECRET = savedSecret;
    await rm(dir, { recursive: true, force: true });
  });

  async function load() {
    const svc = new ConfigService(configPath);
    await svc.load();
    return svc;
  }

  it('stores the secret from stdin encrypted, keeps everything else, never prints it', async () => {
    const res = runScript([configPath, 'plugins.dreame.password'], `${PW}\n`);
    expect(res.status).toBe(0);
    expect(res.stdout + res.stderr).not.toContain(PW);
    expect(await readFile(configPath, 'utf-8')).not.toContain(PW);

    const svc = await load();
    expect(svc.get('plugins.dreame.password')).toBe(PW);
    expect(svc.get('plugins.dreame.username')).toBe('me@example.org');
    expect(svc.get('plugins.dreame.devices')).toEqual([{ key: 'eg' }]);
    expect(svc.get('plugins.house1.password')).toBe('loxone-alt');
  });

  it('writes a backup readable only by the owner before changing the config', async () => {
    const res = runScript([configPath, 'plugins.dreame.password'], `${PW}\n`);
    expect(res.status).toBe(0);
    const backup = res.stdout.match(/backup: (\S+)/)?.[1];
    expect(backup).toBeTruthy();
    expect((await stat(backup)).mode & 0o077).toBe(0);
  });

  // an accepted plain-text legacy config must not be copied as it is
  it('writes the backup encrypted, also from a plain-text legacy config, and it restores the old state', async () => {
    await writeFile(configPath, JSON.stringify({ plugins: { house1: { password: 'klartext-alt-xyz' } } }));
    const res = runScript([configPath, 'plugins.dreame.password'], `${PW}\n`);
    expect(res.status).toBe(0);
    const backup = res.stdout.match(/backup: (\S+)/)?.[1];
    expect(await readFile(backup, 'utf-8')).not.toContain('klartext-alt-xyz');

    await copyFile(backup, configPath);
    const svc = await load();
    expect(svc.get('plugins.house1.password')).toBe('klartext-alt-xyz');
    expect(svc.get('plugins.dreame.password')).toBeUndefined();
  });

  it('writes the backup to the path given as third argument', async () => {
    const backup = join(dir, 'sicherung.json');
    const res = runScript([configPath, 'plugins.dreame.password', backup], `${PW}\n`);
    expect(res.status).toBe(0);
    expect((await stat(backup)).mode & 0o077).toBe(0);
  });

  // suffix match of isSensitiveKey
  it('accepts a key that only ends in a sensitive name (accessToken)', async () => {
    const res = runScript([configPath, 'plugins.dreame.accessToken'], `${PW}\n`);
    expect(res.status).toBe(0);
    expect(await readFile(configPath, 'utf-8')).not.toContain(PW);
    expect((await load()).get('plugins.dreame.accessToken')).toBe(PW);
  });

  it('changes nothing when the backup cannot be written (exit 1)', async () => {
    const before = await readFile(configPath, 'utf-8');
    const backup = join(dir, 'schon-da.json');
    await writeFile(backup, 'x');
    const res = runScript([configPath, 'plugins.dreame.password', backup], `${PW}\n`);
    expect(res.status).toBe(1);
    expect(await readFile(configPath, 'utf-8')).toBe(before);
  });

  it('changes nothing and leaves no temp file when the config cannot be replaced (exit 1)', async () => {
    const before = await readFile(configPath, 'utf-8');
    const other = await mkdtemp(join(tmpdir(), 'mqtt-master-secret-backup-'));
    await chmod(dir, 0o500);
    try {
      const res = runScript([configPath, 'plugins.dreame.password', join(other, 'sicherung.json')], `${PW}\n`);
      expect(res.status).toBe(1);
      expect(res.stdout + res.stderr).not.toContain(PW);
    } finally {
      await chmod(dir, 0o700);
      await rm(other, { recursive: true, force: true });
    }
    expect(await readFile(configPath, 'utf-8')).toBe(before);
    expect(await readdir(dir)).toEqual(['config.json']);
  });

  it.each([
    ['not below plugins', 'server.password'],
    ['no sensitive key, would be stored in plain text', 'plugins.dreame.username'],
    ['plugin id with path characters', 'plugins.../password'],
    ['nested too deep', 'plugins.dreame.devices.password'],
  ])('refuses a key that is %s (exit 2, config unchanged)', async (_why, key) => {
    const before = await readFile(configPath, 'utf-8');
    const res = runScript([configPath, key], `${PW}\n`);
    expect(res.status).toBe(2);
    expect(await readFile(configPath, 'utf-8')).toBe(before);
  });

  it.each([
    ['empty', ''],
    ['only a newline', '\n'],
    ['more than one line', 'zeile1\nzeile2\n'],
    ['longer than 1024 characters', `${'x'.repeat(1025)}\n`],
    // a cut-off pipe must not be stored as the password
    ['without the closing newline (cut off)', 'neu-Kennw'],
  ])('refuses a secret that is %s (exit 2, config unchanged)', async (_why, input) => {
    const before = await readFile(configPath, 'utf-8');
    const res = runScript([configPath, 'plugins.dreame.password'], input);
    expect(res.status).toBe(2);
    expect(await readFile(configPath, 'utf-8')).toBe(before);
  });

  // ConfigService stores values that look encrypted unchanged
  it.each(['enc2:00:11:22\n', 'enc:aa:bb\n'])('refuses a secret that looks encrypted (%s)', async (input) => {
    const before = await readFile(configPath, 'utf-8');
    const res = runScript([configPath, 'plugins.dreame.password'], input);
    expect(res.status).toBe(2);
    expect(await readFile(configPath, 'utf-8')).toBe(before);
  });

  // a JSON parse error quotes parts of the file
  it('does not print parts of a config that does not parse (exit 1)', async () => {
    await writeFile(configPath, 'klartext-geheim-xyz und mehr');
    const res = runScript([configPath, 'plugins.dreame.password'], `${PW}\n`);
    expect(res.status).toBe(1);
    expect(res.stdout + res.stderr).not.toContain('klartext');
  });

  it('refuses to run without ENCRYPTION_SECRET (exit 2)', async () => {
    const res = runScript([configPath, 'plugins.dreame.password'], `${PW}\n`, {});
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('ENCRYPTION_SECRET');
  });

  it('changes nothing when the config does not load with ENCRYPTION_SECRET (exit 1)', async () => {
    const before = await readFile(configPath, 'utf-8');
    const res = runScript([configPath, 'plugins.dreame.password'], `${PW}\n`, { ENCRYPTION_SECRET: 'falsch-0123456789abcdef' });
    expect(res.status).toBe(1);
    expect(await readFile(configPath, 'utf-8')).toBe(before);
  });
});
