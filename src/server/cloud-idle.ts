import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CloudPhase } from './cloud-mode.js';
import type { LiveChatSnapshotEntry } from './routes/agent-chat-live.js';

/**
 * The cloud's sleep clock (D14 schedule) and its self-stop (D15 mechanism).
 *
 * Codespaces' own idle clock only resets on a start or an ssh/editor connection (W0), so the
 * cloud decides for itself when to stop: 15 minutes after the LATER of the last turn's end
 * and the owner's last real action (send, steer, open a session, the trip arriving at the end
 * of a go, a cancelled Return putting the trip back to active — never a ping, a poll, a health
 * read, a reconnect or an open tab). A live turn defers it, at most 2 h from that turn's start. A
 * transfer in flight, a dependency install, phase going and phase quiescing defer it too
 * (quiescing at most 2 h, after which the cloud seals itself when its snapshot was served and
 * the laptop made no progress).
 *
 * At the stop time dcserver writes a stop request into its 0755 sibling dir, tied to the
 * current boot; `cloud/stop-helper.sh` (the `codespace` user, holding GitHub's in-codespace
 * token) polls it and runs `gh codespace stop`. A stale request from an earlier boot never
 * stops a fresh start (the root entrypoint also clears it at every start).
 */

export const IDLE_AFTER_MS = 15 * 60_000;
export const TURN_CAP_MS = 2 * 60 * 60_000;
export const QUIESCING_CAP_MS = 2 * 60 * 60_000;
export const GOING_CAP_MS = 2 * 60 * 60_000;
/** AC13: quiescing reverts to active after this long without laptop progress, unless served. */
export const QUIESCE_REVERT_MS = 30 * 60_000;
/** A transfer counts as in flight this long after its last byte (chunks arrive back to back). */
export const TRANSFER_GRACE_MS = 2 * 60_000;
/** A dependency install is never allowed to keep the machine up longer than this. */
export const INSTALL_CAP_MS = 2 * 60 * 60_000;

export interface IdleInputs {
  now: number;
  /** When this server started: a fresh boot gets the 15 minutes too. */
  bootAt: number;
  lastActionAt: number | null;
  lastTurnEndAt: number | null;
  /** Start times of the turns running right now. */
  busyTurnStarts: number[];
  lastTransferAt: number | null;
  /** Start times of the dependency installs running right now. */
  installStarts: number[];
  phase: CloudPhase;
  goingSince: number | null;
  quiescingSince: number | null;
}

/**
 * The stop time for these inputs (epoch ms). Pure. The caller stops when `now >= stopAt`;
 * every deferral is a LATER stop time, never an open-ended "not now", so nothing can keep
 * the machine up forever (each cause has its cap).
 */
export function computeStopAt(i: IdleInputs): number {
  let at = Math.max(i.bootAt, i.lastActionAt ?? 0, i.lastTurnEndAt ?? 0) + IDLE_AFTER_MS;
  for (const s of i.busyTurnStarts) at = Math.max(at, Math.min(s + TURN_CAP_MS, i.now + 1));
  if (i.lastTransferAt !== null) at = Math.max(at, i.lastTransferAt + TRANSFER_GRACE_MS);
  for (const s of i.installStarts) at = Math.max(at, Math.min(s + INSTALL_CAP_MS, i.now + 1));
  if (i.goingSince !== null) at = Math.max(at, Math.min(i.goingSince + GOING_CAP_MS, i.now + 1));
  if (i.phase === 'quiescing' && i.quiescingSince !== null) {
    at = Math.max(at, Math.min(i.quiescingSince + QUIESCING_CAP_MS, i.now + 1));
  }
  return at;
}

