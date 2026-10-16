/**
 * Mac mode's power manager: the Mac stays awake with the lid closed (`pmset disablesleep 1`)
 * and runs in Low Power Mode while the phone drives it; Return restores both.
 *
 * The admin password is asked ONCE, at setup: a sudoers drop-in grants this user exactly six
 * `pmset` argv lines, nothing else. It is installed inside ONE root shell (one
 * `osascript … with administrator privileges` prompt) that never names a user-writable path:
 * its temp dir is created by root under root-owned `/private/var/run` with an explicit
 * template (osascript inherits the caller's env, so a bare `mktemp` would land in the user's
 * own `$TMPDIR`), the file is checked by `visudo` before it is installed, a symlink at the
 * target is refused, and every binary is named by absolute path. At runtime only `sudo -n`
 * runs, so a missing or changed grant fails instead of prompting.
 */
import { execFile } from 'node:child_process';

export const SUDOERS_PATH = '/etc/sudoers.d/dreamcontext-handsfree';
const PMSET = '/usr/bin/pmset';
const SUDO = '/usr/bin/sudo';
const OSASCRIPT = '/usr/bin/osascript';

const USERNAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

export function isValidUsername(user: string): boolean {
  return typeof user === 'string' && user.length <= 64 && USERNAME_RE.test(user);
}

/** The six argv lines the drop-in grants — the ONLY commands `sudo -n` may run for us. */
export const PMSET_GRANTS: readonly string[] = [
  `${PMSET} -a disablesleep 0`,
  `${PMSET} -a disablesleep 1`,
  `${PMSET} -b lowpowermode 0`,
  `${PMSET} -b lowpowermode 1`,
  `${PMSET} -c lowpowermode 0`,
  `${PMSET} -c lowpowermode 1`,
];

/** The drop-in's exact content for `user`. */
export function sudoersContent(user: string): string {
  if (!isValidUsername(user)) throw new Error('invalid username');
  return [
    '# dreamcontext hands-free (Mac mode): keep the Mac awake and in Low Power Mode while a phone drives it.',
    ...PMSET_GRANTS.map((cmd) => `${user} ALL=(root) NOPASSWD: ${cmd}`),
    '',
  ].join('\n');
}

/**
 * The root shell script `osascript` runs once. The content travels as a single-quoted literal
 * (the validated username can hold no quote), written with `printf '%s'` so nothing in it is
 * read as a format; `visudo -cf` must pass before `install -m 0440` puts it in place.
 */
export function sudoersInstallScript(user: string): string {
  const content = sudoersContent(user);
  if (content.includes("'")) throw new Error('unexpected quote in sudoers content');
  return [
    'umask 077',
    'd=$(/usr/bin/mktemp -d /private/var/run/dc-sudoers.XXXXXX) || exit 1',
    `/usr/bin/printf '%s' '${content}' > "$d/f"`,
    `/bin/test ! -L ${SUDOERS_PATH} && /usr/sbin/visudo -cf "$d/f" && /usr/sbin/chown root:wheel "$d/f" && /usr/bin/install -o root -g wheel -m 0440 "$d/f" ${SUDOERS_PATH}`,
    'r=$?',
    '/bin/rm -rf "$d"',
    'exit $r',
  ].join('\n');
}

/** Removing the drop-in (uninstall): refuses to follow a symlink there. */
export function sudoersRemoveScript(): string {
  return `/bin/test ! -L ${SUDOERS_PATH} && /bin/rm -f ${SUDOERS_PATH}; /bin/test ! -e ${SUDOERS_PATH}`;
}

