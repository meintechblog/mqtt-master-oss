/**
 * Loxone WebSocket client with token-based authentication, binary protocol
 * parser, and reconnection.
 *
 * Implements the full Loxone v16.x token-based auth flow:
 *   1. Fetch RSA public key via HTTP
 *   2. Open WebSocket (no auth headers)
 *   3. Generate AES-256-CBC session key + IV
 *   4. RSA-encrypt and exchange session key
 *   5. Request getkey2 for user (encrypted)
 *   6. Compute password hash (SHA1/SHA256) using raw salt from getkey2
 *   7. Compute HMAC token hash using hex-decoded key from getkey2
 *   8. Request JWT via AES-encrypted command
 *   9. Enable binary status updates
 */
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import http from 'node:http';
import WebSocket from 'ws';

const HEADER_SIZE = 8;
const VALUE_EVENT_SIZE = 24;
const KEEPALIVE_INTERVAL = 60_000;
const KEEPALIVE_TIMEOUT = 15_000;
const MAX_BACKOFF = 30_000;
const CONNECT_TIMEOUT = 30_000;
const CMD_TIMEOUT = 10_000;

const CLIENT_UUID = '1a2b3c4d-0000-0000-ffff00000000c005';
const CLIENT_INFO = 'mqtt-master';
const SALT_BYTES = 16;

export class LoxoneWs extends EventEmitter {
  /**
   * @param {{ host: string, port: number, user: string, pass: string }} opts
   */
  constructor({ host, port, user, pass, logger } = {}) {
    super();
    this._host = host;
    this._port = port;
    this._user = user;
    this._pass = pass;

    // Optional structured logger. Defaults to a minimal console adapter so
    // plugin authors that don't pass one still get the lifecycle events.
    this._log = logger ? logger : {
      info: (...a) => console.log('[loxone-ws]', ...a),
      warn: (...a) => console.warn('[loxone-ws]', ...a),
      error: (...a) => console.error('[loxone-ws]', ...a),
      debug: () => {},
    };

    /** @type {WebSocket|null} */
    this._ws = null;
    this._state = 'HEADER';
    this._pendingHeader = null;
    this._connected = false;
    this._authenticated = false;
    this._reconnectAttempt = 0;
    this._shouldReconnect = true;

    // Lifecycle audit fields surfaced via getConnectionStats() so the UI and
    // future debug sessions can answer "did the Miniserver bounce?" without
    // hand-grepping journalctl.
    this._connectedSince = null;
    this._lastConnectedAt = null;
    this._lastDisconnectAt = null;
    this._lastDisconnectCode = null;
    this._lastConnectError = null;
    this._totalConnects = 0;
    this._totalDisconnects = 0;
    this._totalReconnects = 0;
    this._currentReconnectAttempt = 0;
    this._nextReconnectAt = null;

    // AES session key material
    this._aesKey = null;   // Buffer, 32 bytes
    this._aesIv = null;    // Buffer, 16 bytes
    this._currentSalt = null;
    this._saltUsageCount = 0;
    this._maxSaltUsage = 20;
    this._nextSaltTime = 0;
    this._maxSaltTime = 30_000;

    // RSA public key (PEM)
    this._publicKey = null;

    // Pending text responses: resolve/reject waiting for LL response
    this._pendingCmd = null;

    // Timers
    this._keepaliveInterval = null;
    this._keepaliveTimeout = null;
    this._reconnectTimer = null;
  }

