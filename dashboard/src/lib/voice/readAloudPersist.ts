/**
 * Keeps the speech switch (`readAloud.ts`) across relaunches.
 *
 * The desktop app serves every launch from a fresh loopback port, so the webview's origin and
 * its localStorage are new each time: a switch kept only there was back to OFF after every
 * restart. The persisted value lives in the app's settings file (`agent-ui.json`, field
 * `readAloud`, through `agentSettings.ts`); `readAloud.ts` stays the one synchronous getter the
 * speech path reads, and its localStorage copy is only that getter's cache.
 *
 * Kept OUT of `readAloud.ts` so the speech path and its tests do not pull the settings
 * transport in. Failing toward silence is deliberate: an unreadable settings file reads as OFF.
 */

import { agentSettingsReady, isAgentSettingsHydrated, onAgentSettings, patchAgentSettings, readAgentSettings } from '../agentSettings';
import { readAloudEnabled, setReadAloud } from './readAloud';

let wired = false;

function adopt(on: boolean): void {
  if (on !== readAloudEnabled()) setReadAloud(on);
}

/** Follow the persisted value from now on. Idempotent; call once a voice surface mounts. */
export function wireReadAloudPersistence(): void {
  if (wired || typeof window === 'undefined') return;
  wired = true;
  if (isAgentSettingsHydrated()) adopt(readAgentSettings().readAloud);
  else void agentSettingsReady.then((cfg) => adopt(cfg.readAloud));
  onAgentSettings((cfg) => adopt(cfg.readAloud));
}

/** The speaker button: flip the switch now, and persist it for the next launch. */
export function toggleReadAloud(on: boolean): void {
  setReadAloud(on);
  void patchAgentSettings({ readAloud: on });
}

/** Tests only. */
export function resetReadAloudPersistenceForTests(): void {
  wired = false;
}