/** An AppleScript string literal for `script` (backslash and double quote escaped). */
export function appleScriptString(script: string): string {
  return `"${script.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** The argv for ONE admin prompt running `script` as root. */
export function adminPromptArgv(script: string): string[] {
  return ['-e', `do shell script ${appleScriptString(script)} with administrator privileges`];
}

// ─── Runner (injected in tests) ─────────────────────────────────────────────

export interface RunResult { code: number; stdout: string; stderr: string }
export type PowerRunner = (file: string, args: string[]) => Promise<RunResult>;

export const defaultPowerRunner: PowerRunner = (file, args) => new Promise((resolveRun) => {
  execFile(file, args, { env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C' }, timeout: 120_000 }, (err, stdout, stderr) => {
    const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? (err as unknown as { code: number }).code : 1) : 0;
    resolveRun({ code, stdout: String(stdout), stderr: String(stderr) });
  });
});

/** Install the drop-in with ONE admin prompt. 'cancelled' when the owner dismissed it. */
export async function installSudoers(user: string, run: PowerRunner = defaultPowerRunner): Promise<'ok' | 'cancelled' | 'failed'> {
  const r = await run(OSASCRIPT, adminPromptArgv(sudoersInstallScript(user)));
  if (r.code === 0) return 'ok';
  return /User canceled|-128/.test(r.stderr) ? 'cancelled' : 'failed';
}

export async function removeSudoers(run: PowerRunner = defaultPowerRunner): Promise<'ok' | 'cancelled' | 'failed'> {
  const r = await run(OSASCRIPT, adminPromptArgv(sudoersRemoveScript()));
  if (r.code === 0) return 'ok';
  return /User canceled|-128/.test(r.stderr) ? 'cancelled' : 'failed';
}

/** Does the grant work without a prompt? `sudo -n -l <cmd>` checks it without running it. */
export async function sudoWorks(run: PowerRunner = defaultPowerRunner): Promise<boolean> {
  const r = await run(SUDO, ['-n', '-l', PMSET, '-a', 'disablesleep', '1']);
  return r.code === 0;
}

// ─── pmset readings ─────────────────────────────────────────────────────────

export interface LpmBySource { battery: 0 | 1 | null; ac: 0 | 1 | null }

/** `pmset -g custom` → Low Power Mode per power source (null = the source reports none). */
export function parsePmsetCustom(text: string): LpmBySource {
  const out: LpmBySource = { battery: null, ac: null };
  let section: 'battery' | 'ac' | null = null;
  for (const line of text.split('\n')) {
    if (/^Battery Power:/.test(line)) { section = 'battery'; continue; }
    if (/^AC Power:/.test(line)) { section = 'ac'; continue; }
    if (/^\S/.test(line)) { section = null; continue; }
    const m = /^\s+lowpowermode\s+([01])\b/.exec(line);
    if (m && section) out[section] = Number(m[1]) as 0 | 1;
  }
  return out;
}

/** `pmset -g` → SleepDisabled (null when the line is missing). */
export function parseSleepDisabled(text: string): 0 | 1 | null {
  const m = /^\s*SleepDisabled\s+([01])\b/m.exec(text);
  return m ? (Number(m[1]) as 0 | 1) : null;
}

export interface BatteryReading { percent: number | null; charging: boolean }

/** `pmset -g batt` → the battery level and whether it is NOT discharging. */
export function parseBattery(text: string): BatteryReading {
  const pct = /(\d{1,3})%/.exec(text);
  // Drawing from the battery IS discharging, whatever the per-battery word says.
  const discharging = /'Battery Power'/.test(text) || /discharging/i.test(text);
  return { percent: pct ? Math.min(100, Number(pct[1])) : null, charging: !discharging };
}

export async function readLpm(run: PowerRunner = defaultPowerRunner): Promise<LpmBySource> {
  return parsePmsetCustom((await run(PMSET, ['-g', 'custom'])).stdout);
}

export async function readSleepDisabled(run: PowerRunner = defaultPowerRunner): Promise<0 | 1 | null> {
  return parseSleepDisabled((await run(PMSET, ['-g'])).stdout);
}

export async function readBattery(run: PowerRunner = defaultPowerRunner): Promise<BatteryReading> {
  return parseBattery((await run(PMSET, ['-g', 'batt'])).stdout);
}

// ─── Arm / restore ──────────────────────────────────────────────────────────

async function sudoPmset(run: PowerRunner, flag: '-a' | '-b' | '-c', key: 'disablesleep' | 'lowpowermode', value: 0 | 1): Promise<void> {
  const r = await run(SUDO, ['-n', PMSET, flag, key, String(value)]);
  if (r.code !== 0) throw new Error(`pmset ${flag} ${key} ${value} failed`);
}

/**
 * Start: record Low Power Mode per source FIRST, then keep the Mac awake and turn LPM on for
 * both sources. Returns what was there before, for {@link restorePower}.
 */
export async function armPower(run: PowerRunner = defaultPowerRunner): Promise<LpmBySource> {
  const prior = await readLpm(run);
  await sudoPmset(run, '-a', 'disablesleep', 1);
  if (prior.battery !== null) await sudoPmset(run, '-b', 'lowpowermode', 1);
  if (prior.ac !== null) await sudoPmset(run, '-c', 'lowpowermode', 1);
  return prior;
}

/** Sleep allowed again (Return, the battery floor, crash recovery). */
export async function allowSleep(run: PowerRunner = defaultPowerRunner): Promise<void> {
  await sudoPmset(run, '-a', 'disablesleep', 0);
}

/** Return: sleep allowed again and each source's Low Power Mode back to what it was. Every step
 *  is attempted even when one fails; the first failure is reported. */
export async function restorePower(prior: LpmBySource | null, run: PowerRunner = defaultPowerRunner): Promise<void> {
  const errors: Error[] = [];
  const attempt = async (fn: () => Promise<void>) => { try { await fn(); } catch (e) { errors.push(e as Error); } };
  await attempt(() => allowSleep(run));
  if (prior?.battery !== null && prior?.battery !== undefined) await attempt(() => sudoPmset(run, '-b', 'lowpowermode', prior.battery as 0 | 1));
  if (prior?.ac !== null && prior?.ac !== undefined) await attempt(() => sudoPmset(run, '-c', 'lowpowermode', prior.ac as 0 | 1));
  if (errors.length) throw errors[0];
}

// ─── Battery watch ──────────────────────────────────────────────────────────

/**
 * Every `intervalMs`: discharging and at or below `floorPercent` → sleep is allowed again
 * (`disablesleep 0`) and `onFloor` fires. ONCE: there is no re-arm, even after charging.
 */
export class BatteryWatch {
  private timer: ReturnType<typeof setInterval> | null = null;
  private fired = false;
  last: BatteryReading = { percent: null, charging: true };

  constructor(private readonly o: { floorPercent: number; intervalMs: number; run?: PowerRunner; onFloor: (reading: BatteryReading) => void }) {}

  get sleepAllowed(): boolean { return this.fired; }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => { void this.tick(); }, this.o.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    try { this.last = await readBattery(this.o.run); } catch { return; }
    if (this.fired) return;
    const { percent, charging } = this.last;
    if (!charging && percent !== null && percent <= this.o.floorPercent) {
      this.fired = true;
      this.stop();
      try { await allowSleep(this.o.run); } catch { /* reported by the next status read */ }
      this.o.onFloor(this.last);
    }
  }
}
