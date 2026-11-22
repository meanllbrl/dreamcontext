/**
 * The live-link sheet and pill as pure functions (tunel-paylasim, approved drawing rapor.html
 * sections 2 and 4). No React: the root vitest runs it as it is.
 */
import type { LiveShare, ShareKind, ShareStage } from '../../lib/sharesApi';

/** Which of the sheet's four faces shows (drawing section 2: a, b, c, d). */
export type SheetPhase = 'form' | 'starting' | 'open' | 'broken';

/** The sheet's face for the target's current share (none, or one that is closing: the form again). */
export function sheetPhase(share: LiveShare | null): SheetPhase {
  if (!share || share.state === 'closing') return 'form';
  if (share.state === 'starting') return 'starting';
  if (share.state === 'open') return 'open';
  return 'broken';
}

/** The share of this target, if one is live or broken (D9: one per app, one per board). */
export function shareFor(rows: readonly LiveShare[] | undefined, kind: ShareKind, vault: string, slug: string): LiveShare | null {
  return rows?.find((s) => s.kind === kind && s.vault === vault && s.slug === slug && s.state !== 'closing') ?? null;
}

const STAGES: readonly ShareStage[] = ['download', 'tunnel', 'probe'];

/** `{n}` of the "(n/3)" in the starting line; an unknown stage reads as the first. */
export function stageStep(stage: ShareStage | null): number {
  const i = stage ? STAGES.indexOf(stage) : -1;
  return i < 0 ? 1 : i + 1;
}

/** The i18n key of a start failure; an unknown code gets the general line. */
export function errorKey(code: string | undefined): string {
  switch (code) {
    case 'download_failed': return 'liveShare.error.download';
    case 'tunnel_failed': return 'liveShare.error.tunnel';
    case 'probe_failed': return 'liveShare.error.probe';
    case 'tunnel_exited': return 'liveShare.error.exited';
    default: return 'liveShare.error.other';
  }
}

export const PASSWORD_MIN = 10;

/** A password the server takes: empty (none) is handled by the switch, so here at least 10. */
export function passwordOk(pw: string): boolean {
  return pw.length >= PASSWORD_MIN && pw.length <= 200;
}

const WORDS = [
  'kavun', 'deniz', 'fener', 'nehir', 'bulut', 'kumsal', 'orman', 'lamba', 'yaprak', 'kartal',
  'pusula', 'tepe', 'meltem', 'limon', 'liman', 'mercan', 'kestane', 'defne', 'vadi', 'kaya',
  'papatya', 'zeytin', 'ceviz', 'sahil', 'armut', 'ayva', 'dalga', 'ada', 'patika', 'incir',
];

/** Three words joined by `-` (drawing: "kavun-deniz-fener"); `rand` returns [0, 1). Words with no
 *  Turkish-only letter, so any keyboard types them and none reads misspelled. */
export function suggestPassword(rand: () => number = Math.random): string {
  const pick = () => WORDS[Math.min(WORDS.length - 1, Math.floor(rand() * WORDS.length))];
  let out = `${pick()}-${pick()}-${pick()}`;
  while (out.length < PASSWORD_MIN) out += `-${pick()}`;
  return out;
}

/** Whole minutes since `openedAt` (never negative; an unreadable date is 0). */
export function minutesOpen(openedAt: string, now: number): number {
  const t = Date.parse(openedAt);
  return Number.isNaN(t) ? 0 : Math.max(0, Math.floor((now - t) / 60_000));
}

/** The pill (drawing section 4): shown while any link is starting, open or broken; red when one broke. */
export function pillState(rows: readonly LiveShare[] | undefined): { count: number; bad: boolean } | null {
  const live = (rows ?? []).filter((s) => s.state !== 'closing');
  if (!live.length) return null;
  return { count: live.length, bad: live.some((s) => s.state === 'broken') };
}
