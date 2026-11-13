import type { SettingsWay } from './InstallSheet';

/**
 * The installs the owner started from Apps, held OUTSIDE the page (app-ux-genel K8, review r1):
 * an install keeps running when he leaves Apps, so "who started it and which settings way" must
 * outlive the page. `InstallFollower` (always mounted per project) watches the server's list and
 * does the next step once; the Apps page reads the outcomes it left (a failure, an app to open).
 */

export interface Follow {
  name: string;
  settings: number;
  way: SettingsWay;
  /** When the owner pressed Install (ms). */
  at: number;
  /** When the install request answered (ms), null while it runs; `error` its refusal, if any. */
  answeredAt: number | null;
  error: string | null;
}

export type InstallOutcome =
  | { kind: 'failed'; fullName: string; name: string; why: string }
  | { kind: 'open'; slug: string; sheet: 'config' | null };

const follows = new Map<string, Map<string, Follow>>();
const outcomes = new Map<string, InstallOutcome[]>();
const subs = new Set<() => void>();
let version = 0;

function tell(): void {
  version += 1;
  for (const fn of [...subs]) fn();
}

export function subscribeInstallFollow(fn: () => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}

export function installFollowVersion(): number { return version; }

const keyOf = (fullName: string) => fullName.toLowerCase();

function mine(vault: string): Map<string, Follow> {
  let m = follows.get(vault);
  if (!m) { m = new Map(); follows.set(vault, m); }
  return m;
}

/** The owner pressed Install (before the request goes). */
export function followInstall(vault: string, fullName: string, f: { name: string; settings: number; way: SettingsWay }): void {
  mine(vault).set(keyOf(fullName), { ...f, at: Date.now(), answeredAt: null, error: null });
  tell();
}

/** The install request answered: `error` when it was refused or failed (the server may never list it). */
export function answerInstall(vault: string, fullName: string, error: string | null): void {
  const f = mine(vault).get(keyOf(fullName));
  if (!f) return;
  f.answeredAt = Date.now();
  f.error = error;
  tell();
}

export function followsOf(vault: string): ReadonlyMap<string, Follow> {
  return follows.get(vault) ?? new Map();
}

/** The follow is settled: its outcome (if any) waits for the Apps page. */
export function settleInstall(vault: string, fullName: string, outcome: InstallOutcome | null): void {
  mine(vault).delete(keyOf(fullName));
  if (outcome) outcomes.set(vault, [...(outcomes.get(vault) ?? []), outcome]);
  tell();
}

/** The Apps page takes what waits for it, once. */
export function takeInstallOutcomes(vault: string): InstallOutcome[] {
  const list = outcomes.get(vault) ?? [];
  if (!list.length) return [];
  outcomes.delete(vault);
  return list;
}

/** Tests only. */
export function resetInstallFollow(): void { follows.clear(); outcomes.clear(); tell(); }

/** One row of the server's in-flight list (`GET /api/apps/install/status`). */
export interface InstallRow { fullName: string; since: string; done?: { slug: string; settings: number } | { error: string; message?: string } }

/** What to do with one follow, given the server's list read at `readAt` (ms). */
export type FollowStep =
  | { kind: 'wait' }
  | { kind: 'settle'; outcome: InstallOutcome | null }
  | { kind: 'handoff'; slug: string };

export function stepFollow(key: string, f: Follow, installs: readonly InstallRow[], readAt: number): FollowStep {
  const row = installs.find((i) => i.fullName.toLowerCase() === key && Date.parse(i.since) >= f.at - 2000);
  if (!row) {
    // Refused before the server listed it (a gate, another install of it already running):
    // only a list read after the answer can say so.
    if (f.answeredAt === null || readAt <= f.answeredAt) return { kind: 'wait' };
    return { kind: 'settle', outcome: f.error ? { kind: 'failed', fullName: key, name: f.name, why: f.error } : null };
  }
  if (!row.done) return { kind: 'wait' };
  if ('error' in row.done) return { kind: 'settle', outcome: { kind: 'failed', fullName: row.fullName, name: f.name, why: row.done.message || f.error || row.done.error } };
  const { slug, settings } = row.done;
  if (f.way === 'self' || settings === 0) return { kind: 'settle', outcome: { kind: 'open', slug, sheet: f.way === 'self' && settings > 0 ? 'config' : null } };
  return { kind: 'handoff', slug };
}
