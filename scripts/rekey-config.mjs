#!/usr/bin/env node
/**
 * One-time re-encryption of config.json with a new ENCRYPTION_SECRET
 *. Both secrets come from the environment, never from
 * the command line (they would show up in `ps`):
 *
 *   ENCRYPTION_SECRET_ALT=<old> ENCRYPTION_SECRET=<new> \
 *     node scripts/rekey-config.mjs /opt/mqtt-master/config.json
 *
 * Writes a backup next to the config first. Changes nothing if a value does
 * not decrypt with the old secret. Stop the service before running it.
 *
 *   ENCRYPTION_SECRET=<secret> node scripts/rekey-config.mjs --pruefen [config.json]
 *
 * only checks that the config loads with ENCRYPTION_SECRET (exit 0) or not
 * (exit 1). run-update.sh calls it before restarting the service.
 */
import { ConfigService, rekeyConfigFile } from '../server/services/config-service.js';

const args = process.argv.slice(2);
const checkOnly = args[0] === '--pruefen';
if (checkOnly) args.shift();
const configPath = args[0] || '/opt/mqtt-master/config.json';

if (checkOnly) {
  try {
    await new ConfigService(configPath).load();
    console.log(`${configPath} loads with ENCRYPTION_SECRET`);
    process.exit(0);
  } catch (err) {
    console.error(`${configPath} does not load: ${err.message}`);
    process.exit(1);
  }
}

const oldSecret = process.env.ENCRYPTION_SECRET_ALT;
const newSecret = process.env.ENCRYPTION_SECRET;

if (!oldSecret || !newSecret) {
  console.error('ENCRYPTION_SECRET_ALT (old) and ENCRYPTION_SECRET (new) must both be set.');
  process.exit(2);
}

try {
  const { reencrypted, backupPath } = await rekeyConfigFile(configPath, { oldSecret, newSecret });
  console.log(`${reencrypted} value(s) re-encrypted in ${configPath}, backup: ${backupPath}`);
} catch (err) {
  console.error(`Rekey failed, ${configPath} unchanged: ${err.message}`);
  process.exit(1);
}
