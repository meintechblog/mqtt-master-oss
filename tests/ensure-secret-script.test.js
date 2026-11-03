/**
 * scripts/ensure-secret.sh – legt das ENCRYPTION_SECRET an (install.sh) bzw.
 * prüft es vor einem Update (run-update.sh). #3/#4:
 * Eine Bestandsinstallation mit verschlüsselten Altwerten bekommt nie still
 * ein neues Geheimnis (der Dienst würde danach nicht mehr starten).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '../scripts/ensure-secret.sh');

function run(args) {
  return spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf-8' });
}

describe('scripts/ensure-secret.sh', () => {
  let dir;
  let configPath;
  let secretFile;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mqtt-master-ensure-'));
    configPath = join(dir, 'config.json');
    secretFile = join(dir, 'etc', 'env');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates an owner-only secret file on a fresh install', async () => {
    const res = run(['anlegen', configPath, secretFile]);
    expect(res.status).toBe(0);
    const content = await readFile(secretFile, 'utf-8');
    expect(content).toMatch(/^ENCRYPTION_SECRET=[0-9a-f]{64}\n$/);
    expect((await stat(secretFile)).mode & 0o077).toBe(0);
  });

  it('never overwrites an existing secret file', async () => {
    run(['anlegen', configPath, secretFile]);
    const first = await readFile(secretFile, 'utf-8');
    const res = run(['anlegen', configPath, secretFile]);
    expect(res.status).toBe(0);
    expect(await readFile(secretFile, 'utf-8')).toBe(first);
  });

  it('refuses to invent a secret when config.json already holds encrypted values', async () => {
    await writeFile(configPath, JSON.stringify({ plugins: { x: { password: 'enc:00:11' } } }));
    const res = run(['anlegen', configPath, secretFile]);
    expect(res.status).toBe(3);
    expect(res.stderr).toContain('README.md');
    expect(existsSync(secretFile)).toBe(false);
  });

  it('check mode fails without a secret file and passes with one', async () => {
    expect(run(['pruefen', configPath, secretFile]).status).toBe(3);
    run(['anlegen', configPath, secretFile]);
    expect(run(['pruefen', configPath, secretFile]).status).toBe(0);
  });
});
