/**
 * LoxAPP3.json structure parser and UUID-to-topic mapper.
 *
 * Fetches the Loxone Miniserver structure file and builds a mapping
 * from UUIDs to human-readable MQTT topic paths based on room and
 * control names.
 */
export class LoxoneStructure {
  /**
   * @param {string} topicPrefix - MQTT topic prefix (default: 'loxone')
   */
  constructor(topicPrefix = 'loxone') {
    this.prefix = topicPrefix;
    /** @type {Map<string, string>} UUID -> topic */
    this._uuidToTopic = new Map();
    /** @type {Map<string, string>} topic -> UUID */
    this._topicToUuid = new Map();
    /** @type {Map<string, object>} UUID -> metadata */
    this._meta = new Map();
    /** @type {Array<object>} control-level entries */
    this._controls = [];
    /** @type {Map<string, object>} UUID -> full control tree with subControls and states */
    this._controlTree = new Map();
  }

  /**
   * Fetch only the structure version (`lastModified` of LoxAPP3.json) via
   * `jdev/sps/LoxAPPversion3`. A few bytes instead of the full structure, so
   * the periodic change check stays cheap for the Miniserver.
   * @param {string} host
   * @param {number} port
   * @param {string} user
   * @param {string} pass
   * @returns {Promise<string>} e.g. "2026-10-24 16:34:03"
   */
  async fetchVersion(host, port, user, pass) {
    const url = `http://${host}:${port}/jdev/sps/LoxAPPversion3`;
    const auth = Buffer.from(`${user}:${pass}`).toString('base64');
    const res = await fetch(url, {
      headers: { 'Authorization': `Basic ${auth}` },
    });
    if (!res.ok) {
      throw new Error(`Failed to fetch LoxAPPversion3: ${res.status} ${res.statusText}`);
    }
    const data = await res.json();
    const value = data?.LL?.value;
    if (typeof value !== 'string' || !value) {
      throw new Error('LoxAPPversion3: no version in response');
    }
    return value;
  }

  /**
   * Fetch LoxAPP3.json from the Miniserver via HTTP basic auth.
   * @param {string} host
   * @param {number} port
   * @param {string} user
   * @param {string} pass
   * @returns {Promise<object>} parsed JSON
   */
  async fetchStructure(host, port, user, pass) {
    const url = `http://${host}:${port}/data/LoxAPP3.json`;
    const auth = Buffer.from(`${user}:${pass}`).toString('base64');
    const res = await fetch(url, {
      headers: { 'Authorization': `Basic ${auth}` },
    });
    if (!res.ok) {
      // Read the response body defensively — even if this fails we still
      // have res.status, so the generic fallback message stays useful.
      const body = res.status === 401 ? await res.text().catch(() => '') : '';
      if (res.status === 401) {
        // Loxone Miniserver echoes "<description>last edit of user: ...</description>"
        // ONLY when the user account actually exists on the server, regardless
        // of whether the credentials match. So this tag is a reliable
        // "user OK, permissions/credentials are the question" disambiguator:
        //   - present → username+password accepted, but the user lacks the
        //     "Webseite/Apps" flag or "Visualisierung erlaubt" rights.
        //   - absent  → username unknown OR password wrong.
        const displayUser = user || '<empty>';
        if (body.includes('last edit of user')) {
          throw new Error(
            `Loxone user "${displayUser}" exists but is not allowed to use the API. ` +
            `In Loxone Config, open the user → enable "Webseite/Apps" AND grant ` +
            `"Visualisierung erlaubt" for at least one element, then save to ` +
            `Miniserver. (LoxAPP3.json: 401 Unauthorized)`
          );
        }
        throw new Error(
          `Loxone login failed for user "${displayUser}" — check username and ` +
          `password against the Miniserver. (LoxAPP3.json: 401 Unauthorized)`
        );
      }
      throw new Error(`Failed to fetch LoxAPP3.json: ${res.status} ${res.statusText}`);
    }
    return res.json();
  }

