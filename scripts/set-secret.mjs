#!/usr/bin/env node
/**
 * Store one secret encrypted in config.json on the host. The secret comes on stdin
 * only, never on the command line (it would show up in `ps`) and never in
 * any output:
 *
 *   ENCRYPTION_SECRET=… node scripts/set-secret.mjs /opt/mqtt-master/config.json plugins.dreame.password [backup] < secret
 *
 * Remote use over ssh: scripts/set-secret-remote.sh (secret on stdin).
 *
 * Only plugins.<id>.<key> with a sensitive key name (stored encrypted) is
 * accepted. Writes a backup of the loaded config first (owner-only, sensitive
 * values encrypted like save() does, also from a plain-text legacy file:
 * ), next to the config unless a path is given; copied back over
 * the config it restores the old state. Delete it once the plugin logs in
 * with the new value. Stop the
 * service before running it, otherwise its next save() overwrites the change.
 * scripts/set-secret-remote.sh does that (lock, stop, restart on any exit).
 */
import { writeFile } from 'node:fs/promises';
import { ConfigService, isSensitiveKey } from '../server/services/config-service.js';

const MAX_LENGTH = 1024;
const KEY_FORMAT = /^plugins\.[a-z0-9][a-z0-9-]*\.[A-Za-z]+$/;

function refuse(text) {
  console.error(text);
  process.exit(2);
}

const [configPath, key, backupArg] = process.argv.slice(2);
if (!configPath || !key) refuse('usage: set-secret.mjs <config.json> plugins.<id>.<key> [backup]  (secret on stdin)');
if (!process.env.ENCRYPTION_SECRET) refuse('ENCRYPTION_SECRET must be set.');
if (!KEY_FORMAT.test(key) || !isSensitiveKey(key.split('.').at(-1))) {
  refuse(`${key}: only plugins.<id>.<key> with a sensitive key name (password, token, secret …) is allowed`);
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const raw = Buffer.concat(chunks).toString('utf-8');
const value = raw.replace(/\r?\n$/, '');
// the closing newline is required: a pipe cut off mid-way must not be stored
if (!raw.endsWith('\n') || value === '' || /[\r\n]/.test(value) || value.length > MAX_LENGTH) {
  refuse(`secret on stdin must be one non-empty line of at most ${MAX_LENGTH} characters, ending in a newline`);
}
// ConfigService keeps values that look encrypted as they are
if (/^enc2?:/.test(value)) refuse('secret on stdin must not start with enc: or enc2:');

const svc = new ConfigService(configPath);
try {
  await svc.load();
} catch {
  // no err.message: a JSON parse error quotes parts of the file
  console.error(`${configPath} does not load with ENCRYPTION_SECRET, nothing changed`);
  process.exit(1);
}

const backupPath = backupArg || `${configPath}.vor-set-secret-${new Date().toISOString().replace(/[:.]/g, '-')}`;
try {
  // created owner-only and never over an existing file
  await writeFile(backupPath, svc.serialize(), { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
  svc.set(key, value);
  await svc.save();
} catch (err) {
  console.error(`Saving failed (${err.code ?? 'error'}), ${configPath} unchanged or replaced as a whole`);
  process.exit(1);
}
console.log(`${key} stored encrypted in ${configPath}, backup: ${backupPath}`);