/** What the quiescing backstops say right now (AC13 + the 2 h cap). Pure. */
export function quiescingVerdict(p: {
  now: number;
  phase: CloudPhase;
  quiescingSince: number | null;
  served: boolean;
  lastLaptopProgressAt: number | null;
  /** A recovery quiesce, or one of a sealed cloud: never reverts to active by itself. */
  noRevert?: boolean;
}): 'none' | 'revert' | 'seal' {
  if (p.phase !== 'quiescing' || p.quiescingSince === null) return 'none';
  const progress = Math.max(p.quiescingSince, p.lastLaptopProgressAt ?? 0);
  if (!p.served && !p.noRevert && p.now - progress >= QUIESCE_REVERT_MS) return 'revert';
  if (p.served && p.now - p.quiescingSince >= QUIESCING_CAP_MS && p.now - progress >= QUIESCE_REVERT_MS) return 'seal';
  return 'none';
}

// ─── The service ────────────────────────────────────────────────────────────

export interface CloudIdleDeps {
  now?: () => number;
  /** The live chat registry (agent-chat-live.ts). */
  liveChats: () => readonly LiveChatSnapshotEntry[];
  /** The persisted trip state (cloud-state.ts). */
  trip: () => { phase: CloudPhase; goingSince: number | null; quiescingSince: number | null; servedEpoch: number | null; epoch: number; lastLaptopProgressAt: number | null; noRevert?: boolean };
  onRevert: () => void;
  /** The self-seal (D21): wipes the secret class FIRST, then seals. No stop while it runs. */
  onSeal: () => void | Promise<void>;
  /** Where the stop request goes (`cloudPublicDir()`). */
  publicDir: string;
  /** This boot's id (`/proc/sys/kernel/random/boot_id`); the helper ignores other boots'. */
  bootId: string;
}

export class CloudIdle {
  private readonly now: () => number;
  readonly bootAt: number;
  private lastActionAt: number | null = null;
  private lastTurnEndAt: number | null = null;
  private lastTransferAt: number | null = null;
  private transfersOpen = 0;
  private readonly installs = new Map<number, number>();
  private nextInstall = 1;
  /** Busy conversations seen at the previous tick: one that vanished (reaped, cut) ended then. */
  private busySeen = new Set<string>();
  private stopWritten = false;
  private sealing: Promise<void> | null = null;
  private lastStopAt: number | null = null;

  /** The stop time the last tick computed (epoch ms), or null before the first tick. A pure
   *  read: the phone's chip shows it, and reading it never moves the clock. */
  plannedStopAt(): number | null {
    return this.lastStopAt;
  }

