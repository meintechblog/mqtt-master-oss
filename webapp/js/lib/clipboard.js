/**
 * Copy `text` to the clipboard — works on plain-HTTP LAN origins too.
 *
 * The async Clipboard API (`navigator.clipboard.writeText`) is only available
 * in *secure contexts* (HTTPS / localhost). mqtt-master boxes are reached over
 * plain `http://192.168.x.x`, where `navigator.clipboard` is `undefined` — so
 * a bare `navigator.clipboard.writeText(...)` throws and the optional-chained
 * `navigator.clipboard?.writeText(...)` silently no-ops (button does nothing,
 * no ✓ feedback). We therefore fall back to a hidden `<textarea>` +
 * `document.execCommand('copy')`, which has no secure-context requirement and
 * still works in every browser we target on the LAN.
 *
 * Never throws — callers can treat the boolean as "did it land".
 *
 * @param {string} text
 * @returns {Promise<boolean>} true on success, false if every path failed.
 */
export async function copyToClipboard(text) {
  const value = text == null ? '' : String(text);

  // Preferred path: async Clipboard API (secure contexts only).
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Permission denied / transient failure — fall through to the legacy path.
    }
  }

  // Fallback: off-screen textarea + execCommand('copy'). Works on http origins.
  try {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, value.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok === true;
  } catch {
    return false;
  }
}
