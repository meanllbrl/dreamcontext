/**
 * Mac mode's orchestrator: one per desktop server process.
 *
 *   start  = preflight (setup done, `sudo -n` works)
 *            → phone listener → cloudflared (pinned) → reachability probe → power → state
 *   stop   = (Return) phone sessions let go (4401, children detach) → every Mac device revoked
 *            → tunnel + watchdog stop → phone listener stop → power restored → state cleared
 *
 * Nothing transfers and nothing locks: the work never leaves this laptop. The tunnel never
 * closes on its own (owner decision); only Return closes it. `state.json` lets the next boot
 * clean up after a crash (an orphaned cloudflared, sleep still disabled, LPM still forced).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import {
  MAC_BATTERY_FLOOR_PERCENT, MAC_BATTERY_POLL_MS, MAC_LOGIN_TOKEN_PARAM, MAC_PROBE_HEADER,
  type MacBattery, type MacDevice, type MacErrorCode, type MacPhase, type MacStatus, type MacThermal, type MacThermalState,
} from './contract.js';
import * as power from './power.js';
import * as thermal from './thermal.js';
import * as tunnel from './tunnel.js';

export class MacModeError extends Error {
  constructor(readonly code: MacErrorCode, message: string) { super(message); this.name = 'MacModeError'; }
}

export interface MacState {
  on: boolean;
  serverPid: number;
  tunnelPid: number | null;
  tunnelBin: string | null;
  startedAt: string;
  priorLpm: power.LpmBySource | null;
  sleepDisabledByUs: boolean;
  url: string | null;
  mode: 'quick' | 'fixed';
  /** The chosen projects, for REPORTING only (`status`). Never restored: a crash ends Mac mode. */
  exposedVaults?: string[];
  /** The thermal governor's ledger: a crash leaves it here and boot recovery releases it. */
  clamped?: thermal.LedgerEntry[];
}

/** The SIGTERM path's release budget: the desktop shell SIGKILLs the server 1.5 s after SIGTERM. */
export const MAC_SHUTDOWN_RELEASE_DEADLINE_MS = 800;

/** The auth store's surface the session needs (the Mac HandsfreeAuth). */
export interface MacAuthLike {
  store: {
    passphraseVerifier: unknown;
    setPassphrase(v: never): { generation: number };
    revokeAllLocal(): number;
    listDevices(): Array<{ id: string; label: string; createdAt: number }>;
    deviceCount(): number;
  };
  issueLoginToken(): string;
  clearLoginToken(): void;
}

export interface MacSessionDeps {
  home?: string;
  serverPid?: number;
  auth: () => MacAuthLike;
  hashPassphrase: (p: string) => Promise<unknown>;
  generatePassphrase: () => string;
  startListener: () => Promise<{ port: number }>;
  stopListener: () => Promise<void>;
  /** The phone listener's public origin / probe value / chip source (phone-origin.ts). */
  setPublicOrigin: (origin: string | null) => void;
  setProbeNonce: (nonce: string | null) => void;
  setPhoneSource: (src: (() => { mode: 'mac'; battery: MacBattery; sleepAllowed: boolean; thermal: MacThermal }) | null) => void;
  /** The project the phone may see and reach (phone-origin.ts); null when Mac mode is off. */
  setExposedVaults?: (names: readonly string[]) => void;
  /** Return semantics on the chat registry: phone-held sessions let go, nothing cut. */
  releasePhoneSessions: () => number;
  notify: (title: string, body: string) => void;
  powerRun?: power.PowerRunner;
  /** Battery poll interval; defaults to MAC_BATTERY_POLL_MS (the verify seam shortens it). */
  batteryPollMs?: number;
  /** Thermal governor seams: the spawn runner (osascript, ps, taskpolicy), the poll interval,
   *  the thermal reading, and a filter on which processes may be slowed (the verify's burners). */
  thermalRun?: thermal.ThermalRun;
  thermalPollMs?: number;
  readThermal?: () => Promise<MacThermalState | null>;
  thermalFilter?: (row: thermal.HeavyRow) => boolean;
  ensureBinary?: () => Promise<string>;
  setupFixedTunnel?: typeof tunnel.setupFixedTunnel;
  makeSupervisor?: (o: ConstructorParameters<typeof tunnel.TunnelSupervisor>[0], e: tunnel.SupervisorEvents) => Pick<tunnel.TunnelSupervisor, 'start' | 'stop' | 'pid' | 'url'>;
  probe?: (url: string, nonce: string) => Promise<boolean>;
  installSudoers?: (user: string) => Promise<'ok' | 'cancelled' | 'failed'>;
  removeSudoers?: () => Promise<'ok' | 'cancelled' | 'failed'>;
  sudoersInstalled?: () => boolean;
  /** `ps -o command= -p <pid>` (crash recovery's kill-match). */
  commandOf?: (pid: number) => string;
  isAlive?: (pid: number) => boolean;
  kill?: (pid: number, sig: NodeJS.Signals) => void;
  platform?: NodeJS.Platform;
}