  /**
   * Build UUID-to-topic maps from a parsed LoxAPP3.json structure.
   * @param {object} loxApp3Json
   * @param {object} [opts]
   * @param {object} [opts.logger] - emits a one-time sample of the raw
   *   control fields on first build so operators can spot which Loxone
   *   fields are available when something looks off ("Bezeichnung",
   *   description, …).
   */
  buildMap(loxApp3Json, opts = {}) {
    this._uuidToTopic.clear();
    this._topicToUuid.clear();
    this._meta.clear();
    this._controls = [];
    this._controlTree.clear();

    const log = opts.logger;
    if (log?.info) {
      const all = loxApp3Json.controls || {};
      // Pick a sample InfoOnlyAnalog (or fall back to the first control) so the
      // dump is representative of what users actually wire up. Includes the
      // full `details` object so we can spot which field carries the longer
      // "Bezeichnung" the user expects.
      const ent = Object.entries(all);
      const sample = ent.find(([, c]) => c.type === 'InfoOnlyAnalog') || ent[0];
      if (sample) {
        const [uuid, ctrl] = sample;
        log.info(`[loxone-structure] sample control ${uuid} (${ctrl.type}) keys: ${Object.keys(ctrl).join(', ')}`);
        try {
          // One-shot full dump of details so the user can grep for their
          // "Bezeichnung" string and tell us which field name to surface.
          const detailsStr = JSON.stringify(ctrl.details || {}, null, 0);
          log.info(`[loxone-structure] sample details: ${detailsStr.slice(0, 500)}`);
        } catch { /* ignore */ }
      }
    }

    const rooms = loxApp3Json.rooms || {};
    const cats = loxApp3Json.cats || {};
    const controls = loxApp3Json.controls || {};

    // Build room name lookup
    const roomNames = {};
    for (const [uuid, room] of Object.entries(rooms)) {
      roomNames[uuid] = room.name;
    }

    // Build category name lookup
    const catNames = {};
    for (const [uuid, cat] of Object.entries(cats)) {
      catNames[uuid] = cat.name;
    }

    // Track slugs per room for duplicate detection
    const slugCount = new Map(); // "roomSlug/controlSlug" -> [uuid1, uuid2, ...]

    // First pass: collect all controls with their slugs to detect duplicates
    const controlEntries = [];
    for (const [uuid, ctrl] of Object.entries(controls)) {
      const roomName = ctrl.room ? (roomNames[ctrl.room] || '') : '';
      const roomSlug = this.slugify(roomName);
      const controlSlug = this.slugify(ctrl.name);
      const key = `${roomSlug}/${controlSlug}`;

      if (!slugCount.has(key)) {
        slugCount.set(key, []);
      }
      slugCount.get(key).push(uuid);

      controlEntries.push({
        uuid,
        ctrl,
        roomName,
        roomSlug,
        controlSlug,
        categoryName: ctrl.cat ? (catNames[ctrl.cat] || '') : '',
        slugKey: key,
      });
    }

    // Second pass: build mappings with disambiguation
    for (const entry of controlEntries) {
      const { uuid, ctrl, roomName, roomSlug, controlSlug, categoryName, slugKey } = entry;
      const dupes = slugCount.get(slugKey);
      let finalSlug = controlSlug;

      // Disambiguate if there are duplicates in the same room
      if (dupes.length > 1 && dupes.indexOf(uuid) > 0) {
        finalSlug = `${controlSlug}-${uuid.replace(/-/g, '').substring(0, 8)}`;
      }

      const controlTopic = `${this.prefix}/${roomSlug}/${finalSlug}`;

      // Map the control itself
      this._uuidToTopic.set(uuid, controlTopic);
      this._topicToUuid.set(controlTopic, uuid);
      this._meta.set(uuid, {
        topic: controlTopic,
        name: ctrl.name,
        type: ctrl.type,
        room: roomName || 'unknown',
        uuid,
        category: categoryName || '',
      });
      this._controls.push(this._meta.get(uuid));

      // Collect state keys for the tree
      const stateKeys = [];

      // Map state UUIDs
      if (ctrl.states) {
        for (const [stateKey, stateUuid] of Object.entries(ctrl.states)) {
          const stateTopic = `${controlTopic}/${stateKey}`;
          this._uuidToTopic.set(stateUuid, stateTopic);
          this._meta.set(stateUuid, {
            topic: stateTopic,
            name: ctrl.name,
            type: ctrl.type,
            room: roomName || 'unknown',
            uuid: stateUuid,
            category: categoryName || '',
            stateKey,
          });
          stateKeys.push({ key: stateKey, uuid: stateUuid });
        }
      }

      // Collect subControls for the tree
      const subControls = [];

      // Map subControls
      if (ctrl.subControls) {
        for (const [subUuid, subCtrl] of Object.entries(ctrl.subControls)) {
          const subSlug = this.slugify(subCtrl.name);
          const subTopic = `${controlTopic}/${subSlug}`;

          this._uuidToTopic.set(subUuid, subTopic);
          this._topicToUuid.set(subTopic, subUuid);
          this._meta.set(subUuid, {
            topic: subTopic,
            name: subCtrl.name,
            type: subCtrl.type,
            room: roomName || 'unknown',
            uuid: subUuid,
            category: categoryName || '',
          });

          const subStateKeys = [];

          // Map subControl state UUIDs
          if (subCtrl.states) {
            for (const [stateKey, stateUuid] of Object.entries(subCtrl.states)) {
              const stateTopic = `${subTopic}/${stateKey}`;
              this._uuidToTopic.set(stateUuid, stateTopic);
              this._meta.set(stateUuid, {
                topic: stateTopic,
                name: subCtrl.name,
                type: subCtrl.type,
                room: roomName || 'unknown',
                uuid: stateUuid,
                category: categoryName || '',
                stateKey,
              });
              subStateKeys.push({ key: stateKey, uuid: stateUuid });
            }
          }

          subControls.push({
            uuid: subUuid,
            name: subCtrl.name,
            type: subCtrl.type,
            topic: subTopic,
            states: subStateKeys,
          });
        }
      }

      // Store tree entry. We pass through any longer descriptive name
      // Loxone keeps in `details` (the user calls it "Bezeichnung"). Loxone
      // doesn't standardise the field name, so we walk a few candidates.
      // `details.format` is intentionally excluded — for InfoOnlyAnalog and
      // similar controls it holds a printf-style display format like
      // "%.1f°", which is meaningless as a description and was leaking
      // into the UI as a fake "Bezeichnung".
      let description = '';
      const d = ctrl.details || {};
      const looksLikeFormatSpec = (v) =>
        typeof v === 'string' && /%[+\-# 0]?\d*\.?\d*[difsxXeEgGc%]/.test(v);
      const candidates = [d.description, d.text, d.title, d.label, d.name];
      for (const c of candidates) {
        if (typeof c === 'string' && c.trim() && c.trim() !== ctrl.name && !looksLikeFormatSpec(c)) {
          description = c.trim();
          break;
        }
      }
      // Final fallback: any string field in details that is longer than the
      // name and is not a format spec.
      if (!description) {
        for (const [, v] of Object.entries(d)) {
          if (typeof v === 'string' && v.length > (ctrl.name?.length || 0)
              && !looksLikeFormatSpec(v) && v.trim() !== ctrl.name) {
            description = v.trim();
            break;
          }
        }
      }
      this._controlTree.set(uuid, {
        uuid,
        name: ctrl.name,
        type: ctrl.type,
        room: roomName || 'unknown',
        topic: controlTopic,
        category: categoryName || '',
        description,
        states: stateKeys,
        subControls,
      });
    }
  }

  /**
   * Look up MQTT topic for a UUID.
   * @param {string} uuid
   * @returns {string|undefined}
   */
  uuidToTopic(uuid) {
    return this._uuidToTopic.get(uuid);
  }

  /**
   * Reverse lookup: topic -> UUID (control-level only).
   * @param {string} topic
   * @returns {string|undefined}
   */
  topicToUuid(topic) {
    return this._topicToUuid.get(topic);
  }

  /**
   * Get metadata for a UUID.
   * @param {string} uuid
   * @returns {object|undefined}
   */
  getMeta(uuid) {
    return this._meta.get(uuid);
  }

  /**
   * Get all control-level mappings.
   * @returns {Array<object>}
   */
  getAll() {
    return [...this._controls];
  }

  /**
   * Get full control tree with subControls and state keys.
   * @returns {Array<object>}
   */
  getControlTree() {
    return [...this._controlTree.values()];
  }

  /**
   * Slugify a string for use in MQTT topics.
   * Lowercase, replace non-alphanumeric with hyphens, trim hyphens, collapse multiples.
   * Returns "unknown" for empty input.
   * @param {string} str
   * @returns {string}
   */
  slugify(str) {
    if (!str) return 'unknown';
    const slug = str
      .toLowerCase()
      .replace(/ä/g, 'ae')
      .replace(/ö/g, 'oe')
      .replace(/ü/g, 'ue')
      .replace(/ß/g, 'ss')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-{2,}/g, '-');
    return slug || 'unknown';
  }
}
