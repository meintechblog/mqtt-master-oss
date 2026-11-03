/**
 * Shared helpers for the bindings Export / Import feature (per-plugin and
 * global Backup page). All functions are pure JS modulo the two browser-only
 * I/O helpers (`downloadJson`, `pickJsonFile`) so the rest can be unit-tested
 * under vitest+jsdom with no DOM patching.
 *
 * File format — single source of truth for both per-plugin and global
 * snapshots (matches the backend `GET /api/bindings/export` response):
 *
 *   {
 *     "type": "mqtt-master-bindings-export",
 *     "version": 1,
 *     "exportedAt": "<iso>",
 *     "scope": "plugin" | "all",
 *     // when scope === "plugin":
 *     "pluginId": "gateway1",
 *     "pluginType": "loxone",
 *     "displayName": "Gateway1",
 *     "bindings": [ ...per-binding objects unchanged... ],
 *     // when scope === "all":
 *     "plugins": { [pluginId]: { pluginType, displayName, bindings: [...] } }
 *   }
 *
 * Per-binding shape is whatever `PUT /api/plugins/:id/bindings` accepts — we
 * do NOT invent a new schema here; the file round-trips opaque objects.
 */

export const EXPORT_TYPE = 'mqtt-master-bindings-export';
export const EXPORT_VERSION = 1;

/** Build a per-plugin export object. Caller supplies the live state. */
export function buildPluginExport({ pluginId, pluginType, displayName, bindings }) {
  return {
    type: EXPORT_TYPE,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    scope: 'plugin',
    pluginId,
    pluginType: pluginType || null,
    displayName: displayName || pluginId,
    bindings: Array.isArray(bindings) ? bindings : [],
  };
}

/**
 * Build a global "all plugins" export object. `plugins` is a map
 *   { [pluginId]: { pluginType, displayName, bindings } }
 * matching the backend response.
 */
export function buildAllExport({ plugins }) {
  return {
    type: EXPORT_TYPE,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    scope: 'all',
    plugins: plugins && typeof plugins === 'object' ? plugins : {},
  };
}

/**
 * Validate a per-plugin import file. Errors block the import; warnings
 * surface in the UI as a confirmation prompt but allow the user to override.
 *
 * @returns {{ ok: boolean, bindings?: Array, warnings: string[], errors: string[] }}
 */
export function validatePluginImport(payload, targetPluginId) {
  const errors = [];
  const warnings = [];
  if (!payload || typeof payload !== 'object') {
    return { ok: false, warnings, errors: ['File is empty or not JSON object'] };
  }
  if (payload.type !== EXPORT_TYPE) {
    errors.push(`Wrong file type "${payload.type}" — expected "${EXPORT_TYPE}"`);
  }
  if (payload.version !== EXPORT_VERSION) {
    errors.push(`Unsupported version ${payload.version} — expected ${EXPORT_VERSION}`);
  }
  if (payload.scope !== 'plugin') {
    errors.push(`Wrong scope "${payload.scope}" — expected "plugin". Use the Backup page to restore an "all" export.`);
  }
  if (!Array.isArray(payload.bindings)) {
    errors.push('Missing "bindings" array');
  }
  if (errors.length > 0) {
    return { ok: false, warnings, errors };
  }
  if (targetPluginId && payload.pluginId && payload.pluginId !== targetPluginId) {
    warnings.push(`File was exported from plugin "${payload.pluginId}", not "${targetPluginId}"`);
  }
  return { ok: true, bindings: payload.bindings, warnings, errors };
}

/**
 * Validate a global "all" import file. Plugin-id mismatches against the
 * live system are NOT checked here — the Backup page surfaces them as a
 * separate "skipped: plugin_not_found" line based on the backend response.
 */
export function validateAllImport(payload) {
  const errors = [];
  if (!payload || typeof payload !== 'object') {
    return { ok: false, errors: ['File is empty or not JSON object'] };
  }
  if (payload.type !== EXPORT_TYPE) {
    errors.push(`Wrong file type "${payload.type}" — expected "${EXPORT_TYPE}"`);
  }
  if (payload.version !== EXPORT_VERSION) {
    errors.push(`Unsupported version ${payload.version} — expected ${EXPORT_VERSION}`);
  }
  if (payload.scope !== 'all') {
    errors.push(`Wrong scope "${payload.scope}" — expected "all". Use the per-plugin Import button to restore a single-plugin export.`);
  }
  if (!payload.plugins || typeof payload.plugins !== 'object') {
    errors.push('Missing "plugins" map');
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, plugins: payload.plugins, errors };
}