  /** The self-seal in flight, if any (tests wait on it). */
  sealInFlight(): Promise<void> | null {
    return this.sealing;
  }
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: CloudIdleDeps) {
    this.now = deps.now ?? Date.now;
    this.bootAt = this.now();
  }

  /** A real owner action: send, steer, open a session, a go's activation, a cancelled Return's
   *  unquiesce. Never a ping, poll, health read or reconnect. */
  recordAction(): void {
    this.lastActionAt = this.now();
    this.stopWritten = false;
  }

  /** A transfer route began; call the returned function when its bytes are done. */
  transferBegin(): () => void {
    this.transfersOpen++;
    this.lastTransferAt = this.now();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.transfersOpen = Math.max(0, this.transfersOpen - 1);
      this.lastTransferAt = this.now();
    };
  }

  installBegin(): () => void {
    const id = this.nextInstall++;
    this.installs.set(id, this.now());
    return () => { this.installs.delete(id); };
  }

  /** Fold the live registry into our own turn-end clock (a reaped child leaves the snapshot). */
  private observeTurns(): number[] {
    const now = this.now();
    const busyNow = new Set<string>();
    const starts: number[] = [];
    for (const e of this.deps.liveChats()) {
      if (e.lastTurnEndedAt !== null) this.lastTurnEndAt = Math.max(this.lastTurnEndAt ?? 0, e.lastTurnEndedAt);
      if (e.busy) {
        busyNow.add(e.conversationId);
        starts.push(e.turnStartedAt ?? now);
      }
    }
    for (const id of this.busySeen) if (!busyNow.has(id)) this.lastTurnEndAt = Math.max(this.lastTurnEndAt ?? 0, now);
    this.busySeen = busyNow;
    return starts;
  }

  inputs(): IdleInputs {
    const t = this.deps.trip();
    const now = this.now();
    // First: folding the registry in can move lastTurnEndAt (a child that vanished).
    const busyTurnStarts = this.observeTurns();
    return {
      now,
      bootAt: this.bootAt,
      lastActionAt: this.lastActionAt,
      lastTurnEndAt: this.lastTurnEndAt,
      busyTurnStarts,
      lastTransferAt: this.transfersOpen > 0 ? now : this.lastTransferAt,
      installStarts: [...this.installs.values()],
      phase: t.phase,
      goingSince: t.goingSince,
      quiescingSince: t.quiescingSince,
    };
  }

  /** One evaluation: the quiescing backstops, then the stop decision. Returns the stop time. */
  tick(): number {
    const t = this.deps.trip();
    const verdict = quiescingVerdict({
      now: this.now(),
      phase: t.phase,
      quiescingSince: t.quiescingSince,
      served: t.servedEpoch !== null && t.servedEpoch === t.epoch,
      lastLaptopProgressAt: t.lastLaptopProgressAt,
      noRevert: t.noRevert === true,
    });
    if (verdict === 'revert') this.deps.onRevert();
    else if (verdict === 'seal' && !this.sealing) {
      this.sealing = Promise.resolve()
        .then(() => this.deps.onSeal())
        .catch((err) => { console.warn(`[cloud-idle] self-seal failed: ${(err as Error).message}`); })
        .finally(() => { this.sealing = null; });
    }
    const stopAt = computeStopAt(this.inputs());
    this.lastStopAt = stopAt;
    // Never stop while the self-seal is still wiping: a stopped cloud must not keep secrets.
    if (this.now() >= stopAt && !this.stopWritten && !this.sealing) {
      writeStopRequest(this.deps.publicDir, this.bootId(), Math.floor(this.now() / 1000));
      this.stopWritten = true;
    }
    return stopAt;
  }

  private bootId(): string {
    return this.deps.bootId;
  }

  start(intervalMs = 15_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try { this.tick(); } catch (err) { console.warn(`[cloud-idle] tick failed: ${(err as Error).message}`); }
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export const STOP_REQUEST_FILE = 'stop-request';

/** `<dueEpochSeconds> <bootId>\n`, 0644, temp + rename so the helper never reads half a line. */
export function writeStopRequest(publicDir: string, bootId: string, dueEpochSec: number): void {
  mkdirSync(publicDir, { recursive: true });
  const file = join(publicDir, STOP_REQUEST_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${dueEpochSec} ${bootId}\n`, { mode: 0o644 });
  renameSync(tmp, file);
}

export function clearStopRequest(publicDir: string): void {
  rmSync(join(publicDir, STOP_REQUEST_FILE), { force: true });
}

/** The kernel's boot id (Linux); a per-process fallback elsewhere (the test seam on a Mac). */
export function currentBootId(): string {
  try {
    const id = readFileSync('/proc/sys/kernel/random/boot_id', 'utf-8').trim();
    if (/^[0-9a-f-]{36}$/.test(id)) return id;
  } catch { /* not Linux */ }
  return `pid-${process.pid}-${Date.now()}`;
}

// ─── The process-wide instance (cloud serve wires it; agent-chat records actions) ─

let instance: CloudIdle | null = null;

export function setCloudIdle(next: CloudIdle | null): void {
  instance = next;
}

export function cloudIdle(): CloudIdle | null {
  return instance;
}

/** agent-chat.ts calls this on send, steer and session open; a no-op off the cloud. */
export function recordCloudAction(): void {
  instance?.recordAction();
}
