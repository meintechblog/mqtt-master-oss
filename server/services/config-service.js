import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/** Strict UTF-8: a wrong key on the legacy CBC path yields bytes that fail here. */
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

const DEFAULTS = {
  mqtt: {
    broker: 'mqtt://localhost:1883',
  },
  web: {
    port: 80,
  },
  logLevel: 'info',
  pluginDir: '/opt/mqtt-master/plugins',
  topicPrefix: 'mqtt-master',
};

/**
 * Prefixes of encrypted values in config.json.
 * `enc2:` = AES-256-GCM (authenticated: a wrong secret always fails).
 * `enc:`  = legacy AES-256-CBC, still readable; rekeyConfigFile() converts it.
 */
const ENC_PREFIX = 'enc2:';
const LEGACY_ENC_PREFIX = 'enc:';

// Full format, not just the prefix: a plaintext password like
// "enc2:meinPasswort" must still be encrypted.
const ENC_FORMAT = /^enc2:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]*$/;
const LEGACY_ENC_FORMAT = /^enc:[0-9a-f]{32}:(?:[0-9a-f]{32})+$/;

function isEncrypted(value) {
  return ENC_FORMAT.test(value) || LEGACY_ENC_FORMAT.test(value);
}

/** A stored value that claims to be encrypted (prefix); must then match the format. */
function looksEncrypted(value) {
  return value.startsWith(ENC_PREFIX) || value.startsWith(LEGACY_ENC_PREFIX);
}

/** Fields that must be encrypted when stored (matched by key name) */
const SENSITIVE_KEYS = ['password', 'token', 'secret', 'apiKey', 'apikey', 'credentials'];

/**
 * Derive the encryption key from ENCRYPTION_SECRET, salted with the config
 * path so the key is unique per installation. Fails closed: without a secret the service refuses to start instead of
 * falling back to a key everyone can read in the source.
 */
function deriveKey(configPath, secret = process.env.ENCRYPTION_SECRET) {
  if (!secret) {
    throw new Error(
      'ENCRYPTION_SECRET is not set - refusing to start. ' +
      'Provide it via the systemd EnvironmentFile.',
    );
  }
  return scryptSync(secret, `mqtt-master:${configPath}`, 32);
}