/**
 * Merge incoming bindings into existing. Both arrays remain immutable.
 * Skip an incoming binding when:
 *   - its `id` matches an existing binding's `id`, OR
 *   - its `mqttTopic + jsonField + targetUuid` triple matches an existing
 *     binding's triple (catches the case where the file was created on a
 *     different machine and the new ID is fresh, but the wiring is identical).
 *
 * @returns {{ merged: Array, skipped: Array<{ binding, reason }> }}
 */
export function mergeBindingArrays(existing, incoming) {
  const ex = Array.isArray(existing) ? existing : [];
  const inc = Array.isArray(incoming) ? incoming : [];
  const ids = new Set(ex.map(b => b?.id).filter(Boolean));
  const triples = new Set(ex.map(b =>
    `${b?.mqttTopic ?? ''} ${b?.jsonField ?? ''} ${b?.targetUuid ?? ''}`));
  const merged = ex.slice();
  const skipped = [];
  for (const b of inc) {
    if (!b || typeof b !== 'object') continue;
    if (b.id && ids.has(b.id)) {
      skipped.push({ binding: b, reason: 'duplicate_id' });
      continue;
    }
    const tri = `${b.mqttTopic ?? ''} ${b.jsonField ?? ''} ${b.targetUuid ?? ''}`;
    if (triples.has(tri)) {
      skipped.push({ binding: b, reason: 'duplicate_target' });
      continue;
    }
    merged.push(b);
    if (b.id) ids.add(b.id);
    triples.add(tri);
  }
  return { merged, skipped };
}

/**
 * Copy-import incoming bindings onto existing. Unlike `mergeBindingArrays`,
 * copy mode never skips: EVERY incoming binding is appended as a fresh,
 * independent clone so a user can intentionally duplicate a wiring setup.
 *
 * Each appended clone is a shallow copy with:
 *   - a freshly-minted, batch-unique id (`'b-' + Date.now() + '-' + index`)
 *     so a multi-entry import cannot collide within a single millisecond,
 *   - a label suffixed with ` (copy)` so clones stay distinguishable. A
 *     binding with no label falls back to its original id + ` (copy)`.
 *
 * Neither input array nor any incoming binding object is mutated.
 *
 * @returns {{ merged: Array }}
 */
export function copyBindingArrays(existing, incoming) {
  const ex = Array.isArray(existing) ? existing : [];
  const inc = Array.isArray(incoming) ? incoming : [];
  const merged = ex.slice();
  const stamp = Date.now();
  inc.forEach((b, index) => {
    if (!b || typeof b !== 'object') return;
    const baseLabel = (typeof b.label === 'string' && b.label) || b.id || '';
    merged.push({
      ...b,
      id: 'b-' + stamp + '-' + index,
      label: `${baseLabel} (copy)`,
    });
  });
  return { merged };
}

// ─── Browser I/O helpers (not exercised under jsdom-pure unit tests) ───

/**
 * Trigger a browser download of `obj` (pretty-printed JSON) as `filename`.
 * Uses Blob + URL.createObjectURL + hidden <a> click — no library deps.
 */
export function downloadJson(filename, obj) {
  const text = JSON.stringify(obj, null, 2);
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke so the browser has time to start the download — same trick
  // we used elsewhere; 1s is plenty even on slow disks.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Open the native file picker and resolve with the parsed JSON. Rejects on
 * parse error. Resolves with `null` if the user cancels (file chooser
 * dismissed without a selection — no 'change' event fires, so we use a one-
 * shot focus listener to detect cancel).
 */
export function pickJsonFile() {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.style.display = 'none';
    document.body.appendChild(input);

    let settled = false;
    const cleanup = () => {
      if (input.parentNode) input.parentNode.removeChild(input);
    };

    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) {
        settled = true;
        cleanup();
        resolve(null);
        return;
      }
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        settled = true;
        cleanup();
        resolve({ filename: file.name, text, data });
      } catch (err) {
        settled = true;
        cleanup();
        reject(new Error(`Could not parse file as JSON: ${err.message}`));
      }
    });

    // Cancel detection — when the dialog is dismissed without selecting a
    // file, browsers refocus the document but don't fire 'change'. Wait one
    // tick after focus before assuming cancel so we don't race the 'change'
    // event on slow browsers.
    window.addEventListener('focus', () => {
      setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanup();
          resolve(null);
        }
      }, 300);
    }, { once: true });

    input.click();
  });
}
