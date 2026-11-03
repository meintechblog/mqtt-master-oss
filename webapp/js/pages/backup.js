/**
 * Global Backup page — one-shot export/import of every plugin's input
 * bindings. Lives at `#/backup`, reachable from the sidebar.
 *
 * Pairs with the per-plugin Export/Import buttons on
 * /plugins/:id/bindings (see webapp/js/pages/input-bindings.js). The two
 * surfaces share the same file format (mqtt-master-bindings-export v1)
 * but a global file uses `scope: "all"` and a `plugins` map.
 */
import { html } from 'htm/preact';
import { useEffect, useState, useCallback } from 'preact/hooks';
import { fetchBindingsExport, applyBindingsImport, fetchPlugins } from '../lib/api-client.js';
import { validateAllImport, downloadJson, pickJsonFile } from '../lib/bindings-io.js';

export function Backup() {
  const [livePlugins, setLivePlugins] = useState([]);
  const [exporting, setExporting] = useState(false);
  const [pending, setPending] = useState(null); // parsed file awaiting apply
  const [mode, setMode] = useState('merge');
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState(null); // last apply response
  const [toast, setToast] = useState(null);

  // Pull the live plugin list so the preview table can mark each incoming
  // plugin as `known` vs `unknown` BEFORE the user commits to apply.
  useEffect(() => {
    let cancelled = false;
    fetchPlugins().then(list => { if (!cancelled) setLivePlugins(list || []); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const showToast = useCallback((type, text) => {
    setToast({ type, text });
    setTimeout(() => setToast(null), 4000);
  }, []);

  const handleDownload = useCallback(async () => {
    setExporting(true);
    try {
      const payload = await fetchBindingsExport();
      const date = new Date().toISOString().slice(0, 10);
      downloadJson(`mqtt-master-bindings-${date}.json`, payload);
      const pluginCount = Object.keys(payload.plugins || {}).length;
      const total = Object.values(payload.plugins || {}).reduce(
        (acc, e) => acc + ((e.bindings && e.bindings.length) || 0), 0);
      showToast('ok', `Downloaded backup: ${pluginCount} plugin${pluginCount === 1 ? '' : 's'}, ${total} binding${total === 1 ? '' : 's'}`);
    } catch (err) {
      showToast('error', `Export failed: ${err.message}`);
    } finally {
      setExporting(false);
    }
  }, [showToast]);

  const handlePick = useCallback(async () => {
    setResult(null);
    let picked;
    try {
      picked = await pickJsonFile();
    } catch (err) {
      showToast('error', err.message);
      return;
    }
    if (!picked) return;
    const validation = validateAllImport(picked.data);
    if (!validation.ok) {
      showToast('error', validation.errors.join(' · '));
      return;
    }
    setPending({ filename: picked.filename, data: picked.data, plugins: validation.plugins });
    setMode('merge');
  }, [showToast]);

  const handleApply = useCallback(async () => {
    if (!pending) return;
    setApplying(true);
    try {
      const resp = await applyBindingsImport(mode, pending.data);
      setResult(resp);
      const appliedTotal = (resp.applied || []).reduce((acc, a) => acc + (a.count || 0), 0);
      showToast('ok',
        `Applied ${mode}: ${appliedTotal} binding${appliedTotal === 1 ? '' : 's'} into ${(resp.applied || []).length} plugin${(resp.applied || []).length === 1 ? '' : 's'}`);
      setPending(null);
    } catch (err) {
      showToast('error', `Import failed: ${err.message}`);
    } finally {
      setApplying(false);
    }
  }, [pending, mode, showToast]);

  // Precompute per-plugin "known/unknown" for the preview table.
  const previewRows = pending
    ? Object.entries(pending.plugins).map(([pluginId, entry]) => {
        const live = livePlugins.find(p => p.id === pluginId);
        return {
          pluginId,
          pluginType: entry.pluginType || (live && live.type) || '?',
          displayName: entry.displayName || pluginId,
          count: Array.isArray(entry.bindings) ? entry.bindings.length : 0,
          known: !!live,
        };
      })
    : [];

  return html`
    <div>
      <div class="page-header">
        Backup
        <span style="font-size:14px;color:var(--ve-text-dim);font-weight:400;margin-left:8px;">
          Export &amp; restore every plugin's input bindings
        </span>
      </div>

      <!-- ─── Export card ──────────────────────────────────────── -->
      <div class="ve-card" style="padding:20px;margin-bottom:16px">
        <div style="font-size:16px;font-weight:600;margin-bottom:6px">Export everything</div>
        <div style="font-size:13px;color:var(--ve-text-dim);margin-bottom:14px">
          Downloads a single JSON file containing every plugin's MQTT input
          bindings. Keep it somewhere safe — restoring from it gets you back
          to today's wiring after a fresh install or accidental wipe.
        </div>
        <button
          class="lox-cmd-btn"
          onClick=${handleDownload}
          disabled=${exporting}
        >${exporting ? 'Preparing…' : '↓ Download backup file'}</button>
      </div>

      <!-- ─── Restore card ─────────────────────────────────────── -->
      <div class="ve-card" style="padding:20px;margin-bottom:16px">
        <div style="font-size:16px;font-weight:600;margin-bottom:6px">Restore from file</div>
        <div style="font-size:13px;color:var(--ve-text-dim);margin-bottom:14px">
          Load a previously downloaded backup file. You'll get a preview of
          what's in the file before anything is applied. Plugins in the file
          that don't exist on this server will be reported as skipped — they
          stay safe in the file for later.
        </div>
        ${!pending && html`
          <button class="lox-push-btn" onClick=${handlePick}>Choose file…</button>
        `}
        ${pending && html`
          <div style="font-size:13px;margin-bottom:10px">
            File: <strong>${pending.filename}</strong>
          </div>
          <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:12px">
            <thead>
              <tr style="text-align:left;border-bottom:1px solid var(--ve-border)">
                <th style="padding:6px 8px">Plugin</th>
                <th style="padding:6px 8px">Type</th>
                <th style="padding:6px 8px">Bindings</th>
                <th style="padding:6px 8px">Action</th>
              </tr>
            </thead>
            <tbody>
              ${previewRows.map(r => html`
                <tr key=${r.pluginId} style="border-bottom:1px solid var(--ve-border)">
                  <td style="padding:6px 8px">
                    <strong>${r.displayName}</strong>
                    <span style="color:var(--ve-text-dim);margin-left:6px">${r.pluginId}</span>
                  </td>
                  <td style="padding:6px 8px;color:var(--ve-text-dim)">${r.pluginType}</td>
                  <td style="padding:6px 8px">${r.count}</td>
                  <td style="padding:6px 8px">
                    ${r.known
                      ? html`<span style="color:var(--ve-green,#3c3)">known</span>`
                      : html`<span style="color:var(--ve-orange,#f80)">unknown — will be skipped</span>`}
                  </td>
                </tr>
              `)}
            </tbody>
          </table>
          <div style="display:flex;align-items:center;gap:16px;margin-bottom:12px;flex-wrap:wrap">
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
              <input type="radio" name="restore-mode" checked=${mode === 'merge'} onChange=${() => setMode('merge')} />
              Merge — keep existing, skip duplicates
            </label>
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
              <input type="radio" name="restore-mode" checked=${mode === 'copy'} onChange=${() => setMode('copy')} />
              Copy — import every binding as a fresh clone
            </label>
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
              <input type="radio" name="restore-mode" checked=${mode === 'replace'} onChange=${() => setMode('replace')} />
              Replace — wipe and replace each plugin's bindings
            </label>
          </div>
          <div style="display:flex;gap:8px">
            <button class="lox-push-btn" onClick=${() => { setPending(null); setResult(null); }}>Cancel</button>
            <button
              class="lox-cmd-btn"
              onClick=${() => {
                if (mode === 'replace'
                  && !window.confirm('Replace mode wipes existing bindings for every plugin listed above. Continue?')) {
                  return;
                }
                handleApply();
              }}
              disabled=${applying}
            >${applying ? 'Applying…' : 'Apply'}</button>
          </div>
        `}
        ${result && html`
          <div style="margin-top:16px;font-size:13px">
            <div style="font-weight:600;margin-bottom:6px">Result</div>
            ${(result.applied || []).length > 0 && html`
              <div style="margin-bottom:4px">
                Applied:
                ${(result.applied || []).map(a => html`<span style="margin-right:8px"><strong>${a.pluginId}</strong>: ${a.count}</span>`)}
              </div>
            `}
            ${(result.skipped || []).length > 0 && html`
              <div style="color:var(--ve-orange,#f80);margin-bottom:4px">
                Skipped (plugin not on this server):
                ${(result.skipped || []).map(s => html`<span style="margin-right:8px">${s.pluginId}</span>`)}
              </div>
            `}
            ${(result.conflicts || []).length > 0 && html`
              <div style="color:var(--ve-text-dim)">
                Duplicates skipped: ${(result.conflicts || []).length}
              </div>
            `}
          </div>
        `}
      </div>

      ${toast && html`<div class="lox-toast lox-toast--${toast.type}">${toast.text}</div>`}
    </div>
  `;
}
