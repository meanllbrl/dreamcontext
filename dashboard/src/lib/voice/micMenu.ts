/**
 * The composer's mic split button: when it is drawn, which setup steps it carries, what its
 * menu lists, and what a press on the mic does. Pure, so the rules are tested without a
 * composer (owner, 2026-11-08: "bu mikrofon ikonunu göster her zaman").
 *
 * THE CHICKEN AND THE EGG this ends. The mic used to be drawn only once local dictation was
 * installed, and macOS asks for the microphone only when something first records. A Mac with
 * no model, or one that had never recorded, therefore had no way to reach either step from the
 * chat. Now the mic is drawn on every desktop composer whatever the permission or the model,
 * and anything missing is a step at the top of its menu.
 */

import type { MicPermission } from './micPermission';

export interface MicVisibilityInput {
  /** The composer runs inside an app's frame (no microphone path there). */
  inAppFrame: boolean;
  /** The desktop app (the only place a Mac microphone exists). */
  desktop: boolean;
  /** The hands-free phone page, while the Mac has dictation (its takes go to the Mac). */
  phoneVoice: boolean;
}

/** Drawn on every desktop composer. Deliberately NOT a function of the permission or of the
 *  dictation install: those are steps in the menu, never a reason to hide the button. */
export function micVisible(i: MicVisibilityInput): boolean {
  if (i.inAppFrame) return false;
  return i.desktop || i.phoneVoice;
}

export type MicStep = 'permission' | 'dictation';

export interface MicStepsInput {
  permission: MicPermission;
  /** Local or cloud dictation is ready to take a recording. */
  dictationReady: boolean;
  /** The phone: its permission is the phone browser's own, and setup happens on the Mac. */
  phone: boolean;
}

/** What still stands between this Mac and a take, in the order they must be done. */
export function micSetupSteps(i: MicStepsInput): MicStep[] {
  if (i.phone) return [];
  const steps: MicStep[] = [];
  // `unknown` (an older shell) offers no step: the first take asks, as it always did.
  if (i.permission === 'prompt' || i.permission === 'denied' || i.permission === 'restricted') steps.push('permission');
  if (!i.dictationReady) steps.push('dictation');
  return steps;
}

export type MicMenuItem =
  | { kind: 'step'; step: MicStep }
  | { kind: 'read-aloud'; on: boolean }
  | { kind: 'settings' };

export interface MicMenuInput {
  steps: MicStep[];
  /** Spoken replies exist in this chat (the Assistant and the Super Agent; never the phone). */
  readAloudAvailable: boolean;
  readAloudOn: boolean;
  /** Settings can be opened from here (not the phone's device shell, not an app frame). */
  settingsAvailable: boolean;
}

/** The menu, top to bottom: the missing steps first, then spoken replies, then Voice settings. */
export function micMenuItems(i: MicMenuInput): MicMenuItem[] {
  const items: MicMenuItem[] = i.steps.map((step) => ({ kind: 'step', step }));
  if (i.readAloudAvailable) items.push({ kind: 'read-aloud', on: i.readAloudOn });
  if (i.settingsAvailable) items.push({ kind: 'settings' });
  return items;
}

/** A press on the mic records only when nothing is missing; otherwise the menu opens on the
 *  missing step. A press never does nothing.
 *
 *  The dictation step blocks the press only where the surface can fix it all the way
 *  (`dictationFixable`: Voice settings is reachable). The Assistant notch has no Settings, so a
 *  missing model must not lock its mic into a menu it cannot leave: there the take goes through
 *  and the server's "dictation is not installed" notice says what is missing, as before. */
export function micPressAction(steps: MicStep[], opts: { dictationFixable: boolean } = { dictationFixable: true }): 'record' | 'open-menu' {
  const blocking = opts.dictationFixable ? steps : steps.filter((s) => s !== 'dictation');
  return blocking.length === 0 ? 'record' : 'open-menu';
}

/** The slice of the dictation install state (`GET /api/agent/voice/dictation`) the step reads. */
export interface DictationStepState {
  installed: boolean;
  choice: { engine: 'local' | 'cloud'; model: string | null } | null;
  engine: boolean;
  brew: boolean;
  key: boolean;
  recommended: string;
  models: { id: string; downloadMB: number; onDisk: boolean; fits: boolean }[];
  phase: 'idle' | 'engine' | 'model' | 'done' | 'error';
  received: number;
  total: number;
  error: string | null;
  pending: string | null;
}

export type DictationStepPlan =
  | { kind: 'checking' }
  | { kind: 'engine' }
  | { kind: 'download'; model: string | null; received: number; total: number; pct: number | null }
  /** One press installs the size this Mac can carry, through the same server install Settings uses. */
  | { kind: 'install'; model: string; downloadMB: number; onDisk: boolean }
  /** No one-press path (no Homebrew, the cloud without a key, a failed install): Voice settings. */
  | { kind: 'settings'; reason: 'no-brew' | 'cloud-key' | 'error' | 'too-big'; error?: string };

/** What the "Set up dictation" step says and does, from the install state. */
export function dictationStepPlan(s: DictationStepState | null): DictationStepPlan {
  // Installed already (this window's gate was stale): no offer, the gate is about to catch up.
  if (!s || s.installed) return { kind: 'checking' };
  if (s.phase === 'engine') return { kind: 'engine' };
  if (s.phase === 'model') {
    const pct = s.total > 0 ? Math.min(100, Math.round((s.received / s.total) * 100)) : null;
    return { kind: 'download', model: s.pending, received: s.received, total: s.total, pct };
  }
  if (s.phase === 'error') return { kind: 'settings', reason: 'error', ...(s.error ? { error: s.error } : {}) };
  if (s.choice?.engine === 'cloud' && !s.key) return { kind: 'settings', reason: 'cloud-key' };
  const rec = s.models.find((m) => m.id === s.recommended);
  if (!rec || !rec.fits) return { kind: 'settings', reason: 'too-big' };
  if (!s.engine && !s.brew) return { kind: 'settings', reason: 'no-brew' };
  return { kind: 'install', model: rec.id, downloadMB: rec.downloadMB, onDisk: rec.onDisk };
}
