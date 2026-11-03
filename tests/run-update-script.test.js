/**
 * scripts/update/run-update.sh – Rollback nach Fehlern ab `git reset`
 *. Befund 26.10.: Ohne errtrace griff die
 * ERR-Falle in keiner Stufenfunktion, und die() beendete ohne on_error. Auf
 * einem Host blieb der Nachtlauf deshalb in „installing“ hängen; ein Fehler nach
 * dem Reset hätte den neuen Stand ohne Rollback stehen lassen.
 *
 * Der echte Runner läuft gegen eine nachgebaute Installation (echtes Git mit
 * eigenem origin); nur die Systembefehle (systemctl, npm, curl, flock, df,
 * node) sind Platzhalter in PATH.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '../scripts/update/run-update.sh');

const STUBS = {
  systemctl: `#!/bin/bash
echo "systemctl $*" >> "$STUB_LOG"
if [ "$1" = restart ] && [ -n "$FAIL_RESTART_ALWAYS" ]; then exit 1; fi
# Nur das erste daemon-reload (Update) gelingt, das im Rollback scheitert.
if [ "$1" = daemon-reload ] && [ -n "$FAIL_RELOAD_AFTER_FIRST" ]; then
  [ -e "$STUB_DIR/reloaded" ] && exit 1
  touch "$STUB_DIR/reloaded"
fi
if [ "$1" = restart ] && [ -n "$FAIL_RESTART_ONCE" ] && [ ! -e "$STUB_DIR/restart-failed" ]; then
  touch "$STUB_DIR/restart-failed"; exit 1
fi
exit 0
`,
  npm: `#!/bin/bash
echo "npm $*" >> "$STUB_LOG"
if [ -n "$FAIL_NPM_ONCE" ] && [ ! -e "$STUB_DIR/npm-failed" ]; then
  touch "$STUB_DIR/npm-failed"; echo "npm ERR! simulated" >&2; exit 1
fi
exit 0
`,
  // Der „Dienst“ meldet den Stand, der gerade im Installationsordner liegt.
  curl: `#!/bin/bash
echo "curl $*" >> "$STUB_LOG"
if [ -n "$CURL_FIRST_NO_SHA" ] && [ ! -e "$STUB_DIR/curl-empty" ]; then
  touch "$STUB_DIR/curl-empty"; echo '{}'; exit 0
fi
head=$(git -C "$INSTALL_DIR" rev-parse HEAD)
# Neuer Stand startet nie sauber: keine Versionsantwort.
if [ -n "$CURL_UNHEALTHY_SHA" ] && [ "$head" = "$CURL_UNHEALTHY_SHA" ]; then echo '{}'; exit 0; fi
echo "{\\"sha\\":\\"$head\\"}"
`,
  flock: '#!/bin/bash\nexit 0\n',
  df: '#!/bin/bash\necho "Filesystem 1M-blocks Used Available Use% Mounted"\necho "/dev/x 9000M 1000M 8000M 12% /"\n',
  // `node -v` für die Vorprüfung; sonst die Konfigurationsprüfung des neuen Stands.
  node: `#!/bin/bash
if [ "$1" = -v ]; then echo v20.0.0; exit 0; fi
echo "node $*" >> "$STUB_LOG"
[ -z "$FAIL_CONFIG_CHECK" ]
`,
};

describe('scripts/update/run-update.sh rollback', () => {
  let dir;
  let installDir;
  let stubDir;
  let shaA;
  let shaB;

  // Eigenes HOME: weder die globale Git-Konfiguration des Macs noch das
  // `git config --global` des Runners reichen über den Testordner hinaus.
  function baseEnv() {
    return {
      PATH: process.env.PATH,
      HOME: join(dir, 'home'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    };
  }

  function git(cwd, ...args) {
    const res = spawnSync('git', args, { cwd, encoding: 'utf-8', env: baseEnv() });
    if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
    return res.stdout.trim();
  }

  async function commitVersion(seed, version, extraFiles = {}) {
    await writeFile(join(seed, 'package.json'), JSON.stringify({ name: 'fake', version }) + '\n');
    for (const [path, body] of Object.entries(extraFiles)) {
      await mkdir(join(seed, path, '..'), { recursive: true });
      await writeFile(join(seed, path), body);
    }
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', `v${version}`);
    git(seed, 'push', '-q', 'origin', 'HEAD:main');
    return git(seed, 'rev-parse', 'HEAD');
  }

  function run(extraEnv = {}) {
    return spawnSync('bash', [SCRIPT], {
      encoding: 'utf-8',
      timeout: 30000,
      env: {
        ...baseEnv(),
        PATH: `${stubDir}:${process.env.PATH}`,
        INSTALL_DIR: installDir,
        ENV_FILE: join(dir, 'env'),
        UNIT_DIR: join(dir, 'units'),
        HEALTH_TIMEOUT: '4',
        STUB_DIR: stubDir,
        STUB_LOG: join(dir, 'calls.log'),
        ...extraEnv,
      },
    });
  }

  async function state() {
    return JSON.parse(await readFile(join(installDir, '.update-state', 'state.json'), 'utf-8'));
  }

  async function calls() {
    return readFile(join(dir, 'calls.log'), 'utf-8').catch(() => '');
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mqtt-master-runner-'));
    await mkdir(join(dir, 'home'));
    await writeFile(join(dir, 'env'), 'ENCRYPTION_SECRET=test-only\n');
    await mkdir(join(dir, 'units'));
    await writeFile(join(dir, 'units', 'mqtt-master.service'), 'old unit\n');

    const origin = join(dir, 'origin.git');
    git(dir, 'init', '-q', '--bare', origin);
    const seed = join(dir, 'seed');
    git(dir, 'init', '-q', seed);
    git(seed, 'remote', 'add', 'origin', origin);
    shaA = await commitVersion(seed, '1');

    installDir = join(dir, 'install');
    git(dir, 'clone', '-q', '--branch', 'main', origin, installDir);
    // Neuer Stand mit geänderter package.json, damit npm install läuft, mit
    // Umschlüssel-Skript, damit do_check_config prüft (Aufruf über node), und
    // mit geänderter systemd-Unit, damit do_sync_unit sie kopiert.
    shaB = await commitVersion(seed, '2', {
      'scripts/rekey-config.mjs': '// fake\n',
      'scripts/mqtt-master.service': 'new unit\n',
    });

    stubDir = join(dir, 'bin');
    await mkdir(stubDir);
    for (const [name, body] of Object.entries(STUBS)) {
      await writeFile(join(stubDir, name), body);
      await chmod(join(stubDir, name), 0o755);
    }
    // state_set schreibt über python3: echter Interpreter, nur der Schreib-
    // vorgang mit dem Wert FAIL_STATE_WRITE_FOR scheitert auf Wunsch.
    const realPython = spawnSync('which', ['python3'], { encoding: 'utf-8' }).stdout.trim();
    await writeFile(join(stubDir, 'python3'), `#!/bin/bash
if [ -n "$FAIL_STATE_WRITE_FOR" ]; then
  for a in "$@"; do [ "$a" = "$FAIL_STATE_WRITE_FOR" ] && exit 1; done
fi
exec "${realPython}" "$@"
`);
    await chmod(join(stubDir, 'python3'), 0o755);
    // cp: Die Sicherung der installierten Unit bricht auf Wunsch halb ab
    // (z. B. Datenträger voll) und hinterlässt eine unvollständige Datei.
    await writeFile(join(stubDir, 'cp'), `#!/bin/bash
for last in "$@"; do :; done
if [ -n "$FAIL_UNIT_BACKUP" ] && [[ "$last" == */rollback-units/* ]]; then
  echo partial > "$last"; exit 1
fi
exec /bin/cp "$@"
`);
    await chmod(join(stubDir, 'cp'), 0o755);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('updates to origin/main when every stage succeeds', async () => {
    const res = run();
    expect(res.status).toBe(0);
    expect(git(installDir, 'rev-parse', 'HEAD')).toBe(shaB);
    expect(await state()).toMatchObject({ updateStatus: 'idle', currentSha: shaB });
  });

  it('records a failed fetch instead of staying in "installing"', async () => {
    git(installDir, 'remote', 'set-url', 'origin', join(dir, 'missing.git'));
    const res = run();
    expect(res.status).toBe(1);
    expect(git(installDir, 'rev-parse', 'HEAD')).toBe(shaA);
    const s = await state();
    expect(s.updateStatus).toBe('failed');
    expect(s.rollbackReason).toContain('stage=fetch');
  });

  it('rolls back to the previous commit when npm install fails after the reset', async () => {
    const res = run({ FAIL_NPM_ONCE: '1' });
    expect(res.status).toBe(2);
    expect(git(installDir, 'rev-parse', 'HEAD')).toBe(shaA);
    const s = await state();
    expect(s.updateStatus).toBe('rolled_back');
    expect(s.rollbackHappened).toBe(true);
    expect(s.rollbackReason).toContain('stage=install');
    expect(await calls()).toContain('systemctl restart mqtt-master');
  });

  it('rolls back when the service restart fails', async () => {
    const res = run({ FAIL_RESTART_ONCE: '1' });
    expect(res.status).toBe(2);
    expect(git(installDir, 'rev-parse', 'HEAD')).toBe(shaA);
    const s = await state();
    expect(s.updateStatus).toBe('rolled_back');
    expect(s.rollbackReason).toContain('stage=restart');
  });

  it('rolls back when the new code cannot load config.json', async () => {
    const res = run({ FAIL_CONFIG_CHECK: '1' });
    expect(res.status).toBe(2);
    expect(git(installDir, 'rev-parse', 'HEAD')).toBe(shaA);
    const s = await state();
    expect(s.updateStatus).toBe('rolled_back');
    expect(s.rollbackReason).toContain('stage=check_config');
    // Der Dienst lief noch auf dem alten Stand: kein Neustart vor der Prüfung.
    expect((await calls()).match(/^systemctl restart/gm)).toHaveLength(1);
  });

  it('installs the changed systemd unit with the update', async () => {
    expect(run().status).toBe(0);
    expect(await readFile(join(dir, 'units', 'mqtt-master.service'), 'utf-8')).toBe('new unit\n');
  });

  it('restores the previous systemd unit on rollback', async () => {
    const res = run({ FAIL_RESTART_ONCE: '1' });
    expect(res.status).toBe(2);
    expect(await readFile(join(dir, 'units', 'mqtt-master.service'), 'utf-8')).toBe('old unit\n');
  });

  it('never restores a half-written unit backup', async () => {
    const res = run({ FAIL_UNIT_BACKUP: '1' });
    expect(res.status).toBe(2);
    expect(git(installDir, 'rev-parse', 'HEAD')).toBe(shaA);
    expect(await readFile(join(dir, 'units', 'mqtt-master.service'), 'utf-8')).toBe('old unit\n');
  });

  it('reports rollback_failed when systemd cannot reload the restored unit', async () => {
    const res = run({ FAIL_RESTART_ONCE: '1', FAIL_RELOAD_AFTER_FIRST: '1' });
    expect(res.status).toBe(3);
    expect((await state()).updateStatus).toBe('rollback_failed');
  });

  it('rolls back when the new code never reports healthy', async () => {
    const res = run({ CURL_UNHEALTHY_SHA: shaB });
    expect(res.status).toBe(2);
    expect(git(installDir, 'rev-parse', 'HEAD')).toBe(shaA);
    const s = await state();
    expect(s.updateStatus).toBe('rolled_back');
    expect(s.rollbackReason).toContain('stage=verify');
  });

  it('records rollback_failed when the rollback cannot restart the service', async () => {
    const res = run({ FAIL_RESTART_ALWAYS: '1' });
    expect(res.status).toBe(3);
    const s = await state();
    expect(s.updateStatus).toBe('rollback_failed');
    expect(s.rollbackReason).toContain('stage=restart');
  });

  it('logs a failed state write after a rollback instead of hiding it', async () => {
    const res = run({ FAIL_NPM_ONCE: '1', FAIL_STATE_WRITE_FOR: 'rolled_back' });
    expect(res.status).toBe(2);
    expect(git(installDir, 'rev-parse', 'HEAD')).toBe(shaA);
    expect(res.stdout).toContain('could not write update state');
  });

  it('keeps probing without a rollback while the version answer has no sha yet', async () => {
    const res = run({ CURL_FIRST_NO_SHA: '1' });
    expect(res.status).toBe(0);
    expect(git(installDir, 'rev-parse', 'HEAD')).toBe(shaB);
    expect(await state()).toMatchObject({ updateStatus: 'idle', currentSha: shaB });
    // Genau ein npm install (Update), kein zweites aus einem Rollback.
    expect((await calls()).match(/^npm /gm)).toHaveLength(1);
  });
});
