/**
 * scripts/set-secret-remote.sh: runs
 * as root on the VM behind ssh. One run at a time, sharing the updater's lock;
 * service stopped while the config is written and started again on every exit
 * (also on a signal, also during the stop); success only once the app answers,
 * otherwise the previous config is restored and the exit status is 7.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '../scripts/set-secret-remote.sh');

describe('scripts/set-secret-remote.sh', () => {
  let dir;
  const log = () => readFile(join(dir, 'log'), 'utf-8').then((t) => t.trim().split('\n')).catch(() => []);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mqtt-master-remote-'));
    await writeFile(join(dir, 'env'), 'ENCRYPTION_SECRET=aus-env-0123456789\n');
    await writeFile(join(dir, 'config.json'), 'alt\n');
    // systemctl: logs "<verb>"; START_FAILS fails every start, START_FAILS_ONCE the first;
    // STOP_FAILS fails the stop, STOP_KILLS_PARENT sends TERM to the script during the stop
    await writeFile(join(dir, 'systemctl'), `#!/bin/bash
echo "$1" >> "${dir}/log"
if [ "$1" = start ]; then
  [ -n "\${START_FAILS:-}" ] && exit 1
  [ -n "\${START_FAILS_ONCE:-}" ] && [ ! -e "${dir}/started-once" ] && { touch "${dir}/started-once"; exit 1; }
fi
if [ "$1" = stop ]; then
  [ -n "\${STOP_KILLS_PARENT:-}" ] && kill -TERM $PPID && sleep 1
  [ -n "\${STOP_FAILS:-}" ] && exit 1
  [ -n "\${STOP_FAILS_SECOND:-}" ] && [ -e "${dir}/stopped-once" ] && exit 1
  touch "${dir}/stopped-once"
fi
exit 0
`, { mode: 0o755 });
    // node: logs its arguments and whether ENCRYPTION_SECRET came from the env file, saves stdin,
    // writes the backup ($4) and then the new config like set-secret.mjs
    await writeFile(join(dir, 'node'), `#!/bin/bash
echo "node $2 $3 secret=\${ENCRYPTION_SECRET:-}" >> "${dir}/log"
cat > "${dir}/stdin"
echo "$4" > "${dir}/backup-arg"
[ -n "\${NODE_KILLS_PARENT:-}" ] && kill -TERM $PPID && sleep 1
[ -n "\${NODE_RC:-}" ] && exit "$NODE_RC"
cp "$2" "$4" && echo neu > "$2"
[ -n "\${NODE_WRITES_THEN_KILLED:-}" ] && kill -TERM $PPID && sleep 1
exit 0
`, { mode: 0o755 });
    // curl: the app answers /api/version unless READY_FAILS
    await writeFile(join(dir, 'curl'), `#!/bin/bash
echo ready >> "${dir}/log"
[ -n "\${READY_FAILS:-}" ] && exit 7
exit 0
`, { mode: 0o755 });
    // cp: fails after writing half of the target when CP_FAILS (restore must stay atomic)
    await writeFile(join(dir, 'cp'), `#!/bin/bash
if [ -n "\${CP_FAILS:-}" ]; then printf 'ha' > "\${@: -1}"; exit 1; fi
exec /bin/cp "$@"
`, { mode: 0o755 });
    // flock: real flock(2) on the inherited descriptor, like util-linux flock -n <fd>
    await writeFile(join(dir, 'flock'), `#!/bin/bash
exec perl -MFcntl=:flock -e 'open(my $f, ">&=", $ARGV[-1]) or exit 1; flock($f, LOCK_EX | LOCK_NB) or exit 1' -- "$@"
`, { mode: 0o755 });
  });

  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const env = (extra = {}) => ({
    PATH: process.env.PATH,
    MQTT_MASTER_ENV_FILE: join(dir, 'env'), MQTT_MASTER_DIR: dir,
    SYSTEMCTL: join(dir, 'systemctl'), NODE: join(dir, 'node'), FLOCK: join(dir, 'flock'), CURL: join(dir, 'curl'), CP: join(dir, 'cp'),
    READY_TIMEOUT: '0',
    ...extra,
  });
  const run = (extra = {}, key = 'plugins.dreame.password') => spawnSync('/bin/bash', [SCRIPT, key], {
    env: env(extra), input: 'geheim\n', encoding: 'utf-8',
  });
  const config = () => readFile(join(dir, 'config.json'), 'utf-8');

  it('stops, writes with the env file secret and the secret on stdin, starts again and waits for the app', async () => {
    const res = run();
    expect(res.status).toBe(0);
    expect(await log()).toEqual([
      'stop',
      `node ${dir}/config.json plugins.dreame.password secret=aus-env-0123456789`,
      'start',
      'ready',
    ]);
    expect(await readFile(join(dir, 'stdin'), 'utf-8')).toBe('geheim\n');
    expect(await config()).toBe('neu\n');
  });

  it('hands set-secret.mjs a backup path next to the config', async () => {
    run();
    const backup = (await readFile(join(dir, 'backup-arg'), 'utf-8')).trim();
    expect(backup.startsWith(`${dir}/config.json.vor-set-secret-`)).toBe(true);
    expect(await readFile(backup, 'utf-8')).toBe('alt\n');
  });

  it('starts the service again and passes the error on when writing fails', async () => {
    const res = run({ NODE_RC: '2' });
    expect(res.status).toBe(2);
    expect((await log()).slice(-2)).toEqual(['start', 'ready']);
    expect(await config()).toBe('alt\n');
  });


  it('restores the previous config when the app does not answer after the change (exit 7)', async () => {
    const res = run({ READY_FAILS: '1' });
    expect(res.status).toBe(7);
    expect(await config()).toBe('alt\n');
    expect((await log()).slice(2)).toEqual(['start', 'ready', 'stop', 'start', 'ready']);
    expect(res.stderr).toContain('restor');
  });

  it('restores the previous config when the service does not start with it (exit 7)', async () => {
    const res = run({ START_FAILS_ONCE: '1' });
    expect(res.status).toBe(7);
    expect(await config()).toBe('alt\n');
    expect((await log()).slice(2)).toEqual(['start', 'stop', 'start', 'ready']);
  });

  it('reports exit 7 when the service starts neither with the new nor the old config', async () => {
    const res = run({ START_FAILS: '1' });
    expect(res.status).toBe(7);
    expect(await config()).toBe('alt\n');
    expect(res.stderr).toContain('did not start');
  });

  it('starts the service again when it is stopped by a signal while writing', async () => {
    const res = run({ NODE_KILLS_PARENT: '1' });
    expect(res.status).not.toBe(0);
    expect((await log()).slice(-2)).toEqual(['start', 'ready']);
  });


  it('restores the previous config when a signal arrives after the config was written', async () => {
    const res = run({ NODE_WRITES_THEN_KILLED: '1' });
    expect(res.status).not.toBe(0);
    expect(await config()).toBe('alt\n');
    expect((await log()).slice(-2)).toEqual(['start', 'ready']);
  });


  it('keeps the config whole and still starts the service when restoring fails', async () => {
    const res = run({ READY_FAILS: '1', CP_FAILS: '1' });
    expect(res.status).toBe(7);
    expect(await config()).toBe('neu\n');
    expect((await log()).slice(-3)).toEqual(['stop', 'start', 'ready']);
    expect((await readdir(dir)).filter((f) => f.includes('.restore-'))).toEqual([]);
  });


  it('does not restore over a service that did not stop (exit 7)', async () => {
    const res = run({ READY_FAILS: '1', STOP_FAILS_SECOND: '1' });
    expect(res.status).toBe(7);
    expect(await config()).toBe('neu\n');
    expect((await log()).slice(2)).toEqual(['start', 'ready', 'stop']);
    expect(res.stderr).toContain('did not stop');
  });


  it('starts the service again when a signal arrives during the stop', async () => {
    const res = run({ STOP_KILLS_PARENT: '1' });
    expect(res.status).not.toBe(0);
    expect(await log()).toEqual(['stop', 'start', 'ready']);
    expect(await config()).toBe('alt\n');
  });

  it('does not write, but starts the service again, when the stop fails', async () => {
    const res = run({ STOP_FAILS: '1' });
    expect(res.status).not.toBe(0);
    expect(await log()).toEqual(['stop', 'start', 'ready']);
    expect(await config()).toBe('alt\n');
  });

  // the updater's lock (scripts/update/run-update.sh), real flock(2)
  it('takes the updater lock and does nothing while another process holds it (exit 3)', async () => {
    run();
    const lock = join(dir, '.update-state', 'updater.lock');
    expect((await stat(lock)).isFile()).toBe(true);
    await rm(join(dir, 'log'));

    const holder = spawn('perl', ['-MFcntl=:flock', '-e',
      'open(F, ">>", $ARGV[0]) or die; flock(F, LOCK_EX) or die; $| = 1; print "ok\\n"; sleep 30', lock]);
    try {
      await new Promise((ok, fail) => { holder.stdout.once('data', ok); holder.once('error', fail); });
      const res = run();
      expect(res.status).toBe(3);
      expect(await log()).toEqual([]);
    } finally {
      holder.kill();
    }
  });

  it('refuses a key with other characters before touching the service (exit 2)', async () => {
    const res = run({}, 'plugins.dreame.password; reboot');
    expect(res.status).toBe(2);
    expect(await log()).toEqual([]);
  });
});
