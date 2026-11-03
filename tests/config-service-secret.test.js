/**
 * Ohne ENCRYPTION_SECRET startet der Dienst nicht mehr
 * (fail closed). Früher fiel er auf einen im Code stehenden Ersatzschlüssel
 * zurück, damit waren gespeicherte Kennwörter praktisch Klartext.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createCipheriv, randomBytes, scryptSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService, rekeyConfigFile } from '../server/services/config-service.js';

const SECRET_A = 'test-secret-a-0123456789abcdef';
const SECRET_B = 'test-secret-b-fedcba9876543210';
const LEGACY_SECRET = 'change-me-in-production';

/** Old storage format as written before . */
function legacyEncrypt(text, secret, configPath) {
  const key = scryptSync(secret, `mqtt-master:${configPath}`, 32);
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  return `enc:${iv.toString('hex')}:${cipher.update(text, 'utf8', 'hex')}${cipher.final('hex')}`;
}

describe('ConfigService ENCRYPTION_SECRET', () => {
  let dir;
  let configPath;
  let savedSecret;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mqtt-master-secret-'));
    configPath = join(dir, 'config.json');
    savedSecret = process.env.ENCRYPTION_SECRET;
  });

  afterEach(async () => {
    if (savedSecret === undefined) delete process.env.ENCRYPTION_SECRET;
    else process.env.ENCRYPTION_SECRET = savedSecret;
    await rm(dir, { recursive: true, force: true });
  });

  it('refuses to start without ENCRYPTION_SECRET', () => {
    delete process.env.ENCRYPTION_SECRET;
    expect(() => new ConfigService(configPath)).toThrow(/ENCRYPTION_SECRET/);
  });

  it('refuses to start with an empty ENCRYPTION_SECRET', () => {
    process.env.ENCRYPTION_SECRET = '';
    expect(() => new ConfigService(configPath)).toThrow(/ENCRYPTION_SECRET/);
  });

  it('stores passwords encrypted and reads them back with the same secret', async () => {
    process.env.ENCRYPTION_SECRET = SECRET_A;
    const writer = new ConfigService(configPath);
    writer.set('plugins.house1', { username: 'mqtt-master', password: 'geheim-123' });
    await writer.save();

    const raw = await readFile(configPath, 'utf-8');
    expect(raw).not.toContain('geheim-123');
    expect(raw).toMatch(/"password": "enc2:/);

    const reader = new ConfigService(configPath);
    await reader.load();
    expect(reader.get('plugins.house1.password')).toBe('geheim-123');
  });

  it('fails loading with a different secret instead of continuing with defaults', async () => {
    process.env.ENCRYPTION_SECRET = SECRET_A;
    const writer = new ConfigService(configPath);
    writer.set('plugins.house1', { password: 'geheim-123' });
    await writer.save();

    process.env.ENCRYPTION_SECRET = SECRET_B;
    const reader = new ConfigService(configPath);
    await expect(reader.load()).rejects.toThrow(/ENCRYPTION_SECRET/);
  });

  it('rekeyConfigFile re-encrypts with the new secret and keeps a backup', async () => {
    process.env.ENCRYPTION_SECRET = SECRET_A;
    const writer = new ConfigService(configPath);
    writer.set('plugins.house1', { username: 'mqtt-master', password: 'geheim-123' });
    await writer.save();
    const before = await readFile(configPath, 'utf-8');

    const result = await rekeyConfigFile(configPath, { oldSecret: SECRET_A, newSecret: SECRET_B });

    expect(result.reencrypted).toBe(1);
    expect(existsSync(result.backupPath)).toBe(true);
    expect(await readFile(result.backupPath, 'utf-8')).toBe(before);

    process.env.ENCRYPTION_SECRET = SECRET_B;
    const reader = new ConfigService(configPath);
    await reader.load();
    expect(reader.get('plugins.house1.password')).toBe('geheim-123');
    expect(reader.get('plugins.house1.username')).toBe('mqtt-master');
  });

  it('rekeyConfigFile changes nothing when the old secret is wrong', async () => {
    process.env.ENCRYPTION_SECRET = SECRET_A;
    const writer = new ConfigService(configPath);
    writer.set('plugins.house1', { password: 'geheim-123' });
    await writer.save();
    const before = await readFile(configPath, 'utf-8');

    await expect(
      rekeyConfigFile(configPath, { oldSecret: SECRET_B, newSecret: 'neu-0123456789abcdef' }),
    ).rejects.toThrow();
    expect(await readFile(configPath, 'utf-8')).toBe(before);
  });

  it('encrypts secrets inside arrays (bridges.list[].remotePassword) and reads them back', async () => {
    process.env.ENCRYPTION_SECRET = SECRET_A;
    const writer = new ConfigService(configPath);
    writer.set('bridges.list', [{ name: 'bridge1', remotePassword: 'bruecke-geheim' }]);
    await writer.save();

    const raw = await readFile(configPath, 'utf-8');
    expect(raw).not.toContain('bruecke-geheim');

    const reader = new ConfigService(configPath);
    await reader.load();
    expect(reader.get('bridges.list')[0]).toEqual({ name: 'bridge1', remotePassword: 'bruecke-geheim' });
  });

  it('keeps an empty password empty after a save/load round trip', async () => {
    process.env.ENCRYPTION_SECRET = SECRET_A;
    const writer = new ConfigService(configPath);
    writer.set('plugins.house1', { password: '' });
    await writer.save();

    const reader = new ConfigService(configPath);
    await reader.load();
    expect(reader.get('plugins.house1.password')).toBe('');
  });

  it('rejects a tampered enc2: value instead of loading it', async () => {
    process.env.ENCRYPTION_SECRET = SECRET_A;
    const writer = new ConfigService(configPath);
    writer.set('plugins.house1', { password: 'geheim-123' });
    await writer.save();
    const cfg = JSON.parse(await readFile(configPath, 'utf-8'));
    const [prefix, iv, tag, data] = cfg.plugins.house1.password.split(':');
    const flipped = (parseInt(data.slice(0, 2), 16) ^ 0x01).toString(16).padStart(2, '0') + data.slice(2);
    cfg.plugins.house1.password = [prefix, iv, tag, flipped].join(':');
    await writeFile(configPath, JSON.stringify(cfg), 'utf-8');

    await expect(new ConfigService(configPath).load()).rejects.toThrow(/ENCRYPTION_SECRET/);
  });

  it('reads a legacy enc: (CBC) value written with the old scheme', async () => {
    await writeFile(configPath, JSON.stringify({
      plugins: { house1: { password: legacyEncrypt('alt-geheim-123', SECRET_A, configPath) } },
    }), 'utf-8');
    process.env.ENCRYPTION_SECRET = SECRET_A;
    const reader = new ConfigService(configPath);
    await reader.load();
    expect(reader.get('plugins.house1.password')).toBe('alt-geheim-123');
  });

  it('rekeyConfigFile migrates legacy enc: values (also in arrays) to enc2:', async () => {
    await writeFile(configPath, JSON.stringify({
      plugins: { house1: { password: legacyEncrypt('alt-geheim-123', LEGACY_SECRET, configPath) } },
      bridges: { list: [{ name: 'x', remotePassword: legacyEncrypt('bruecke-alt', LEGACY_SECRET, configPath) }] },
    }), 'utf-8');

    const result = await rekeyConfigFile(configPath, { oldSecret: LEGACY_SECRET, newSecret: SECRET_B });

    expect(result.reencrypted).toBe(2);
    const raw = await readFile(configPath, 'utf-8');
    expect(raw).not.toMatch(/"enc:/);
    process.env.ENCRYPTION_SECRET = SECRET_B;
    const reader = new ConfigService(configPath);
    await reader.load();
    expect(reader.get('plugins.house1.password')).toBe('alt-geheim-123');
    expect(reader.get('bridges.list')[0].remotePassword).toBe('bruecke-alt');
  });

  it('rekeyConfigFile refuses legacy values with a wrong old secret and changes nothing', async () => {
    await writeFile(configPath, JSON.stringify({
      plugins: { house1: { password: legacyEncrypt('alt-geheim-123', LEGACY_SECRET, configPath) } },
    }), 'utf-8');
    const before = await readFile(configPath, 'utf-8');

    await expect(
      rekeyConfigFile(configPath, { oldSecret: SECRET_A, newSecret: SECRET_B }),
    ).rejects.toThrow();
    expect(await readFile(configPath, 'utf-8')).toBe(before);
  });

  it('writes the rekey backup and config.json readable by the owner only', async () => {
    process.env.ENCRYPTION_SECRET = SECRET_A;
    const writer = new ConfigService(configPath);
    writer.set('plugins.house1', { password: 'geheim-123' });
    await writer.save();

    const { backupPath } = await rekeyConfigFile(configPath, { oldSecret: SECRET_A, newSecret: SECRET_B });

    expect((await stat(backupPath)).mode & 0o077).toBe(0);
    expect((await stat(configPath)).mode & 0o077).toBe(0);
  });

  it('save() leaves no temporary file next to config.json', async () => {
    process.env.ENCRYPTION_SECRET = SECRET_A;
    const writer = new ConfigService(configPath);
    writer.set('plugins.house1', { password: 'geheim-123' });
    await writer.save();
    expect(await readdir(dir)).toEqual(['config.json']);
  });

  it('encrypts a plaintext password that merely starts with enc2: or enc:', async () => {
    process.env.ENCRYPTION_SECRET = SECRET_A;
    const writer = new ConfigService(configPath);
    writer.set('plugins.a', { password: 'enc2:meinPasswort' });
    writer.set('plugins.b', { password: 'enc:abc' });
    await writer.save();

    const raw = await readFile(configPath, 'utf-8');
    expect(raw).not.toContain('meinPasswort');
    const reader = new ConfigService(configPath);
    await reader.load();
    expect(reader.get('plugins.a.password')).toBe('enc2:meinPasswort');
    expect(reader.get('plugins.b.password')).toBe('enc:abc');
  });

  it('migrates a legacy password with a tab and a leading BOM unchanged', async () => {
    const tricky = '\uFEFFpass\twort';
    await writeFile(configPath, JSON.stringify({
      plugins: { house1: { password: legacyEncrypt(tricky, LEGACY_SECRET, configPath) } },
    }), 'utf-8');

    await rekeyConfigFile(configPath, { oldSecret: LEGACY_SECRET, newSecret: SECRET_B });

    process.env.ENCRYPTION_SECRET = SECRET_B;
    const reader = new ConfigService(configPath);
    await reader.load();
    expect(reader.get('plugins.house1.password')).toBe(tricky);
  });

  it('rejects a value whose GCM tag was altered', async () => {
    process.env.ENCRYPTION_SECRET = SECRET_A;
    const writer = new ConfigService(configPath);
    writer.set('plugins.house1', { password: 'geheim-123' });
    await writer.save();
    const cfg = JSON.parse(await readFile(configPath, 'utf-8'));
    const [prefix, iv, tag, data] = cfg.plugins.house1.password.split(':');
    const flippedTag = (parseInt(tag.slice(0, 2), 16) ^ 0x01).toString(16).padStart(2, '0') + tag.slice(2);
    cfg.plugins.house1.password = [prefix, iv, flippedTag, data].join(':');
    await writeFile(configPath, JSON.stringify(cfg), 'utf-8');

    await expect(new ConfigService(configPath).load()).rejects.toThrow(/ENCRYPTION_SECRET/);
  });

  it('rejects a stored enc2: value with a truncated tag instead of taking it as plaintext', async () => {
    process.env.ENCRYPTION_SECRET = SECRET_A;
    const writer = new ConfigService(configPath);
    writer.set('plugins.house1', { password: 'geheim-123' });
    await writer.save();
    const cfg = JSON.parse(await readFile(configPath, 'utf-8'));
    const [prefix, iv, tag, data] = cfg.plugins.house1.password.split(':');
    cfg.plugins.house1.password = [prefix, iv, tag.slice(1), data].join(':');
    await writeFile(configPath, JSON.stringify(cfg), 'utf-8');

    await expect(new ConfigService(configPath).load()).rejects.toThrow(/ENCRYPTION_SECRET|corrupt/);
  });
});
