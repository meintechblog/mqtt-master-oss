import { html } from 'htm/preact';
import { useEffect, useState, useCallback, useRef } from 'preact/hooks';
import { fetchLoxoneControlsDetailed } from '../lib/api-client.js';
import { navGuard } from '../app.js';

/** All possible mood IDs: -1, 0-31, 777, 778 */
const ALL_IDS = [-1, ...Array.from({ length: 31 }, (_, i) => i + 1), 777, 778];

/** IDs where the name is fixed and not editable */
const LOCKED_NAMES = { '-1': 'Manuell', '777': 'Viel Licht', '778': 'Aus' };

/** Ensure a section has all IDs, filling missing ones with '' */
function fillSection(section) {
  const filled = {};
  for (const id of ALL_IDS) {
    const key = String(id);
    if (LOCKED_NAMES[key]) {
      filled[key] = LOCKED_NAMES[key];
    } else {
      filled[key] = section[key] || '';
    }
  }
  return filled;
}

export function MoodMappings({ pluginId = 'loxone' } = {}) {
  const [savedMappings, setSavedMappings] = useState(null);
  const [draft, setDraft] = useState(null);
  const [controls, setControls] = useState([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);
  const [editControl, setEditControl] = useState(null);

  const hasChanges = draft && savedMappings && JSON.stringify(draft) !== JSON.stringify(savedMappings);
  const hasChangesRef = useRef(false);
  hasChangesRef.current = hasChanges;

  // Register global navigation guard while this page is mounted
  useEffect(() => {
    navGuard.check = () => {
      if (!hasChangesRef.current) return true;
      return confirm('Du hast ungespeicherte Änderungen. Verwerfen?');
    };
    const beforeUnload = (e) => {
      if (hasChangesRef.current) { e.preventDefault(); e.returnValue = ''; }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      navGuard.check = null;
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, []);

  /** Switch tab with unsaved-changes guard */
  const switchTab = useCallback((target) => {
    if (hasChangesRef.current) {
      if (!confirm('Du hast ungespeicherte Änderungen. Verwerfen?')) return;
      setDraft(JSON.parse(JSON.stringify(savedMappings)));
    }
    setEditControl(target);
  }, [savedMappings]);

  useEffect(() => {
    async function load() {
      try {
        const [moodRes, ctrlData] = await Promise.all([
          fetch(`/api/plugins/${pluginId}/moods`).then(r => r.json()),
          fetchLoxoneControlsDetailed(pluginId).catch(() => []),
        ]);
        // Fill all IDs on load
        const filled = { ...moodRes, _defaults: fillSection(moodRes._defaults || {}) };
        for (const key of Object.keys(filled)) {
          if (key !== '_defaults') filled[key] = fillSection(filled[key]);
        }
        setSavedMappings(filled);
        setDraft(JSON.parse(JSON.stringify(filled)));
        setControls(ctrlData.filter(c => c.type === 'LightControllerV2'));
      } catch (err) {
        showToast('error', err.message);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [pluginId]);

  const showToast = useCallback((type, text) => {
    setToast({ type, text });
    setTimeout(() => setToast(null), 3000);
  }, []);

  const handleUpdateName = useCallback((key, moodId, name) => {
    setDraft(prev => {
      const next = JSON.parse(JSON.stringify(prev));
      const section = key === '_defaults' ? next._defaults : next[key];
      if (section) section[String(moodId)] = name;
      return next;
    });
  }, []);

  const handleCreateOverride = useCallback((uuid) => {
    setDraft(prev => {
      const next = JSON.parse(JSON.stringify(prev));
      next[uuid] = fillSection(next._defaults);
      return next;
    });
    setEditControl(uuid);
  }, []);

  const handleDeleteOverride = useCallback((uuid) => {
    if (!confirm('Override entfernen? Es gelten dann wieder die Defaults.')) return;
    setDraft(prev => {
      const next = JSON.parse(JSON.stringify(prev));
      delete next[uuid];
      return next;
    });
    setEditControl(null);
  }, []);

  const handleSave = useCallback(async () => {
    // Strip empty names before saving (keep only filled + locked)
    const toSave = JSON.parse(JSON.stringify(draft));
    for (const key of Object.keys(toSave)) {
      const section = toSave[key];
      for (const [id, name] of Object.entries(section)) {
        if (!name && !LOCKED_NAMES[id]) delete section[id];
      }
    }
    try {
      const res = await fetch(`/api/plugins/${pluginId}/moods`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toSave),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      setSavedMappings(JSON.parse(JSON.stringify(draft)));
      showToast('ok', 'Saved');
    } catch (err) {
      showToast('error', err.message);
    }
  }, [pluginId, draft, showToast]);

  const handleDiscard = useCallback(() => {
    setDraft(JSON.parse(JSON.stringify(savedMappings)));
  }, [savedMappings]);

  if (loading) return html`<div class="page-placeholder">Loading...</div>`;

  if (!draft) {
    return html`
      <div>
        <div class="page-header">Mood Mapping</div>
        <div class="ve-card" style="padding:20px;color:var(--ve-text-dim);">Plugin not running</div>
      </div>
    `;
  }

  const currentKey = editControl || '_defaults';
  const currentSection = currentKey === '_defaults' ? draft._defaults : (draft[currentKey] || null);
  const overrideUuids = Object.keys(draft).filter(k => k !== '_defaults');

  return html`
    <div>
      <div class="page-header">
        Mood Mapping
        ${hasChanges && html`<span class="mood-unsaved">Unsaved changes</span>`}
      </div>

      <div class="mood-tabs">
        <button class="mood-tab ${!editControl ? 'active' : ''}" onClick=${() => switchTab(null)}>
          Defaults
        </button>
        ${controls.map(c => {
          const hasOverride = overrideUuids.includes(c.uuid);
          return html`
            <button
              key=${c.uuid}
              class="mood-tab ${editControl === c.uuid ? 'active' : ''} ${hasOverride ? 'mood-tab--has-override' : ''}"
              onClick=${() => switchTab(c.uuid)}
            >
              ${c.name} <span class="mood-tab-room">${c.room}</span>
            </button>
          `;
        })}
      </div>

      ${editControl && !draft[editControl] && html`
        <div class="ve-card" style="padding:20px;text-align:center;">
          <div style="color:var(--ve-text-dim);margin-bottom:12px;">
            Using default mappings. Create an override to customize moods for this controller.
          </div>
          <button class="lox-cmd-btn" onClick=${() => handleCreateOverride(editControl)}>
            Create Override
          </button>
        </div>
      `}

      ${currentSection && html`
        <div class="mood-editor">
          ${currentKey !== '_defaults' && html`
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
              <span style="font-size:13px;color:var(--ve-text-dim);">
                Override for ${controls.find(c => c.uuid === currentKey)?.name || currentKey}
              </span>
              <button class="lox-push-btn" style="font-size:11px;" onClick=${() => handleDeleteOverride(currentKey)}>
                Remove Override
              </button>
            </div>
          `}

          ${hasChanges && html`
            <div class="mood-actions-bar">
              <div style="flex:1"></div>
              <button class="lox-push-btn" onClick=${handleDiscard}>Discard</button>
              <button class="lox-cmd-btn" onClick=${handleSave}>Save</button>
            </div>
          `}

          <div class="mood-list">
            <div class="mood-row mood-row--header">
              <span class="mood-id-col">ID</span>
              <span class="mood-name-col">Mood Name</span>
            </div>
            ${ALL_IDS.map(id => {
              const key = String(id);
              const name = currentSection[key] || '';
              const locked = !!LOCKED_NAMES[key];
              const savedSection = currentKey === '_defaults' ? savedMappings._defaults : (savedMappings[currentKey] || {});
              const savedName = savedSection[key] || '';
              const changed = !locked && name !== savedName;
              return html`
                <div class="mood-row ${locked ? 'mood-row--locked' : ''} ${!locked && name ? 'mood-row--filled' : ''} ${changed ? 'mood-row--changed' : ''}" key=${currentKey + ':' + id}>
                  <span class="mood-id-col">
                    <span class="mood-id-locked">${id}</span>
                  </span>
                  <span class="mood-name-col">
                    ${locked
                      ? html`<span class="mood-name-locked">${name}</span>`
                      : html`<input
                          type="text"
                          class="mood-name-input ${name ? '' : 'mood-name-empty'} ${changed ? 'mood-name-changed' : ''}"
                          value=${name}
                          placeholder="—"
                          onInput=${(e) => handleUpdateName(currentKey, id, e.target.value)}
                        />`
                    }
                  </span>
                </div>
              `;
            })}
          </div>

          ${hasChanges && html`
            <div class="mood-actions-bar">
              <div style="flex:1"></div>
              <button class="lox-push-btn" onClick=${handleDiscard}>Discard</button>
              <button class="lox-cmd-btn" onClick=${handleSave}>Save</button>
            </div>
          `}

          ${controls.length > 0 && currentKey === '_defaults' && html`
            <div style="margin-top:16px;font-size:12px;color:var(--ve-text-dim);">
              These defaults apply to all LightControllerV2 controls.
              Switch to a specific controller tab to create per-control overrides.
            </div>
          `}
        </div>
      `}

      ${toast && html`<div class="lox-toast lox-toast--${toast.type}">${toast.text}</div>`}
    </div>
  `;
}