  /**
   * Build WebSocket URL.
   * @returns {string}
   */
  _buildUrl() {
    return `ws://${this._host}:${this._port}/ws/rfc6455`;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Connect to the Miniserver WebSocket with full token-based auth.
   * @returns {Promise<void>}
   */
  async connect() {
    this._shouldReconnect = true;
    return this._doConnect(false);
  }

  /**
   * Disconnect cleanly, stopping all timers.
   * @returns {Promise<void>}
   */
  async disconnect() {
    this._shouldReconnect = false;
    this._stopTimers();

    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    if (this._ws) {
      return new Promise((resolve) => {
        if (this._ws.readyState === WebSocket.CLOSED) {
          this._ws = null;
          resolve();
          return;
        }
        this._ws.once('close', () => {
          this._ws = null;
          resolve();
        });
        this._ws.close();
      });
    }
  }

  /**
   * Send a plain text command to the Miniserver (after auth, most commands
   * can be sent unencrypted).
   * @param {string} cmd
   */
  sendCommand(cmd) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
      // SILENT no-op was the bug: writes from input bindings vanished while
      // the binding stats happily said "sent=X". Surface it now so a future
      // session can spot it in journalctl.
      this._log.warn?.(`[loxone] sendCommand DROPPED (ws not open, readyState=${this._ws?.readyState ?? 'null'}): ${cmd}`);
      return;
    }
    try {
      this._ws.send(cmd);
      // Binding-write tracing: only log jdev/sps/io commands at info level
      // (keepalives etc. would spam the journal).
      if (cmd.startsWith('jdev/sps/io/')) {
        this._log.info?.(`[loxone] → ${cmd}`);
      }
    } catch (err) {
      this._log.warn?.(`[loxone] sendCommand FAILED, forcing close: ${err.message}`);
      // Underlying socket failed -- force a hard close so the reconnect path runs.
      this._forceClose();
    }
  }

  /**
   * Send a command and wait for the LL response.
   * @param {string} cmd
   * @returns {Promise<{ control: string, code: number, value: string }>}
   */
  sendCommandAsync(cmd) {
    return new Promise((resolve, reject) => {
      if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket not connected'));
        return;
      }

      const timeout = setTimeout(() => {
        this._pendingCmd = null;
        reject(new Error(`Command timeout: ${cmd}`));
      }, CMD_TIMEOUT);

      this._pendingCmd = { resolve, timeout };
      this._ws.send(cmd);
    });
  }

  // ---------------------------------------------------------------------------
  // Connection and authentication
  // ---------------------------------------------------------------------------

  /**
   * @param {boolean} isReconnect
   * @returns {Promise<void>}
   */
  async _doConnect(isReconnect) {
    const start = Date.now();
    this._log.info(`[loxone] ${isReconnect ? 'reconnecting' : 'connecting'} to ${this._host}:${this._port}${isReconnect ? ` (attempt #${this._currentReconnectAttempt})` : ''}`);
    try {
      // Step 1: fetch public key via HTTP
      this._publicKey = await this._fetchPublicKey();

      // Step 2: open WebSocket (NO auth headers)
      await this._openWebSocket(isReconnect);

      // Steps 3-9: authenticate
      await this._authenticate();

      // Connection + auth complete — record lifecycle stats and log.
      const now = Date.now();
      this._connectedSince = now;
      this._lastConnectedAt = now;
      this._totalConnects += 1;
      if (isReconnect) this._totalReconnects += 1;
      this._currentReconnectAttempt = 0;
      this._nextReconnectAt = null;
      this._lastConnectError = null;
      this._log.info(`[loxone] ${isReconnect ? 'reconnected' : 'connected'} in ${now - start}ms (totalConnects=${this._totalConnects}, totalReconnects=${this._totalReconnects})`);
    } catch (err) {
      this._lastConnectError = err?.message || String(err);
      this._log.warn(`[loxone] ${isReconnect ? 'reconnect' : 'connect'} failed: ${this._lastConnectError}`);
      throw err;
    }
  }

  /**
   * Fetch the RSA public key from the Miniserver via HTTP.
   * GET /jdev/sys/getPublicKey -- Loxone returns the SubjectPublicKeyInfo
   * wrapped in CERTIFICATE tags (it is NOT an X.509 cert).
   * @returns {Promise<string>} PEM-formatted public key
   */
  _fetchPublicKey() {
    return new Promise((resolve, reject) => {
      const req = http.get(
        `http://${this._host}:${this._port}/jdev/sys/getPublicKey`,
        { timeout: CMD_TIMEOUT },
        (res) => {
          let body = '';
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => {
            try {
              const json = JSON.parse(body);
              let pem = json.LL?.value || '';
              pem = pem.replace(/^"/, '').replace(/"$/, '');
              // Replace CERTIFICATE with PUBLIC KEY (Loxone uses wrong tags)
              pem = pem.replace(/CERTIFICATE/g, 'PUBLIC KEY');
              // Ensure line breaks around headers
              pem = pem.replace(/^(-+BEGIN PUBLIC KEY-+)(\w)/, '$1\n$2');
              pem = pem.replace(/(-+END PUBLIC KEY-+)/, '\n$1');
              resolve(pem);
            } catch (err) {
              reject(new Error(`Failed to parse public key response: ${err.message}`));
            }
          });
        },
      );
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Public key request timeout')); });
    });
  }

  /**
   * Open the raw WebSocket connection (no auth headers).
   * @param {boolean} isReconnect
   * @returns {Promise<void>}
   */
  _openWebSocket(isReconnect) {
    return new Promise((resolve, reject) => {
      const url = this._buildUrl();
      const timeout = setTimeout(() => {
        reject(new Error('WebSocket connection timeout'));
      }, CONNECT_TIMEOUT);

      try {
        this._ws = new WebSocket(url, 'remotecontrol');
      } catch (err) {
        clearTimeout(timeout);
        reject(err);
        return;
      }

      this._ws.on('open', () => {
        clearTimeout(timeout);
        this._connected = true;
        this._reconnectAttempt = 0;
        this._state = 'HEADER';
        this._pendingHeader = null;
        resolve();
      });

      this._ws.on('message', (data, isBinary) => {
        this._onMessage(data, isBinary);
      });

      this._ws.on('close', (code, _reason) => {
        clearTimeout(timeout);
        const wasConnected = this._connected;
        this._connected = false;
        this._authenticated = false;
        this._stopTimers();

        const now = Date.now();
        this._lastDisconnectAt = now;
        this._lastDisconnectCode = code;
        const sessionMs = this._connectedSince ? now - this._connectedSince : null;
        this._connectedSince = null;
        if (wasConnected) {
          this._totalDisconnects += 1;
          this._log.warn(`[loxone] disconnected from ${this._host} (code=${code}, session=${sessionMs}ms)`);
        }
        this.emit('disconnected');

        if (!wasConnected) {
          reject(new Error(`WebSocket closed before open (code: ${code})`));
          return;
        }

        if (this._shouldReconnect) {
          this._scheduleReconnect();
        }
      });

      this._ws.on('error', (err) => {
        clearTimeout(timeout);
        if (this.listenerCount('error') > 0) {
          this.emit('error', err);
        }
        if (!this._connected) {
          reject(err);
        }
      });
    });
  }

  /**
   * Perform the full authentication handshake on an already-open WebSocket.
   * @returns {Promise<void>}
   */
  async _authenticate() {
    // Step 3: generate AES session key and IV
    this._aesIv = crypto.randomBytes(16);
    this._aesKey = crypto.createHash('sha256')
      .update(crypto.randomBytes(16).toString('hex'))
      .digest();
    const sessionKeyStr = `${this._aesKey.toString('hex')}:${this._aesIv.toString('hex')}`;

    // Step 4: RSA-encrypt session key and exchange
    const publicKey = {
      key: this._publicKey,
      padding: crypto.constants.RSA_PKCS1_PADDING,
    };
    const encrypted = crypto.publicEncrypt(
      publicKey,
      Buffer.from(sessionKeyStr),
    );

    const keyExResp = await this._sendAndWait(
      `jdev/sys/keyexchange/${encrypted.toString('base64')}`,
    );
    if (keyExResp.code !== '200' && keyExResp.code !== 200) {
      throw new Error(`Key exchange failed: code ${keyExResp.code}`);
    }

    // Step 5: initialize salt
    this._currentSalt = this._generateSalt();
    this._saltUsageCount = 0;
    this._nextSaltTime = Date.now() + this._maxSaltTime;

    // Step 6: get key2 (MUST be sent encrypted)
    const key2Resp = await this._sendEncrypted(`jdev/sys/getkey2/${this._user}`);
    if (key2Resp.code !== '200' && key2Resp.code !== 200) {
      throw new Error(`getkey2 failed: code ${key2Resp.code}`);
    }

    let key2Data;
    if (typeof key2Resp.value === 'string') {
      key2Data = JSON.parse(key2Resp.value);
    } else {
      key2Data = key2Resp.value;
    }

    // Key: hex-decode from JSON to get the ASCII hex key string
    const oneTimeKey = Buffer.from(key2Data.key, 'hex').toString('utf8');
    // Salt: use AS-IS from JSON (do NOT hex-decode)
    const userSalt = key2Data.salt;
    const hashAlg = (key2Data.hashAlg || 'SHA1').toUpperCase();
    const nodeHashAlg = hashAlg === 'SHA1' ? 'sha1' : 'sha256';

    // Step 7: compute password hash
    // pwHash = UPPERCASE(HEX(SHA1("{password}:{salt}")))
    const pwHash = crypto.createHash(nodeHashAlg)
      .update(`${this._pass}:${userSalt}`)
      .digest('hex')
      .toUpperCase();

    // Step 8: compute HMAC token hash
    // hash = HEX(HMAC-SHA1("{user}:{pwHash}", oneTimeKey))
    // oneTimeKey is the HMAC key as a UTF-8 string
    const hash = crypto.createHmac(nodeHashAlg, oneTimeKey)
      .update(`${this._user}:${pwHash}`)
      .digest('hex');

    // Step 9: request JWT token (AES-encrypted)
    const permission = 4; // App permission (long-lived)
    const info = encodeURIComponent(CLIENT_INFO);
    const jwtCmd = `jdev/sys/getjwt/${hash}/${this._user}/${permission}/${CLIENT_UUID}/${info}`;

    const jwtResp = await this._sendEncrypted(jwtCmd);
    if (jwtResp.code !== '200' && jwtResp.code !== 200) {
      throw new Error(`getjwt failed: code ${jwtResp.code}`);
    }

    this._authenticated = true;

    // Step 10: enable binary status updates
    this.sendCommand('jdev/sps/enablebinstatusupdate');

    // Start keepalive
    this._startKeepalive();

    this.emit('connected');
  }

  // ---------------------------------------------------------------------------
  // AES encryption
  // ---------------------------------------------------------------------------

  /**
   * Generate a random salt string.
   * @returns {string}
   */
  _generateSalt() {
    return encodeURIComponent(crypto.randomBytes(SALT_BYTES).toString('hex'));
  }

  /**
   * Check if a new salt is needed (after max usage count or timeout).
   * @returns {boolean}
   */
  _isNewSaltNeeded() {
    if (this._saltUsageCount <= 0) {
      this._nextSaltTime = Date.now() + this._maxSaltTime;
    }
    this._saltUsageCount++;
    if (
      this._saltUsageCount >= this._maxSaltUsage
      || this._nextSaltTime < Date.now()
    ) {
      this._saltUsageCount = 0;
      return true;
    }
    return false;
  }

  /**
   * AES-256-CBC encrypt with PKCS7 padding (Node.js default).
   * Appends a \0 byte to the plaintext before encryption (Loxone convention).
   * @param {string} plaintext
   * @returns {string} base64 ciphertext
   */
  _aesEncrypt(plaintext) {
    const cipher = crypto.createCipheriv('aes-256-cbc', this._aesKey, this._aesIv);
    let encrypted = cipher.update(plaintext + '\0', 'utf-8', 'base64');
    encrypted += cipher.final('base64');
    return encrypted;
  }

  /**
   * Send an AES-encrypted command with salt prefix.
   * First command:  salt/{currentSalt}/{cmd}
   * Subsequent (when salt needs rotation): nextSalt/{currentSalt}/{newSalt}/{cmd}
   *
   * @param {string} cmd
   * @returns {Promise<{code: string|number, value: any}>}
   */
  async _sendEncrypted(cmd) {
    let saltPart = `salt/${this._currentSalt}`;
    if (this._isNewSaltNeeded()) {
      saltPart = `nextSalt/${this._currentSalt}/`;
      this._currentSalt = this._generateSalt();
      saltPart += this._currentSalt;
    }

    const plaintext = `${saltPart}/${cmd}`;
    const ciphertext = this._aesEncrypt(plaintext);
    const encoded = encodeURIComponent(ciphertext);
    return this._sendAndWait(`jdev/sys/enc/${encoded}`);
  }

  // ---------------------------------------------------------------------------
  // Command send/wait (text responses)
  // ---------------------------------------------------------------------------

  /**
   * Send a text command and wait for the JSON text response from the Miniserver.
   * Loxone sends text responses as JSON: { LL: { control: "...", code: "200", value: ... } }
   * @param {string} cmd
   * @returns {Promise<{code: string|number, value: any, control: string}>}
   */
  _sendAndWait(cmd) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._pendingCmd = null;
        reject(new Error(`Command timeout: ${cmd.substring(0, 80)}`));
      }, CMD_TIMEOUT);

      this._pendingCmd = { resolve, reject, timeout };
      this._ws.send(cmd);
    });
  }

  // ---------------------------------------------------------------------------
  // Message handling
  // ---------------------------------------------------------------------------

  /**
   * Handle incoming WebSocket message.
   * Routes binary messages through the state machine, text to response or event.
   * @param {Buffer} data
   * @param {boolean} isBinary
   */
  _onMessage(data, isBinary) {
    if (!isBinary) {
      const text = data.toString();

      // Check if we're waiting for a text payload after a 0x00 header (only after auth)
      if (this._authenticated && this._state === 'PAYLOAD' && this._pendingHeader && this._pendingHeader.identifier === 0x00) {
        // This text frame is the payload for the preceding binary header
        this._state = 'HEADER';
        this._pendingHeader = null;
        this.emit('textStateEvent', text);
        return;
      }

      // Try to parse as JSON response for pending command
      try {
        const json = JSON.parse(text);
        if (json.LL && this._pendingCmd) {
          const { resolve, timeout } = this._pendingCmd;
          this._pendingCmd = null;
          clearTimeout(timeout);
          resolve({
            control: json.LL.control || json.LL.Control,
            code: json.LL.code ?? json.LL.Code,
            value: json.LL.value ?? json.LL.Value,
          });
          return;
        }
      } catch {
        // Not JSON -- fall through
      }

      this.emit('textMessage', text);
      return;
    }

    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);

    if (this._state === 'HEADER') {
      if (buf.length < HEADER_SIZE) return;

      const header = this._processHeader(buf);
      this._pendingHeader = header;

      if (header.identifier === 0x06) {
        // Keepalive response -- reset watchdog
        this._resetKeepaliveWatchdog();
        if (header.length === 0) {
          this._state = 'HEADER';
          this._pendingHeader = null;
          return;
        }
      }

      if (header.length === 0) {
        this._state = 'HEADER';
        this._pendingHeader = null;
        return;
      }

      this._state = 'PAYLOAD';
    } else if (this._state === 'PAYLOAD') {
      this._processPayload(buf);
      this._state = 'HEADER';
      this._pendingHeader = null;
    }
  }

  /**
   * Parse 8-byte binary header.
   * @param {Buffer} buffer
   * @returns {{ identifier: number, length: number }}
   */
  _processHeader(buffer) {
    const identifier = buffer[1];
    const length = buffer.readUInt32LE(4);
    return { identifier, length };
  }

  /**
   * Dispatch payload based on pending header identifier.
   * @param {Buffer} buffer
   */
  _processPayload(buffer) {
    if (!this._pendingHeader) return;

    switch (this._pendingHeader.identifier) {
      case 0x02: // Value events
        this._parseValueEvents(buffer);
        break;
      case 0x03: // Text events
        this._parseTextEvents(buffer);
        break;
      default:
        // Log unknown identifiers for debugging
        this.emit('debugPayload', { identifier: this._pendingHeader.identifier, length: buffer.length });
        break;
    }
  }

  /**
   * Parse value event payload: 24-byte chunks (16-byte UUID + 8-byte double).
   * @param {Buffer} buffer
   */
  _parseValueEvents(buffer) {
    const count = Math.floor(buffer.length / VALUE_EVENT_SIZE);
    const dv = new DataView(buffer.buffer, buffer.byteOffset, buffer.length);

    for (let i = 0; i < count; i++) {
      const offset = i * VALUE_EVENT_SIZE;
      const uuid = this._uuidFromBuffer(buffer, offset);
      const value = dv.getFloat64(offset + 16, true); // littleEndian
      this.emit('valueEvent', { uuid, value });
    }
  }

  /**
   * Parse text event payload (EvDataText in Loxone "Communicating with the Miniserver"):
   * 16-byte UUID + 16-byte icon UUID + 4-byte textLen + UTF-8 text, padded to a multiple of 4.
   * @param {Buffer} buffer
   */
  _parseTextEvents(buffer) {
    let offset = 0;

    while (offset < buffer.length) {
      if (offset + 36 > buffer.length) break; // minimum: 16 UUID + 16 icon UUID + 4 length

      const uuid = this._uuidFromBuffer(buffer, offset);
      offset += 16;

      // 16 bytes icon UUID (only used by the "Status" control -- unused here)
      offset += 16;

      // 4 bytes text length (LE uint32)
      const textLen = buffer.readUInt32LE(offset);
      offset += 4;

      if (offset + textLen > buffer.length) break;

      // Read text as null-terminated UTF-8
      let text = buffer.toString('utf-8', offset, offset + textLen);
      // Strip null terminator if present
      const nullIdx = text.indexOf('\0');
      if (nullIdx >= 0) text = text.substring(0, nullIdx);

      this.emit('textEvent', { uuid, text });
      offset += textLen;

      // Align to 4-byte boundary
      const remainder = offset % 4;
      if (remainder > 0) offset += 4 - remainder;
    }
  }

  /**
   * Read 16 bytes as a formatted UUID string with Loxone-specific byte order.
   * First 3 groups: little-endian (4 bytes, 2 bytes, 2 bytes)
   * Last 2 groups: big-endian (2 bytes, 6 bytes)
   * @param {Buffer} buf
   * @param {number} offset
   * @returns {string}
   */
  _uuidFromBuffer(buf, offset) {
    // Group 1: 4 bytes LE
    const g1 = buf.readUInt32LE(offset).toString(16).padStart(8, '0');
    // Group 2: 2 bytes LE
    const g2 = buf.readUInt16LE(offset + 4).toString(16).padStart(4, '0');
    // Group 3: 2 bytes LE
    const g3 = buf.readUInt16LE(offset + 6).toString(16).padStart(4, '0');
    // Group 4: 2 bytes BE
    const g4 = buf.readUInt16BE(offset + 8).toString(16).padStart(4, '0');
    // Group 5: 6 bytes BE -- read as hex string
    const g5 = buf.slice(offset + 10, offset + 16).toString('hex').padStart(12, '0');

    // Loxone UUID format: 8-4-4-16 (groups 4+5 are NOT separated by dash)
    return `${g1}-${g2}-${g3}-${g4}${g5}`;
  }

  // ---------------------------------------------------------------------------
  // Keepalive
  // ---------------------------------------------------------------------------

  /**
   * Start keepalive interval (sends "keepalive" every 60s).
   */
  _startKeepalive() {
    this._stopTimers();
    this._keepaliveInterval = setInterval(() => {
      this.sendCommand('keepalive');
      this._startKeepaliveWatchdog();
    }, KEEPALIVE_INTERVAL);
  }

  /**
   * Start watchdog timer for keepalive response.
   */
  _startKeepaliveWatchdog() {
    if (this._keepaliveTimeout) clearTimeout(this._keepaliveTimeout);
    this._keepaliveTimeout = setTimeout(() => {
      // Hard-close: a dead Miniserver never finishes the WS close handshake,
      // which would leave the socket stuck in CLOSING and skip the reconnect path.
      this._forceClose();
    }, KEEPALIVE_TIMEOUT);
  }

  /**
   * Force the WebSocket shut via TCP RST so the close handler always fires,
   * even when the peer is unresponsive.
   */
  _forceClose() {
    if (!this._ws) return;
    try {
      this._ws.terminate();
    } catch {
      // ignore; close handler will still run
    }
  }

  /**
   * Reset the keepalive watchdog (response received).
   */
  _resetKeepaliveWatchdog() {
    if (this._keepaliveTimeout) {
      clearTimeout(this._keepaliveTimeout);
      this._keepaliveTimeout = null;
    }
  }

  /**
   * Stop keepalive and watchdog timers.
   */
  _stopTimers() {
    if (this._keepaliveInterval) {
      clearInterval(this._keepaliveInterval);
      this._keepaliveInterval = null;
    }
    this._resetKeepaliveWatchdog();
  }

  // ---------------------------------------------------------------------------
  // Reconnect
  // ---------------------------------------------------------------------------

  /**
   * Schedule a reconnection attempt with exponential backoff.
   *
   * Self-healing: when the setTimeout callback's _doConnect rejects we MUST
   * reschedule from inside the catch. The pre-WebSocket failure path
   * (_fetchPublicKey throws because the Miniserver returned HTML during a
   * boot/save) never produces a 'close' event, so relying on the close
   * handler alone strands the chain at attempt #1 forever.
   *
   * Idempotent: if a timer is already armed (e.g. close handler + post-failure
   * path race after an established WS dies), the second call is a no-op.
   */
  _scheduleReconnect() {
    // Idempotency guard: a concurrent close-handler + post-failure path must
    // not stack two timers. If one is already armed, this call is a no-op.
    if (this._reconnectTimer) return;

    const delay = this._calcBackoff(this._reconnectAttempt);
    this._reconnectAttempt++;
    this._currentReconnectAttempt = this._reconnectAttempt;
    this._nextReconnectAt = Date.now() + delay;
    this._log.info(`[loxone] scheduling reconnect attempt #${this._reconnectAttempt} in ${(delay / 1000).toFixed(1)}s`);

    this._reconnectTimer = setTimeout(async () => {
      // Clear the slot first so a future _scheduleReconnect (from this catch
      // OR from a late WS 'close' handler) can take it.
      this._reconnectTimer = null;
      try {
        await this._doConnect(true);
        this.emit('reconnected');
      } catch {
        // _doConnect's own catch already logged the failure. If _doConnect
        // failed BEFORE the WebSocket opened (most common: HTTP returns HTML
        // during a Miniserver reboot, _fetchPublicKey throws), no 'close'
        // event will ever fire -- we MUST reschedule here. If the WS did
        // open and then failed, the 'close' handler will also call
        // _scheduleReconnect; the idempotency guard above dedupes safely.
        if (this._shouldReconnect) {
          this._scheduleReconnect();
        }
      }
    }, delay);
  }

  /**
   * Snapshot of connection lifecycle for the API. The dashboard surfaces this
   * so users can see "Miniserver bounced 3 minutes ago, reconnected after 12s"
   * without trawling journalctl.
   */
  getConnectionStats() {
    return {
      connected: this._connected,
      authenticated: this._authenticated,
      connectedSince: this._connectedSince,
      lastConnectedAt: this._lastConnectedAt,
      lastDisconnectAt: this._lastDisconnectAt,
      lastDisconnectCode: this._lastDisconnectCode,
      lastConnectError: this._lastConnectError,
      totalConnects: this._totalConnects,
      totalReconnects: this._totalReconnects,
      totalDisconnects: this._totalDisconnects,
      currentReconnectAttempt: this._currentReconnectAttempt,
      nextReconnectAt: this._nextReconnectAt,
      host: this._host,
      port: this._port,
    };
  }

  /**
   * Calculate backoff delay with jitter.
   * @param {number} attempt
   * @returns {number} delay in ms
   */
  _calcBackoff(attempt) {
    const base = Math.min(1000 * Math.pow(2, attempt), MAX_BACKOFF);
    const jitter = Math.floor(Math.random() * 1000);
    return base + jitter;
  }
}
