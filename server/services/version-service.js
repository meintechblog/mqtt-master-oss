import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const CANDIDATE_DIRS = ['/opt/mqtt-master', process.cwd()];

let cached = null;

/**
 * @returns {string|null} the install directory containing a `.git` entry, or
 * null when running outside of a checkout (dev mode).
 */
export function findInstallDir() {
  for (const d of CANDIDATE_DIRS) {
    if (existsSync(join(d, '.git'))) return d;
  }
  return null;
}

/**
 * Parse `git describe --tags --always --dirty --abbrev=7` output into its
 * structural pieces (tag, sha, dirty flag).
 */
export function parseDescribe(out) {
  let isDirty = false;
  let v = (out || '').trim();
  if (v.endsWith('-dirty')) {
    isDirty = true;
    v = v.slice(0, -'-dirty'.length);
  }
  const tagWithCommits = v.match(/^(v[^-]+)-\d+-g([0-9a-f]{7,})$/);
  if (tagWithCommits) return { tag: tagWithCommits[1], sha: tagWithCommits[2], isDirty };
  const tagOnly = v.match(/^(v[^-]+)$/);
  if (tagOnly) return { tag: tagOnly[1], sha: null, isDirty };
  const bareSha = v.match(/^([0-9a-f]{7,})$/);
  if (bareSha) return { tag: null, sha: bareSha[1], isDirty };
  return { tag: null, sha: null, isDirty };
}

/**
 * Paths that the runner legitimately modifies on every install (npm
 * regenerates package-lock, the app writes config.json + plugin instance
 * dirs, our updater owns .update-state). Treating any of these as "dirty"
 * would block every update on a working install — so we ignore them.
 *
 * Keep this list in sync with `run-update.sh#preflight`.
 */
export const IGNORED_DIRTY_PATTERNS = [
  /^\s*M\s+package-lock\.json$/,
  /^\?\?\s+config\.json$/,
  /^\?\?\s+plugins\/[^/]+\/$/,
  /^\?\?\s+\.update-state\/$/,
];

/**
 * Decide whether `git status --porcelain` output indicates a non-trivially
 * dirty tree. Lines matching `IGNORED_DIRTY_PATTERNS` are filtered out.
 */
export function hasUnexpectedChanges(porcelainOutput) {
  return (porcelainOutput || '')
    .split('\n')
    .map(l => l.trimEnd())
    .filter(Boolean)
    .some(line => !IGNORED_DIRTY_PATTERNS.some(re => re.test(line)));
}

export function formatVersionLabel({ tag, sha, isDev }) {
  if (isDev) return 'dev';
  const short = sha ? sha.slice(0, 7) : '';
  if (tag && short) return `${tag} (${short})`;
  if (tag) return tag;
  return `main @ ${short}`;
}

/**
 * Resolve the running version once via git, cache thereafter. Returns a dev
 * fallback when there's no checkout.
 */
export async function getCurrentVersion({ refresh = false } = {}) {
  if (cached && !refresh) return cached;

  const dir = findInstallDir();
  if (!dir) {
    cached = { version: 'dev', sha: 'unknown', shortSha: 'unknown', tag: null, isDev: true, isDirty: false, installDir: null };
    return cached;
  }

  try {
    const [describeRes, revParseRes, commitDateRes, subjectRes, statusRes] = await Promise.all([
      execFileAsync('git', ['describe', '--tags', '--always', '--abbrev=7'], { cwd: dir }),
      execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: dir }),
      execFileAsync('git', ['log', '-1', '--format=%cI'], { cwd: dir }),
      execFileAsync('git', ['log', '-1', '--format=%s'], { cwd: dir }),
      execFileAsync('git', ['status', '--porcelain'], { cwd: dir }),
    ]);
    const parsed = parseDescribe(describeRes.stdout);
    const fullSha = revParseRes.stdout.trim();
    const shortSha = parsed.sha ?? fullSha.slice(0, 7);
    const isDirty = hasUnexpectedChanges(statusRes.stdout);
    const info = {
      version: '',
      sha: fullSha,
      shortSha,
      tag: parsed.tag,
      isDev: false,
      isDirty,
      commitDate: commitDateRes.stdout.trim(),
      commitSubject: subjectRes.stdout.trim(),
      installDir: dir,
    };
    info.version = formatVersionLabel(info);
    cached = info;
    return cached;
  } catch (err) {
    console.error('[version] git failed:', err.message);
    cached = { version: 'dev', sha: 'unknown', shortSha: 'unknown', tag: null, isDev: true, isDirty: false, installDir: dir };
    return cached;
  }
}

export function resetVersionCacheForTests() {
  cached = null;
}
