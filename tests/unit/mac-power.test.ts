// Mac mode's power manager (AC2, AC3 power half, AC10 restore, AC12 recovery match, AC13).
import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BatteryWatch, PMSET_GRANTS, SUDOERS_PATH, adminPromptArgv, armPower, installSudoers, isValidUsername,
  parseBattery, parsePmsetCustom, parseSleepDisabled, restorePower, sudoersContent, sudoersInstallScript, sudoersRemoveScript,
  type PowerRunner,
} from '../../src/lib/handsfree/mac/power.js';
import { isOurCloudflared } from '../../src/lib/handsfree/mac/tunnel.js';

const CUSTOM = `Battery Power:
 Sleep On Power Button 1
 lowpowermode         1
 sleep                1
AC Power:
 Sleep On Power Button 1
 lowpowermode         0
 sleep                0
`;

function recorder(outputs: Record<string, string> = {}): { run: PowerRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: PowerRunner = async (file, args) => {
    calls.push([file, ...args]);
    const key = [file, ...args].join(' ');
    return { code: 0, stdout: outputs[key] ?? '', stderr: '' };
  };
  return { run, calls };
}

describe('the sudoers drop-in and its ONE root shell (AC2)', () => {
  const user = 'mehmet.n_1';
  const script = sudoersInstallScript(user);

  it('grants exactly the six pmset argv lines, nothing else', () => {
    const content = sudoersContent(user);
    const grants = content.split('\n').filter((l) => l && !l.startsWith('#'));
    expect(grants).toEqual(PMSET_GRANTS.map((c) => `${user} ALL=(root) NOPASSWD: ${c}`));
    expect(grants).toHaveLength(6);
    expect(PMSET_GRANTS).toEqual([
      '/usr/bin/pmset -a disablesleep 0', '/usr/bin/pmset -a disablesleep 1',
      '/usr/bin/pmset -b lowpowermode 0', '/usr/bin/pmset -b lowpowermode 1',
      '/usr/bin/pmset -c lowpowermode 0', '/usr/bin/pmset -c lowpowermode 1',
    ]);
  });

  it('carries the content as one single-quoted literal written with printf %s', () => {
    expect(script).toContain(`/usr/bin/printf '%s' '${sudoersContent(user)}' > "$d/f"`);
  });

  it('validates the username (anything that could break the literal or the sudoers grammar is refused)', () => {
    for (const bad of ['', 'a b', "o'neil", 'x;rm', '-x', 'a"b', 'é', 'a\nb', 'x'.repeat(65), 'ALL,root']) {
      expect(isValidUsername(bad), JSON.stringify(bad)).toBe(false);
      expect(() => sudoersInstallScript(bad)).toThrow();
    }
    expect(isValidUsername('mehmetnuraydin')).toBe(true);
  });

  it('creates its temp dir under root-owned /private/var/run with an explicit template, never $TMPDIR or $HOME', () => {
    expect(script).toContain('d=$(/usr/bin/mktemp -d /private/var/run/dc-sudoers.XXXXXX) || exit 1');
    expect(script).not.toMatch(/\$TMPDIR|\$HOME|~\/|\/tmp\b|\/var\/folders/);
    expect(script.startsWith('umask 077\n')).toBe(true);
  });

  it('refuses a symlink at the target, runs visudo BEFORE install, installs root:wheel 0440, and cleans up', () => {
    const installLine = script.split('\n').find((l) => l.includes('/usr/bin/install'))!;
    expect(installLine.indexOf(`/bin/test ! -L ${SUDOERS_PATH}`)).toBe(0);
    const visudo = installLine.indexOf('/usr/sbin/visudo -cf "$d/f"');
    const install = installLine.indexOf(`/usr/bin/install -o root -g wheel -m 0440 "$d/f" ${SUDOERS_PATH}`);
    expect(visudo).toBeGreaterThan(0);
    expect(install).toBeGreaterThan(visudo);
    expect(installLine).toMatch(/&& \/usr\/sbin\/visudo .* && .* && \/usr\/bin\/install /);
    expect(script).toContain('/bin/rm -rf "$d"');
  });

  it('names every binary by absolute path', () => {
    const bare = /(^|[\s;&|(])(mktemp|rm|visudo|install|printf|test|chown|pmset|sudo|sh|cat|mv|cp)\b(?![/.-])/gm;
    const offenders = [...script.replace(/'[^']*'/g, "''").matchAll(bare)].map((m) => m[2]);
    expect(offenders).toEqual([]);
    expect(sudoersRemoveScript().replace(/\/(bin|usr)\S+/g, '')).not.toMatch(/\b(rm|test)\b/);
  });

  it('the generated content passes visudo on this machine', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sudoers-'));
    try {
      const f = join(dir, 'f');
      writeFileSync(f, sudoersContent('mehmetnuraydin'));
      expect(execFileSync('/usr/sbin/visudo', ['-cf', f], { encoding: 'utf8' })).toMatch(/parsed OK/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('asks for the admin password ONCE: one osascript, with administrator privileges, the script escaped for AppleScript', async () => {
    const { run, calls } = recorder();
    expect(await installSudoers(user, run)).toBe('ok');
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('/usr/bin/osascript');
    const as = calls[0][2];
    expect(as.startsWith('do shell script "')).toBe(true);
    expect(as.endsWith('" with administrator privileges')).toBe(true);
    expect(as).toContain('\\"$d/f\\"');
    expect(adminPromptArgv('a"b\\c')[1]).toBe('do shell script "a\\"b\\\\c" with administrator privileges');
  });

  it('reports a dismissed prompt as cancelled', async () => {
    const run: PowerRunner = async () => ({ code: 1, stdout: '', stderr: 'execution error: User canceled. (-128)' });
    expect(await installSudoers(user, run)).toBe('cancelled');
  });
});

describe('arming and restoring power (AC3, AC10)', () => {
  it('records Low Power Mode per source BEFORE changing anything, then sudo -n only', async () => {
    const { run, calls } = recorder({ '/usr/bin/pmset -g custom': CUSTOM });
    const prior = await armPower(run);
    expect(prior).toEqual({ battery: 1, ac: 0 });
    expect(calls[0]).toEqual(['/usr/bin/pmset', '-g', 'custom']);
    expect(calls.slice(1)).toEqual([
      ['/usr/bin/sudo', '-n', '/usr/bin/pmset', '-a', 'disablesleep', '1'],
      ['/usr/bin/sudo', '-n', '/usr/bin/pmset', '-b', 'lowpowermode', '1'],
      ['/usr/bin/sudo', '-n', '/usr/bin/pmset', '-c', 'lowpowermode', '1'],
    ]);
    // Every privileged call is one of the six granted argv lines.
    for (const c of calls.slice(1)) expect(PMSET_GRANTS).toContain(c.slice(2).join(' '));
  });

  it('restores sleep and each source to its recorded value', async () => {
    const { run, calls } = recorder();
    await restorePower({ battery: 1, ac: 0 }, run);
    expect(calls).toEqual([
      ['/usr/bin/sudo', '-n', '/usr/bin/pmset', '-a', 'disablesleep', '0'],
      ['/usr/bin/sudo', '-n', '/usr/bin/pmset', '-b', 'lowpowermode', '1'],
      ['/usr/bin/sudo', '-n', '/usr/bin/pmset', '-c', 'lowpowermode', '0'],
    ]);
  });

  it('a failing step still runs the rest, then reports', async () => {
    const calls: string[] = [];
    const run: PowerRunner = async (_f, args) => { calls.push(args.join(' ')); return { code: args.includes('disablesleep') ? 1 : 0, stdout: '', stderr: '' }; };
    await expect(restorePower({ battery: 0, ac: 0 }, run)).rejects.toThrow(/disablesleep/);
    expect(calls).toHaveLength(3);
  });

  it('parses pmset output (custom, SleepDisabled, batt)', () => {
    expect(parsePmsetCustom(CUSTOM)).toEqual({ battery: 1, ac: 0 });
    expect(parseSleepDisabled('System-wide power settings:\n SleepDisabled\t\t1\nCurrently in use:\n')).toBe(1);
    expect(parseSleepDisabled(' SleepDisabled\t\t0\n')).toBe(0);
    expect(parseBattery("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true")).toEqual({ percent: 100, charging: true });
    expect(parseBattery("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t14%; discharging; 1:02 remaining present: true")).toEqual({ percent: 14, charging: false });
    expect(parseBattery("Now drawing from 'AC Power'\n")).toEqual({ percent: null, charging: true });
  });
});

describe('battery floor (AC13)', () => {
  it('discharging at <=15% allows sleep once and notifies; no re-arm after charging', async () => {
    let batt = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t16%; discharging;";
    const calls: string[] = [];
    const run: PowerRunner = async (file, args) => { calls.push([file, ...args].join(' ')); return { code: 0, stdout: args.includes('batt') ? batt : '', stderr: '' }; };
    const onFloor = vi.fn();
    const w = new BatteryWatch({ floorPercent: 15, intervalMs: 60_000, run, onFloor });
    await w.tick();
    expect(onFloor).not.toHaveBeenCalled();
    batt = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t15%; discharging;";
    await w.tick();
    expect(onFloor).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c.endsWith('disablesleep 0'))).toEqual(['/usr/bin/sudo -n /usr/bin/pmset -a disablesleep 0']);
    expect(w.sleepAllowed).toBe(true);
    batt = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t60%; charging;";
    await w.tick();
    batt = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t10%; discharging;";
    await w.tick();
    expect(onFloor).toHaveBeenCalledTimes(1);
    expect(calls.some((c) => c.endsWith('disablesleep 1'))).toBe(false);
    w.stop();
  });

  it('a charging Mac below the floor is left alone', async () => {
    const run: PowerRunner = async () => ({ code: 0, stdout: "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t5%; charging;", stderr: '' });
    const onFloor = vi.fn();
    await new BatteryWatch({ floorPercent: 15, intervalMs: 60_000, run, onFloor }).tick();
    expect(onFloor).not.toHaveBeenCalled();
  });
});

describe('crash recovery kill-match (AC12)', () => {
  it('matches only our pinned cloudflared binaries', () => {
    expect(isOurCloudflared('/Users/x/.dreamcontext/bin/cloudflared-2026.10.1 tunnel --no-autoupdate', '/Users/x')).toBe(true);
    expect(isOurCloudflared('/opt/homebrew/bin/cloudflared tunnel run', '/Users/x')).toBe(false);
    expect(isOurCloudflared('/usr/bin/vim /Users/x/.dreamcontext/bin/cloudflared-2026.10.1', '/Users/x')).toBe(false);
    expect(isOurCloudflared('', '/Users/x')).toBe(false);
  });
});
