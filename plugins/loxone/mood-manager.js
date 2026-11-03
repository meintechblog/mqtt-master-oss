/**
 * Manages Loxone mood caching, fetching, and resolution.
 * Extracted from LoxonePlugin to isolate mood-related state and logic.
 */

export class MoodManager {
  constructor() {
    /** @type {Map<string, Map<string, number>>} controlUuid -> Map<moodName, moodId> */
    this._moodsByControl = new Map();
  }

  /** Clear all cached moods. */
  clear() {
    this._moodsByControl.clear();
  }

  /**
   * Get moods for a control as {id, name} array (deduplicated).
   * @param {string} controlUuid
   * @returns {Array<{ id: number, name: string }>}
   */
  getMoods(controlUuid) {
    const moodMap = this._moodsByControl.get(controlUuid);
    if (!moodMap) return [];

    const moods = [];
    const seen = new Set();
    for (const [name, id] of moodMap) {
      // Skip lowercase duplicates — keep original casing
      if (name === name.toLowerCase() && moodMap.has(name.charAt(0).toUpperCase() + name.slice(1))) continue;
      if (!seen.has(id)) {
        seen.add(id);
        moods.push({ id, name });
      }
    }
    return moods;
  }

  /**
   * Cache moods from a parsed mood array [{name, id}, ...].
   * @param {string} controlUuid
   * @param {Array<{ name: string, id: number }>} moods
   */
  cacheMoods(controlUuid, moods) {
    const nameToId = new Map();
    for (const mood of moods) {
      if (mood.name && mood.id != null) {
        nameToId.set(mood.name, mood.id);
        nameToId.set(mood.name.toLowerCase(), mood.id);
      }
    }
    this._moodsByControl.set(controlUuid, nameToId);
  }

  /**
   * Parse a moodList JSON text and cache it.
   * @param {string} controlUuid
   * @param {string} text - JSON array string
   * @returns {boolean} true if parsing succeeded
   */
  parseMoodListText(controlUuid, text) {
    try {
      const moods = JSON.parse(text);
      if (!Array.isArray(moods)) return false;
      this.cacheMoods(controlUuid, moods);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Resolve a mood name to its ID for a given control UUID.
   * Checks the control itself, parent controls, then all controls as fallback.
   * @param {string} uuid
   * @param {string} moodName
   * @returns {number|null}
   */
  resolveMoodName(uuid, moodName) {
    // Check direct control
    const moods = this._moodsByControl.get(uuid);
    if (moods) {
      const exact = moods.get(moodName);
      if (exact != null) return exact;
      const lower = moods.get(moodName.toLowerCase());
      if (lower != null) return lower;
    }

    // Check parent control (sub-control UUID might be like "parentUuid/AI1")
    if (uuid.includes('/')) {
      const parentUuid = uuid.split('/')[0];
      const parentMoods = this._moodsByControl.get(parentUuid);
      if (parentMoods) {
        const exact = parentMoods.get(moodName);
        if (exact != null) return exact;
        const lower = parentMoods.get(moodName.toLowerCase());
        if (lower != null) return lower;
      }
    }

    // Check all controls (fallback)
    for (const [, controlMoods] of this._moodsByControl) {
      const exact = controlMoods.get(moodName);
      if (exact != null) return exact;
      const lower = controlMoods.get(moodName.toLowerCase());
      if (lower != null) return lower;
    }

    return null;
  }

  /**
   * Fetch mood lists for all LightControllerV2 controls via WebSocket.
   * @param {object} opts
   * @param {object} opts.structure - LoxoneStructure instance
   * @param {object} opts.ws - LoxoneWs instance
   * @param {Map} opts.stateCache - state cache for fallback
   * @param {object} opts.logger
   */
  async requestMoodLists({ structure, ws, stateCache, logger }) {
    const tree = structure.getControlTree();

    for (const ctrl of tree) {
      if (ctrl.type !== 'LightControllerV2') continue;

      const moodListState = ctrl.states.find(s => s.key === 'moodList');
      if (!moodListState) continue;

      try {
        const moods = await this._fetchMoodList(ws, ctrl.uuid, moodListState.uuid, stateCache);
        if (moods && moods.length > 0) {
          this.cacheMoods(ctrl.uuid, moods);
          logger.info(`Cached ${moods.length} moods for ${ctrl.name}: ${moods.map(m => `${m.name}(${m.id})`).join(', ')}`);
        } else {
          logger.info(`No moods found for ${ctrl.name}`);
        }
      } catch (err) {
        logger.warn(`Failed to fetch moods for ${ctrl.name}: ${err.message}`);
      }
    }
  }

  /**
   * Handle text state events (0x00 header + text frame) that may carry mood data.
   * @param {string} text
   * @param {object} structure - LoxoneStructure instance
   * @param {object} logger
   */
  handleTextStateEvent(text, structure, logger) {
    try {
      const data = JSON.parse(text);
      if (Array.isArray(data) && data.length > 0 && data[0].id != null && data[0].name) {
        const controls = structure.getAll();
        for (const ctrl of controls) {
          if (ctrl.type === 'LightControllerV2') {
            this.cacheMoods(ctrl.uuid, data);
            logger.info(`Cached ${data.length} moods for ${ctrl.name}: ${data.map(m => `${m.name}(${m.id})`).join(', ')}`);
            break; // For now, assign to first LightControllerV2 found
          }
        }
      }
    } catch {
      // Not JSON or not a mood list - ignore
    }
  }

  /**
   * Fetch mood list by sending getmoodlist command and listening for response.
   * @private
   */
  async _fetchMoodList(ws, controlUuid, moodListStateUuid, stateCache) {
    return new Promise((resolve) => {
      let resolved = false;

      const settle = (value) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve(value);
      };

      const timeout = setTimeout(() => {
        const cached = stateCache.get(moodListStateUuid);
        if (cached && cached.text) {
          try {
            settle(JSON.parse(cached.text));
            return;
          } catch { /* not JSON */ }
        }
        settle([]);
      }, 5000);

      const textHandler = (text) => {
        try {
          if (text.includes('"LL"')) return;
          const data = JSON.parse(text.trim());
          if (Array.isArray(data) && data.length > 0 && data[0].id != null && data[0].name) {
            settle(data);
          }
        } catch { /* not JSON */ }
      };

      const cleanup = () => {
        clearTimeout(timeout);
        ws.removeListener('textMessage', textHandler);
        ws.removeListener('textStateEvent', textHandler);
      };

      ws.on('textMessage', textHandler);
      ws.on('textStateEvent', textHandler);

      ws.sendCommand(`jdev/sps/io/${controlUuid}/getmoodlist`);
    });
  }
}