function macDirOf(home: string): string { return join(home, '.dreamcontext', 'handsfree-mac'); }
export function statePathOf(home: string = homedir()): string { return join(macDirOf(home), 'state.json'); }

export function readMacState(home: string = homedir()): MacState | null {
  try {
    const s = JSON.parse(readFileSync(statePathOf(home), 'utf8')) as Partial<MacState>;
    if (s && s.on === true && Number.isInteger(s.serverPid)) return s as MacState;
  } catch { /* none */ }
  return null;
}

function writeState(home: string, s: MacState): void {
  const p = statePathOf(home);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
  renameSync(tmp, p);
}

function clearState(home: string): void {
  rmSync(statePathOf(home), { force: true });
}

const defaultAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };
const defaultCommandOf = (pid: number): string => {
  try { return execFileSync('/bin/ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim(); } catch { return ''; }
};

export class MacSession {
  private phase: MacPhase = 'off';
  private supervisor: Pick<tunnel.TunnelSupervisor, 'start' | 'stop' | 'pid' | 'url'> | null = null;
  private battery: power.BatteryWatch | null = null;
  private governor: thermal.ThermalGovernor | null = null;
  /** The Return in progress: a second stop (Return, then quitting the app) waits for it. */
  private stopping: Promise<void> | null = null;
  private state: MacState | null = null;
  private lastError: MacErrorCode | null = null;
  /** The projects this run exposes (chosen at start). */
  private vaults: string[] = [];
  private readonly home: string;

  constructor(private readonly d: MacSessionDeps) {
    this.home = d.home ?? homedir();
  }

  get macDir(): string { return macDirOf(this.home); }
  isOn(): boolean { return this.phase !== 'off'; }

  private sudoersInstalled(): boolean {
    return this.d.sudoersInstalled ? this.d.sudoersInstalled() : existsSync(power.SUDOERS_PATH);
  }

  status(): MacStatus {
    const fixed = tunnel.readFixedRecord(this.macDir);
    const b = this.battery?.last ?? { percent: null, charging: true };
    return {
      phase: this.phase,
      setup: { sudoers: this.sudoersInstalled(), passphrase: !!this.d.auth().store.passphraseVerifier },
      mode: this.state?.mode ?? (fixed ? 'fixed' : 'quick'),
      fixedHostname: fixed?.hostname ?? null,
      url: this.state?.url ?? null,
      startedAt: this.state?.startedAt ?? null,
      battery: { percent: b.percent, charging: b.charging },
      sleepAllowed: this.battery?.sleepAllowed ?? false,
      deviceCount: this.d.auth().store.deviceCount(),
      lastError: this.lastError,
      exposedVaults: [...this.vaults],
      thermal: this.governor?.snapshot() ?? { state: null, slowed: 0 },
    };
  }

  private thermalReleaseOpts(): Omit<thermal.ReleaseOpts, 'deadline'> {
    return { run: this.d.thermalRun ?? thermal.defaultThermalRun, uid: process.getuid?.() ?? -1, home: this.home, serverPid: this.d.serverPid ?? process.pid };
  }

  /** Release what an earlier run could not (`thermal-pending.json`). Never throws. */
  async releasePendingThermal(): Promise<void> {
    try { await thermal.releasePendingThermal({ ...this.thermalReleaseOpts(), path: thermal.thermalPendingPathOf(this.home) }); } catch { /* never blocks */ }
  }

  devices(): MacDevice[] {
    return this.d.auth().store.listDevices().map((x) => ({ id: x.id, label: x.label, createdAt: new Date(x.createdAt).toISOString() }));
  }

  /**
   * Setup: the sudoers drop-in (ONE admin prompt, skipped when already there) and, unless one
   * exists or `newPassphrase`, a fresh passphrase. Returns the passphrase ONCE (only its scrypt
   * verifier is stored), or null when an existing one was kept.
   */
  async setup(o: { newPassphrase?: boolean } = {}): Promise<{ passphrase: string | null }> {
    if ((this.d.platform ?? process.platform) !== 'darwin') throw new MacModeError('mac_unsupported_platform', 'Mac mode runs on macOS only.');
    if (!this.sudoersInstalled()) {
      const user = userInfo().username;
      const r = await (this.d.installSudoers ?? ((u: string) => power.installSudoers(u, this.d.powerRun)))(user);
      if (r === 'cancelled') throw new MacModeError('mac_admin_cancelled', 'The administrator prompt was cancelled.');
      if (r !== 'ok') throw new MacModeError('mac_sudo_missing', 'Could not install the sleep permission.');
    }
    let passphrase: string | null = null;
    if (o.newPassphrase || !this.d.auth().store.passphraseVerifier) passphrase = await this.setPassword();
    return { passphrase };
  }

  /** A new passphrase (shown once): bumps the generation and signs every Mac device out. */
  async setPassword(): Promise<string> {
    const p = this.d.generatePassphrase();
    this.d.auth().store.setPassphrase(await this.d.hashPassphrase(p) as never);
    return p;
  }

  /** The QR's URL: the tunnel address + a fresh one-time token (older tokens die). */
  mintQr(): string {
    const url = this.state?.url;
    if (this.phase !== 'on' || !url) throw new MacModeError('mac_not_on', 'Mac mode is not on.');
    return `${url}/login?${MAC_LOGIN_TOKEN_PARAM}=${this.d.auth().issueLoginToken()}`;
  }

  /** "Hepsini çıkar": every Mac device signed out (phone sockets 4401, phone-held turns cut). */
  revokeAll(): number {
    this.d.auth().clearLoginToken();
    return this.d.auth().store.revokeAllLocal();
  }

  /** Start Mac mode for the chosen projects (`vaults`, registered names): the phone sees only
   *  those. The route validates the names against the registry; changing the set = stop + start. */
  async start(opts: { vaults: string[] }): Promise<MacStatus> {
    if (this.phase !== 'off') throw new MacModeError('mac_already_on', 'Mac mode is already on.');
    await this.releasePendingThermal();
    const vaults = [...new Set((opts?.vaults ?? []).filter((v) => typeof v === 'string' && v))];
    if (!vaults.length) throw new MacModeError('mac_no_project', 'Choose at least one project.');
    if ((this.d.platform ?? process.platform) !== 'darwin') throw new MacModeError('mac_unsupported_platform', 'Mac mode runs on macOS only.');
    if (!this.d.auth().store.passphraseVerifier || !this.sudoersInstalled()) throw new MacModeError('mac_not_setup', 'Set Mac mode up first.');
    const run = this.d.powerRun;
    if (!(await power.sudoWorks(run))) throw new MacModeError('mac_sudo_missing', 'The sleep permission is missing; run setup again.');
    this.phase = 'starting';
    this.lastError = null;
    const nonce = randomBytes(16).toString('hex');
    let armed: power.LpmBySource | null = null;
    let sleepDisabled = false;
    try {
      this.vaults = vaults;
      this.d.setExposedVaults?.(vaults);
      this.d.setProbeNonce(nonce);
      const { port } = await this.d.startListener();
      let bin: string;
      try { bin = await (this.d.ensureBinary ?? (() => tunnel.ensureCloudflared({ home: this.home })))(); }
      catch (e) { throw new MacModeError('mac_binary_failed', `Could not get cloudflared: ${(e as Error).message}`); }
      const fixed = tunnel.readFixedRecord(this.macDir);
      const make = this.d.makeSupervisor ?? ((o, e) => new tunnel.TunnelSupervisor(o, e));
      this.supervisor = make(
        { bin, macDir: this.macDir, phonePort: port, fixed, serverPid: this.d.serverPid ?? process.pid },
        {
          onUrl: (url, restarted) => {
            this.d.setPublicOrigin(new URL(url).origin);
            if (this.state) { this.state = { ...this.state, url, tunnelPid: this.supervisor?.pid ?? null }; writeState(this.home, this.state); }
            if (restarted) this.d.notify('Hands-free: new address', 'The tunnel restarted. Show the new QR on your Mac to sign the phone in again.');
          },
          onGiveUp: () => {
            this.lastError = 'mac_tunnel_failed';
            this.d.setPublicOrigin(null);
            if (this.state) { this.state = { ...this.state, url: null, tunnelPid: null }; writeState(this.home, this.state); }
            this.d.notify('Hands-free: the tunnel stopped', 'Your phone cannot reach this Mac. Open Hands-free on the Mac and press Return, then start again.');
          },
        },
      );
      let url: string;
      try { url = (await this.supervisor.start()).url; }
      catch (e) { throw new MacModeError('mac_tunnel_failed', `The tunnel did not start: ${(e as Error).message}`); }
      // A fixed hostname's record exists since setup; a quick one appears seconds after its URL.
      const quick = { firstAskAfterMs: tunnel.QUICK_DNS_GRACE_MS, budgetMs: tunnel.QUICK_PROBE_BUDGET_MS };
      const ok = await (this.d.probe ?? ((u, n) => tunnel.probeReachable(u, n, { header: MAC_PROBE_HEADER, ...(fixed ? {} : quick) })))(url, nonce);
      if (!ok) throw new MacModeError('mac_probe_failed', 'The tunnel did not reach the phone listener.');
      // State BEFORE power, so a crash right after arming is still repaired at the next boot.
      this.state = {
        on: true, serverPid: this.d.serverPid ?? process.pid, tunnelPid: this.supervisor.pid, tunnelBin: bin,
        startedAt: new Date().toISOString(), priorLpm: null, sleepDisabledByUs: true, url, mode: fixed ? 'fixed' : 'quick',
        exposedVaults: [...vaults],
      };
      writeState(this.home, this.state);
      this.governor = new thermal.ThermalGovernor({
        serverPid: this.d.serverPid ?? process.pid, home: this.home, run: this.d.thermalRun,
        readThermal: this.d.readThermal, pollMs: this.d.thermalPollMs, filter: this.d.thermalFilter,
        onChange: (clamped) => { if (this.state) { this.state = { ...this.state, clamped }; writeState(this.home, this.state); } },
      });
      this.governor.start();
      sleepDisabled = true;
      armed = await power.armPower(run);
      this.state = { ...this.state, priorLpm: armed };
      writeState(this.home, this.state);
      this.battery = new power.BatteryWatch({
        floorPercent: MAC_BATTERY_FLOOR_PERCENT, intervalMs: this.d.batteryPollMs ?? MAC_BATTERY_POLL_MS, run,
        onFloor: (r) => {
          if (this.state) { this.state = { ...this.state, sleepDisabledByUs: false }; writeState(this.home, this.state); }
          this.d.notify('Hands-free: battery low', `Battery at ${r.percent ?? '?'}%. This Mac may sleep again when its lid is closed.`);
        },
      });
      this.battery.start();
      this.d.setPhoneSource(() => ({
        mode: 'mac', battery: { ...this.battery!.last }, sleepAllowed: this.battery!.sleepAllowed,
        thermal: this.governor?.snapshot() ?? { state: null, slowed: 0 },
      }));
      this.phase = 'on';
      return this.status();
    } catch (e) {
      this.lastError = e instanceof MacModeError ? e.code : 'mac_tunnel_failed';
      await this.teardown(armed, sleepDisabled);
      throw e;
    }
  }

  /** Return. Safe to call twice; every step runs even when an earlier one failed. `shutdown`
   *  (the server's SIGTERM path) bounds the thermal release by
   *  {@link MAC_SHUTDOWN_RELEASE_DEADLINE_MS}; what it could not release waits in the pending file. */
  async stop(o: { shutdown?: boolean } = {}): Promise<void> {
    if (this.phase === 'off') return;
    // A second stop never runs teardown again: the first one holds the governor and its ledger.
    if (this.stopping) return this.stopping;
    // The shutdown budget counts from here (SIGTERM), not from the release itself.
    const releaseDeadlineAt = o.shutdown ? Date.now() + MAC_SHUTDOWN_RELEASE_DEADLINE_MS : undefined;
    this.phase = 'stopping';
    this.stopping = (async () => {
      // Planned: phone-held chats let go FIRST (4401, detach), so the revocation cuts nothing.
      try { this.d.releasePhoneSessions(); } catch { /* best-effort */ }
      try { this.d.auth().clearLoginToken(); this.d.auth().store.revokeAllLocal(); } catch { /* best-effort */ }
      await this.teardown(this.state?.priorLpm ?? null, this.state?.sleepDisabledByUs ?? false, releaseDeadlineAt);
    })().finally(() => { this.stopping = null; });
    return this.stopping;
  }

  private async teardown(prior: power.LpmBySource | null, sleepDisabled: boolean, releaseDeadlineAt?: number): Promise<void> {
    // No new clamp from here on; the release itself waits until power is restored.
    const governor = this.governor;
    this.governor = null;
    governor?.halt();
    this.battery?.stop();
    this.battery = null;
    this.d.setPhoneSource(null);
    try { await this.supervisor?.stop(); } catch { /* gone */ }
    this.supervisor = null;
    try { await this.d.stopListener(); } catch { /* gone */ }
    this.d.setPublicOrigin(null);
    this.d.setProbeNonce(null);
    this.d.setExposedVaults?.([]);
    this.vaults = [];
    if (sleepDisabled || prior) {
      try { await power.restorePower(prior, this.d.powerRun); } catch { this.lastError = this.lastError ?? 'mac_sudo_missing'; }
    }
    if (governor) {
      let leftover: thermal.LedgerEntry[] = [];
      const deadlineMs = releaseDeadlineAt === undefined ? undefined : Math.max(0, releaseDeadlineAt - Date.now());
      try { leftover = await governor.releaseAll({ deadlineMs }); } catch { leftover = governor.entries(); }
      // BEFORE clearState: a kill between the two still leaves state.clamped for boot recovery.
      thermal.addPendingThermal(thermal.thermalPendingPathOf(this.home), leftover);
    }
    clearState(this.home);
    this.state = null;
    this.phase = 'off';
  }

  /**
   * Boot recovery (a desktop server start): a state left `on` by a server that is gone means a
   * crash. Kill its cloudflared ONLY if that pid still runs one of OUR pinned binaries, revoke
   * every Mac device, restore power, clear the state, tell the owner. True when it repaired.
   */
  async recoverOnBoot(): Promise<boolean> {
    await this.releasePendingThermal();
    const s = readMacState(this.home);
    if (!s) return false;
    const alive = this.d.isAlive ?? defaultAlive;
    if (s.serverPid !== (this.d.serverPid ?? process.pid) && alive(s.serverPid)) return false;
    if (s.tunnelPid && alive(s.tunnelPid) && tunnel.isOurCloudflared((this.d.commandOf ?? defaultCommandOf)(s.tunnelPid), this.home)) {
      try { (this.d.kill ?? ((p, sig) => process.kill(p, sig)))(s.tunnelPid, 'SIGTERM'); } catch { /* gone */ }
    }
    try { this.d.auth().store.revokeAllLocal(); } catch { /* best-effort */ }
    if (s.sleepDisabledByUs || s.priorLpm) {
      try { await power.restorePower(s.priorLpm, this.d.powerRun); } catch { /* reported by status */ }
    }
    const clamped = (s.clamped ?? []).filter(thermal.isLedgerEntry);
    if (clamped.length) {
      const r = await thermal.releaseLedger(clamped, this.thermalReleaseOpts());
      thermal.addPendingThermal(thermal.thermalPendingPathOf(this.home), r.leftover);
    }
    clearState(this.home);
    this.d.notify('Hands-free ended', 'dreamcontext closed while Mac mode was on. The tunnel is closed, every phone is signed out and sleep is allowed again.');
    return true;
  }

  /** `overwriteDns` only after the owner confirmed replacing a record the hostname already has. */
  async setupFixed(hostname: string, onLoginUrl?: (url: string) => void, opts: { overwriteDns?: boolean } = {}): Promise<tunnel.FixedTunnelRecord> {
    if (this.phase !== 'off') throw new MacModeError('mac_already_on', 'Press Return before changing the address.');
    const bin = await (this.d.ensureBinary ?? (() => tunnel.ensureCloudflared({ home: this.home })))();
    try {
      return await (this.d.setupFixedTunnel ?? tunnel.setupFixedTunnel)({ bin, macDir: this.macDir, hostname, onLoginUrl, overwriteDns: opts.overwriteDns === true });
    } catch (e) {
      if (e instanceof tunnel.HostnameInUseError) throw new MacModeError('mac_hostname_in_use', `${e.hostname} already points somewhere. Setting it up would replace that DNS record.`);
      throw e;
    }
  }

  removeFixed(): void {
    if (this.phase !== 'off') throw new MacModeError('mac_already_on', 'Press Return before changing the address.');
    tunnel.removeFixedTunnel(this.macDir);
  }

  /** Uninstall: Return if on, remove the drop-in (one admin prompt), then the Mac dir. */
  async uninstall(): Promise<void> {
    await this.stop();
    if (this.sudoersInstalled()) {
      const r = await (this.d.removeSudoers ?? (() => power.removeSudoers(this.d.powerRun)))();
      if (r === 'cancelled') throw new MacModeError('mac_admin_cancelled', 'The administrator prompt was cancelled.');
      if (r !== 'ok') throw new MacModeError('mac_sudo_missing', 'Could not remove the sleep permission.');
    }
    try { this.d.auth().store.revokeAllLocal(); } catch { /* gone */ }
    await this.releasePendingThermal();
    rmSync(this.macDir, { recursive: true, force: true });
  }
}
