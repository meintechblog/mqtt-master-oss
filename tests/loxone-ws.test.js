import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LoxoneWs } from '../plugins/loxone/loxone-ws.js';

describe('LoxoneWs', () => {
  let ws;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    ws = new LoxoneWs({ host: '192.0.2.10', port: 80, user: 'admin', pass: 'secret' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('UUID binary-to-string conversion', () => {
    // Loxone UUID format is 8-4-4-16 (groups 4 + 5 are NOT separated by a dash) --
    // see plugins/loxone/loxone-ws.js::_uuidFromBuffer. This is intentional live
    // behavior, not a bug; the test assertions below reflect the actual Loxone
    // miniserver wire format.
    it('converts 16-byte buffer to formatted UUID with correct Loxone endianness', () => {
      // Loxone UUID format: first 3 groups little-endian, last 2 big-endian
      // Target UUID: 0a1b2c3d-0123-4567-ffff112233445566 (8-4-4-16 layout)
      // Group 1 (4 bytes LE): 0a1b2c3d -> stored as 3d 2c 1b 0a
      // Group 2 (2 bytes LE): 0123 -> stored as 23 01
      // Group 3 (2 bytes LE): 4567 -> stored as 67 45
      // Group 4 (2 bytes BE): ffff -> stored as ff ff
      // Group 5 (6 bytes BE): 112233445566 -> stored as 11 22 33 44 55 66
      const buf = Buffer.from([
        0x3d, 0x2c, 0x1b, 0x0a, // group 1 LE
        0x23, 0x01,             // group 2 LE
        0x67, 0x45,             // group 3 LE
        0xff, 0xff,             // group 4 BE
        0x11, 0x22, 0x33, 0x44, 0x55, 0x66, // group 5 BE
      ]);

      const uuid = ws._uuidFromBuffer(buf, 0);
      expect(uuid).toBe('0a1b2c3d-0123-4567-ffff112233445566');
    });

    it('reads UUID at non-zero offset', () => {
      const prefix = Buffer.alloc(4, 0x00);
      const uuidBytes = Buffer.from([
        0x3d, 0x2c, 0x1b, 0x0a,
        0x23, 0x01,
        0x67, 0x45,
        0xff, 0xff,
        0x11, 0x22, 0x33, 0x44, 0x55, 0x66,
      ]);
      const buf = Buffer.concat([prefix, uuidBytes]);

      const uuid = ws._uuidFromBuffer(buf, 4);
      expect(uuid).toBe('0a1b2c3d-0123-4567-ffff112233445566');
    });
  });

  describe('header parsing', () => {
    it('parses 8-byte header extracting identifier and payload length', () => {
      // Header: byte 0 = 0x03 (fixed), byte 1 = identifier, bytes 2-3 = flags/reserved
      // bytes 4-7 = payload length (uint32 LE)
      const header = Buffer.alloc(8);
      header[0] = 0x03; // fixed type indicator
      header[1] = 0x02; // value event identifier
      header.writeUInt32LE(48, 4); // payload length = 48 bytes (2 value events)

      const parsed = ws._processHeader(header);
      expect(parsed).toEqual({ identifier: 0x02, length: 48 });
    });

    it('parses keepalive response header (identifier 0x06)', () => {
      const header = Buffer.alloc(8);
      header[0] = 0x03;
      header[1] = 0x06;
      header.writeUInt32LE(0, 4);

      const parsed = ws._processHeader(header);
      expect(parsed).toEqual({ identifier: 0x06, length: 0 });
    });

    it('parses text event header (identifier 0x03)', () => {
      const header = Buffer.alloc(8);
      header[0] = 0x03;
      header[1] = 0x03;
      header.writeUInt32LE(100, 4);

      const parsed = ws._processHeader(header);
      expect(parsed).toEqual({ identifier: 0x03, length: 100 });
    });
  });

  describe('value event parsing', () => {
    it('parses 24-byte value event chunks into uuid + value pairs', () => {
      const events = [];
      ws.on('valueEvent', (ev) => events.push(ev));

      // Build a buffer with 2 value events (24 bytes each = 48 bytes)
      const buf = Buffer.alloc(48);

      // Event 1: UUID 0a1b2c3d-0123-4567-ffff-112233445566, value = 23.5
      // UUID bytes (LE for first 3 groups, BE for last 2)
      buf[0] = 0x3d; buf[1] = 0x2c; buf[2] = 0x1b; buf[3] = 0x0a; // group 1 LE
      buf[4] = 0x23; buf[5] = 0x01; // group 2 LE
      buf[6] = 0x67; buf[7] = 0x45; // group 3 LE
      buf[8] = 0xff; buf[9] = 0xff; // group 4 BE
      buf[10] = 0x11; buf[11] = 0x22; buf[12] = 0x33; buf[13] = 0x44; buf[14] = 0x55; buf[15] = 0x66; // group 5 BE
      // Value: 23.5 as float64 LE
      const dv = new DataView(buf.buffer, buf.byteOffset);
      dv.setFloat64(16, 23.5, true); // littleEndian

      // Event 2: UUID 12345678-abcd-ef01-2345-678901234567, value = 1.0
      buf[24] = 0x78; buf[25] = 0x56; buf[26] = 0x34; buf[27] = 0x12; // group 1 LE
      buf[28] = 0xcd; buf[29] = 0xab; // group 2 LE
      buf[30] = 0x01; buf[31] = 0xef; // group 3 LE
      buf[32] = 0x23; buf[33] = 0x45; // group 4 BE
      buf[34] = 0x67; buf[35] = 0x89; buf[36] = 0x01; buf[37] = 0x23; buf[38] = 0x45; buf[39] = 0x67; // group 5 BE
      dv.setFloat64(40, 1.0, true);

      ws._parseValueEvents(buf);

      expect(events).toHaveLength(2);
      // Loxone 8-4-4-16 wire format (see _uuidFromBuffer): groups 4+5 concatenated.
      expect(events[0]).toEqual({ uuid: '0a1b2c3d-0123-4567-ffff112233445566', value: 23.5 });
      expect(events[1]).toEqual({ uuid: '12345678-abcd-ef01-2345678901234567', value: 1.0 });
    });

    it('handles single value event (24 bytes)', () => {
      const events = [];
      ws.on('valueEvent', (ev) => events.push(ev));

      const buf = Buffer.alloc(24);
      buf[0] = 0x01; buf[1] = 0x00; buf[2] = 0x00; buf[3] = 0x00; // group 1 LE -> 00000001
      buf[4] = 0x02; buf[5] = 0x00; // group 2 LE -> 0002
      buf[6] = 0x03; buf[7] = 0x00; // group 3 LE -> 0003
      buf[8] = 0x00; buf[9] = 0x04; // group 4 BE -> 0004
      buf[10] = 0x00; buf[11] = 0x00; buf[12] = 0x00; buf[13] = 0x00; buf[14] = 0x00; buf[15] = 0x05; // group 5 BE
      const dv = new DataView(buf.buffer, buf.byteOffset);
      dv.setFloat64(16, 42.0, true);

      ws._parseValueEvents(buf);

      expect(events).toHaveLength(1);
      // Loxone 8-4-4-16 wire format (see _uuidFromBuffer): groups 4+5 concatenated.
      expect(events[0].uuid).toBe('00000001-0002-0003-0004000000000005');
      expect(events[0].value).toBe(42.0);
    });
  });

  describe('text event parsing', () => {
    // Loxone "Communicating with the Miniserver", Binary-Structure of a Text-Event (EvDataText):
    // PUUID uuid (16) + PUUID uuidIcon (16) + textLength (LE uint32) + text, padded to a multiple of 4.
    const uuidBytes = [0x3d, 0x2c, 0x1b, 0x0a, 0x23, 0x01, 0x67, 0x45, 0xff, 0xff, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66];
    const textEvent = (uuid, icon, text) => {
      const t = Buffer.from(text, 'utf-8');
      const pad = (4 - (t.length % 4)) % 4;
      const b = Buffer.alloc(36 + t.length + pad);
      Buffer.from(uuid).copy(b, 0);
      Buffer.from(icon).copy(b, 16);
      b.writeUInt32LE(t.length, 32);
      t.copy(b, 36);
      return b;
    };

    it('parses EvDataText: 16-byte UUID + 16-byte icon UUID + 4-byte textLen + UTF-8 text', () => {
      const events = [];
      ws.on('textEvent', (ev) => events.push(ev));

      // Icon UUID intentionally non-zero: its bytes must never be read as the text length.
      ws._parseTextEvents(textEvent(uuidBytes, Array(16).fill(0x07), 'Hello Loxone'));

      expect(events).toEqual([{
        // Loxone 8-4-4-16 wire format (see _uuidFromBuffer): groups 4+5 concatenated.
        uuid: '0a1b2c3d-0123-4567-ffff112233445566',
        text: 'Hello Loxone',
      }]);
    });

    it('handles every alignment class, empty text and multi-byte UTF-8 (length counts bytes)', () => {
      const events = [];
      ws.on('textEvent', (ev) => events.push(ev));
      const texte = ['', 'a', 'ab', 'abc', 'abcd', 'Bär 21,5 °C', '😀'];

      ws._parseTextEvents(Buffer.concat(texte.map((t) => textEvent(uuidBytes, Array(16).fill(0xee), t))));

      expect(events.map((e) => e.text)).toEqual(texte);
    });

    it('stops without throwing on a truncated header or text, keeping the complete events before it', () => {
      const events = [];
      ws.on('textEvent', (ev) => events.push(ev));
      const ganz = textEvent(uuidBytes, Array(16).fill(0), 'ok');
      const kopfKurz = textEvent(uuidBytes, Array(16).fill(0), 'x').subarray(0, 30);
      const textKurz = textEvent(uuidBytes, Array(16).fill(0), 'abcdefgh').subarray(0, 40);

      expect(() => ws._parseTextEvents(Buffer.concat([ganz, kopfKurz]))).not.toThrow();
      expect(() => ws._parseTextEvents(Buffer.concat([ganz, textKurz]))).not.toThrow();
      expect(events.map((e) => e.text)).toEqual(['ok', 'ok']);
    });

    it('cuts the text at the first null byte (existing behaviour, Loxone texts may be null-terminated)', () => {
      const events = [];
      ws.on('textEvent', (ev) => events.push(ev));

      ws._parseTextEvents(textEvent(uuidBytes, Array(16).fill(0), 'A\0B'));

      expect(events[0].text).toBe('A');
    });

    it('parses several text events in one table, skipping the padding after each text', () => {
      const events = [];
      ws.on('textEvent', (ev) => events.push(ev));
      const zweite = [...uuidBytes];
      zweite[0] = 0x3e;
      const moodList = '[{"name":"Abend","id":2,"static":false},{"name":"Aus","id":778,"static":true}]';

      ws._parseTextEvents(Buffer.concat([
        textEvent(uuidBytes, Array(16).fill(0), '[778]'), // 5 bytes → 3 padding bytes
        textEvent(zweite, Array(16).fill(0x1f), moodList),
      ]));

      expect(events).toEqual([
        { uuid: '0a1b2c3d-0123-4567-ffff112233445566', text: '[778]' },
        { uuid: '0a1b2c3e-0123-4567-ffff112233445566', text: moodList },
      ]);
    });
  });

  describe('state machine', () => {
    it('transitions from HEADER to PAYLOAD on binary message', () => {
      const events = [];
      ws.on('valueEvent', (ev) => events.push(ev));

      // First message: 8-byte header for value event, payload length = 24
      const header = Buffer.alloc(8);
      header[0] = 0x03;
      header[1] = 0x02; // value event
      header.writeUInt32LE(24, 4); // 24 bytes payload

      // Second message: 24-byte value event payload
      const payload = Buffer.alloc(24);
      payload[0] = 0x01; payload[1] = 0x00; payload[2] = 0x00; payload[3] = 0x00;
      payload[4] = 0x02; payload[5] = 0x00;
      payload[6] = 0x03; payload[7] = 0x00;
      payload[8] = 0x00; payload[9] = 0x04;
      payload[10] = 0x00; payload[11] = 0x00; payload[12] = 0x00; payload[13] = 0x00; payload[14] = 0x00; payload[15] = 0x05;
      const dv = new DataView(payload.buffer, payload.byteOffset);
      dv.setFloat64(16, 99.9, true);

      // Process header first
      ws._onMessage(header, true);
      expect(ws._state).toBe('PAYLOAD');

      // Process payload
      ws._onMessage(payload, true);
      expect(ws._state).toBe('HEADER');
      expect(events).toHaveLength(1);
      expect(events[0].value).toBe(99.9);
    });

    it('emits textMessage for non-binary messages', () => {
      const messages = [];
      ws.on('textMessage', (msg) => messages.push(msg));

      const textData = Buffer.from(JSON.stringify({ LL: { control: 'test', code: 200 } }));
      ws._onMessage(textData, false);

      expect(messages).toHaveLength(1);
    });
  });

  describe('keepalive response handling', () => {
    it('handles keepalive header (identifier 0x06) without expecting payload when length=0', () => {
      const header = Buffer.alloc(8);
      header[0] = 0x03;
      header[1] = 0x06; // keepalive response
      header.writeUInt32LE(0, 4); // no payload

      ws._onMessage(header, true);
      // Should stay in HEADER state (no payload expected)
      expect(ws._state).toBe('HEADER');
    });
  });

  describe('zombie connection detection', () => {
    it('keepalive watchdog hard-terminates the socket so reconnect always runs', () => {
      const terminate = vi.fn();
      const close = vi.fn();
      ws._ws = { terminate, close, readyState: 1 };

      ws._startKeepaliveWatchdog();
      vi.advanceTimersByTime(15_000);

      expect(terminate).toHaveBeenCalledTimes(1);
      expect(close).not.toHaveBeenCalled();
    });

    it('sendCommand falls back to terminate when the underlying socket throws', () => {
      const terminate = vi.fn();
      ws._ws = {
        readyState: 1,
        send: () => { throw new Error('write EPIPE'); },
        terminate,
        close: vi.fn(),
      };

      ws.sendCommand('keepalive');

      expect(terminate).toHaveBeenCalledTimes(1);
    });
  });

  describe('reconnect backoff calculation', () => {
    it('calculates exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s, 30s', () => {
      const expected = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
      for (let i = 0; i < expected.length; i++) {
        const delay = ws._calcBackoff(i);
        // Allow jitter of up to 1000ms
        expect(delay).toBeGreaterThanOrEqual(expected[i]);
        expect(delay).toBeLessThanOrEqual(expected[i] + 1000);
      }
    });
  });

  describe('connection URL', () => {
    it('builds correct WebSocket URL without credentials', () => {
      expect(ws._buildUrl()).toBe('ws://192.0.2.10:80/ws/rfc6455');
    });

    it('uses custom port', () => {
      const ws2 = new LoxoneWs({ host: '198.51.100.1', port: 8080, user: 'u', pass: 'p' });
      expect(ws2._buildUrl()).toBe('ws://198.51.100.1:8080/ws/rfc6455');
    });
  });

  describe('constructor defaults', () => {
    it('initializes in HEADER state', () => {
      expect(ws._state).toBe('HEADER');
    });

    it('starts with reconnect attempt 0', () => {
      expect(ws._reconnectAttempt).toBe(0);
    });

    it('is not connected initially', () => {
      expect(ws._connected).toBe(false);
    });
  });

  describe('reconnect retry chain', () => {
    // Worst-case backoff window for one cycle:
    //   _calcBackoff(attempt) = min(1000 * 2^attempt, 30000) + jitter[0..1000)
    // At attempt >= 5, base saturates at 30000ms, so MAX_BACKOFF + 1500 covers
    // any single cycle including jitter.
    const ONE_CYCLE_MS = 30_000 + 1500;

    it('self-reschedules when _doConnect rejects (pre-WS failure path)', async () => {
      // Reproduces the live bug: _fetchPublicKey throws during a Miniserver
      // reboot because /jdev/sys/getPublicKey returns HTML, _doConnect rejects
      // BEFORE any WebSocket exists, no 'close' event will ever fire, so the
      // chain must self-reschedule from inside _scheduleReconnect's catch.
      const reconnectFailErr = new Error(
        "Failed to parse public key response: Unexpected token '<'",
      );
      const calls = [];
      ws._doConnect = vi.fn(async () => {
        calls.push(Date.now());
        if (calls.length <= 3) throw reconnectFailErr;
        // 4th call succeeds (no-op stub: real _doConnect would reset state,
        // but we only care that it was called and that 'reconnected' fired).
      });

      const reconnectedEvents = [];
      ws.on('reconnected', () => reconnectedEvents.push(Date.now()));

      ws._shouldReconnect = true;

      // Drive each cycle individually by advancing only as far as the next
      // scheduled fire time. Backoff grows (1s, 2s, 4s, 8s + jitter), so a
      // single large advance would fire several cycles back-to-back and we
      // could not assert the chain was re-armed between failures.
      //
      // Note: _currentReconnectAttempt increments at SCHEDULE time, not at
      // FIRE time. So after the initial schedule we are at 1; after a failed
      // fire that re-schedules, we are at 2; etc. The invariant that matters
      // is: counter increases by exactly 1 per failed cycle AND _reconnectTimer
      // is non-null after a failure (chain is re-armed).
      const runOneFailedCycle = async () => {
        const beforeAttempt = ws._currentReconnectAttempt;
        const beforeCallCount = ws._doConnect.mock.calls.length;
        expect(ws._reconnectTimer).not.toBeNull();
        const fireInMs = Math.max(1, ws._nextReconnectAt - Date.now());
        await vi.advanceTimersByTimeAsync(fireInMs + 50);
        // Flush any microtasks the catch chain queued.
        await Promise.resolve();
        await Promise.resolve();
        // _doConnect was called once more, and the catch re-scheduled.
        expect(ws._doConnect.mock.calls.length).toBe(beforeCallCount + 1);
        expect(ws._currentReconnectAttempt).toBe(beforeAttempt + 1);
        expect(ws._reconnectTimer).not.toBeNull();
      };

      ws._scheduleReconnect();
      // Initial schedule: counter is 1, timer armed.
      expect(ws._currentReconnectAttempt).toBe(1);
      expect(ws._reconnectTimer).not.toBeNull();

      // Cycles 1-3: each fails and re-arms the chain.
      await runOneFailedCycle(); // attempt 1 -> 2
      await runOneFailedCycle(); // attempt 2 -> 3
      await runOneFailedCycle(); // attempt 3 -> 4

      // Cycle 4 (success): _doConnect resolves, 'reconnected' fires, no
      // further reschedule, timer slot stays null.
      const fireInMs = Math.max(1, ws._nextReconnectAt - Date.now());
      await vi.advanceTimersByTimeAsync(fireInMs + 50);
      await Promise.resolve();
      await Promise.resolve();

      expect(ws._doConnect).toHaveBeenCalledTimes(4);
      expect(reconnectedEvents).toHaveLength(1);
      expect(ws._reconnectTimer).toBeNull();
    });

    it('is idempotent: a second _scheduleReconnect call while a timer is pending is a no-op', () => {
      // Two callers race here in the live system: the catch in
      // _scheduleReconnect's setTimeout AND the WS 'close' handler can both
      // fire near-simultaneously when a post-open failure happens. They must
      // not stack two timers.
      ws._doConnect = vi.fn(async () => { /* never resolves in this test */ });
      ws._shouldReconnect = true;

      ws._scheduleReconnect();
      const firstTimer = ws._reconnectTimer;
      const firstAttempt = ws._currentReconnectAttempt;
      expect(firstTimer).not.toBeNull();
      expect(firstAttempt).toBe(1);

      ws._scheduleReconnect();

      expect(ws._reconnectTimer).toBe(firstTimer);
      expect(ws._currentReconnectAttempt).toBe(firstAttempt);
    });

    it('stops rescheduling when _shouldReconnect is false', async () => {
      ws._doConnect = vi.fn(async () => { throw new Error('always fails'); });
      ws._shouldReconnect = true;
      ws._scheduleReconnect();

      // Simulate disconnect() being called immediately after the timer was armed:
      // the timer is allowed to fire ONCE, but its catch must NOT reschedule.
      ws._shouldReconnect = false;

      await vi.advanceTimersByTimeAsync(ONE_CYCLE_MS);

      expect(ws._doConnect).toHaveBeenCalledTimes(1);
      expect(ws._reconnectTimer).toBeNull();
    });
  });
});
