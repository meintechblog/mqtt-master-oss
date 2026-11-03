import { EventEmitter } from 'node:events';

/**
 * In-memory cache of every MQTT topic the server has ever seen.
 *
 * Subscribes to `#` once at startup, then stores `{ payload, ts, count }`
 * per topic. This decouples the dashboard's Topic Browser from the publish
 * cadence of slow devices (e.g. Tasmota's `tele/.../STATE` defaults to one
 * publish per 5 minutes) — a topic seen once stays visible until the
 * service restarts or the cache is cleared.
 *
 * `$SYS/#` is excluded by default to avoid drowning the cache with broker
 * stats; if you want them, pass `includeSys: true` in opts.
 */
export class TopicCacheService extends EventEmitter {
  constructor(mqttService, opts = {}) {
    super();
    this._mqtt = mqttService;
    this._max = opts.maxEntries ?? 5000;
    this._includeSys = opts.includeSys ?? false;
    /** @type {Map<string, { payload: string, ts: number, count: number, retained: boolean }>} */
    this._cache = new Map();

    mqttService.subscribe('#');
    if (this._includeSys) mqttService.subscribe('$SYS/#');

    mqttService.on('message', (msg) => this._handle(msg));
  }

  _handle(msg) {
    if (!this._includeSys && msg.topic.startsWith('$SYS/')) return;
    const prev = this._cache.get(msg.topic);
    this._cache.set(msg.topic, {
      payload: msg.payload,
      ts: msg.timestamp,
      count: (prev?.count ?? 0) + 1,
      // Best-effort, sticky-true: the MQTT retain flag is only reliably set on
      // the initial retained dump at subscribe time, so once a topic has ever
      // been delivered with retain=true we keep `retained: true` even though
      // subsequent live publishes arrive with retain=false. This answers the
      // useful question "does the broker hold a retained value here?" rather
      // than "was the most recent delivery a retained one".
      retained: (prev?.retained ?? false) || !!msg.retain,
    });
    if (this._cache.size > this._max) this._evictOldest();
  }

  /**
   * LRU-by-timestamp eviction: drop the oldest 20% in one pass so we don't
   * thrash on every message once we hit the cap.
   */
  _evictOldest() {
    const target = Math.floor(this._max * 0.8);
    const entries = [...this._cache.entries()].sort((a, b) => b[1].ts - a[1].ts);
    this._cache = new Map(entries.slice(0, target));
  }

  /** Snapshot as a plain array, newest first. */
  list() {
    const out = [];
    for (const [topic, entry] of this._cache) {
      out.push({
        topic,
        payload: entry.payload,
        ts: entry.ts,
        count: entry.count,
        retained: entry.retained ?? false,
      });
    }
    out.sort((a, b) => b.ts - a.ts);
    return out;
  }

  size() {
    return this._cache.size;
  }

  clear() {
    this._cache.clear();
  }
}