function encrypt(text, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decrypt(encryptedStr, key) {
  if (ENC_FORMAT.test(encryptedStr)) {
    const [ivHex, tagHex, dataHex] = encryptedStr.slice(ENC_PREFIX.length).split(':');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
  }
  if (LEGACY_ENC_FORMAT.test(encryptedStr)) {
    // CBC has no authentication: with a wrong key the padding check passes in
    // about 1 of 256 cases and returns garbage. Garbage is rejected by strict
    // UTF-8 decoding and the control-character check.
    const [ivHex, encrypted] = encryptedStr.slice(LEGACY_ENC_PREFIX.length).split(':');
    const decipher = createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'));
    const bytes = Buffer.concat([decipher.update(Buffer.from(encrypted, 'hex')), decipher.final()]);
    const text = STRICT_UTF8.decode(bytes);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new Error('legacy value does not decode');
    return text;
  }
  throw new Error('corrupt encrypted value');
}

/**
 * Walk objects and arrays (e.g. bridges.list[].remotePassword) and replace
 * every string for which `test(value, key)` holds by `fn(value, key)`.
 * Array elements inherit the key of their array. Returns the count.
 */
function mapStringsDeep(node, test, fn, key = '') {
  let count = 0;
  const entries = Array.isArray(node) ? node.map((v, i) => [i, v]) : Object.entries(node);
  for (const [k, val] of entries) {
    const name = Array.isArray(node) ? key : k;
    if (val && typeof val === 'object') {
      count += mapStringsDeep(val, test, fn, name);
    } else if (typeof val === 'string' && test(val, name)) {
      node[k] = fn(val, name);
      count++;
    }
  }
  return count;
}

/** Reading side (load, rekey): every value with an enc prefix must decrypt. */
function mapEncryptedDeep(obj, fn) {
  return mapStringsDeep(obj, (val) => looksEncrypted(val), fn);
}

/**
 * Replace a file atomically (temp file + rename), readable by the owner only.
 * A crash mid-write leaves the old file intact.
 */
async function writeFileAtomic(path, content) {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    await writeFile(tmp, content, { encoding: 'utf-8', mode: 0o600 });
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * One-time migration: decrypt every value with `oldSecret` and re-encrypt it
 * with `newSecret`. The old file is kept next to the config.
 * Nothing is written if any value fails to decrypt with the old secret.
 * Used on the host via scripts/rekey-config.mjs.
 */
export async function rekeyConfigFile(configPath, { oldSecret, newSecret }) {
  const oldKey = deriveKey(configPath, oldSecret);
  const newKey = deriveKey(configPath, newSecret);
  const raw = await readFile(configPath, 'utf-8');
  const config = JSON.parse(raw);
  const reencrypted = mapEncryptedDeep(config, (val) => encrypt(decrypt(val, oldKey), newKey));
  const backupPath = `${configPath}.vor-umschluesseln-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  await writeFile(backupPath, raw, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
  await writeFileAtomic(configPath, JSON.stringify(config, null, 2));
  return { reencrypted, backupPath };
}

/** Check if a key name is sensitive (also used to mask API responses) */
export function isSensitiveKey(key) {
  const lower = key.toLowerCase();
  return SENSITIVE_KEYS.some(s => lower === s.toLowerCase() || lower.endsWith(s.toLowerCase()));
}

export class ConfigService {
  constructor(configPath) {
    this.configPath = configPath;
    this.config = this._deepMerge({}, DEFAULTS);
    this._encKey = deriveKey(configPath);
  }

  async load() {
    if (!existsSync(this.configPath)) {
      return; // Use defaults
    }
    // Fail closed: an unreadable config or a value that does not decrypt
    // stops the start. Continuing with defaults would overwrite config.json
    // on the next save() (e.g. the 6-h update check).
    let fileConfig;
    try {
      fileConfig = JSON.parse(await readFile(this.configPath, 'utf-8'));
    } catch (err) {
      throw new Error(`Cannot read config ${this.configPath}: ${err.message} - refusing to start`);
    }
    this._decryptDeep(fileConfig);
    this.config = this._deepMerge(DEFAULTS, fileConfig);
  }

  get(key, fallback) {
    const keys = key.split('.');
    let val = this.config;
    for (const k of keys) {
      if (val == null || typeof val !== 'object') return fallback;
      val = val[k];
    }
    return val !== undefined ? val : fallback;
  }

  set(key, value) {
    const keys = key.split('.');
    let obj = this.config;
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i];
      if (obj[k] == null || typeof obj[k] !== 'object') {
        obj[k] = {};
      }
      obj = obj[k];
    }
    obj[keys[keys.length - 1]] = value;
  }

  async save() {
    await writeFileAtomic(this.configPath, this.serialize());
  }

  /**
   * The file content save() writes: sensitive values encrypted with the key
   * of this config path, so a copy only loads again at this path.
   */
  serialize() {
    const toSave = JSON.parse(JSON.stringify(this.config));
    this._encryptDeep(toSave);
    return JSON.stringify(toSave, null, 2);
  }

  /** Recursively encrypt sensitive string values, also inside arrays */
  _encryptDeep(obj) {
    mapStringsDeep(
      obj,
      (val, key) => isSensitiveKey(key) && !isEncrypted(val),
      (val) => encrypt(val, this._encKey),
    );
  }

  /** Recursively decrypt sensitive string values; throws on a wrong secret */
  _decryptDeep(obj) {
    mapEncryptedDeep(obj, (val, key) => {
      try {
        return decrypt(val, this._encKey);
      } catch {
        throw new Error(
          `Cannot decrypt config value "${key}" - wrong ENCRYPTION_SECRET?`,
        );
      }
    });
  }

  _deepMerge(target, source) {
    const result = { ...target };
    for (const key of Object.keys(source)) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        result[key] = this._deepMerge(target[key] || {}, source[key]);
      } else {
        result[key] = source[key];
      }
    }
    return result;
  }
}
