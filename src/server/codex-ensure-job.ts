import { codexEnsuredFor, codexEnsureNeeded, markCodexEnsured } from '../lib/codex-ensure.js';
import { readDreamcontextVersionFromDisk } from '../lib/manifest.js';
import { selfUpdateJobDisabledReason } from './self-update-job.js';
import { serverProbeContext, startFixRun } from './install-runs.js';

const FIRST_TICK_MS = 2 * 60_000;

/**
 * An app update keeps Codex provided: once per dreamcontext version, from the app-owned server
 * only (the rule the self-update job follows, so a verify server never downloads anything), in the
 * same run store as the buttons. A failure is logged and asked again on the next start.
 */
export function startCodexEnsureJob(env: NodeJS.ProcessEnv = process.env): (() => void) | undefined {
  if (selfUpdateJobDisabledReason(env)) return undefined;
  const version = readDreamcontextVersionFromDisk();
  if (!version || codexEnsuredFor() === version) return undefined;
  const t = setTimeout(() => {
    try {
      if (!codexEnsureNeeded()) { markCodexEnsured(version); return; }
      startFixRun('codex-update', serverProbeContext('desktop'), {
        onDone: (outcome) => {
          if (outcome.ok) markCodexEnsured(version);
          else console.error(`[codex-ensure] ${outcome.reason ?? 'failed'}: ${outcome.detail ?? ''}`);
        },
      });
    } catch (err) {
      console.error('[codex-ensure]', err);
    }
  }, FIRST_TICK_MS);
  t.unref?.();
  return () => clearTimeout(t);
}
