import { CODEX_PIN } from '../lib/codex-pin.js';
import { codexEnsureNeeded } from '../lib/codex-ensure.js';
import { runFix, type RunSink } from '../lib/onboarding/fixes.js';
import { cliProbeContext } from './onboarding-tty.js';

/**
 * `dreamcontext update` keeps Codex provided: nothing to do on a machine whose Codex is fine,
 * else the pinned install, with its steps on screen. A person at a terminal only: the app and the
 * project catch-up run `update` per project with a timeout, and a 100 MB download inside that
 * would fail the update it hangs off. Those machines get Codex from the app's own job.
 */
export function codexEnsureSkipped(env: NodeJS.ProcessEnv, tty: boolean | undefined): boolean {
  return !tty || !!env.VITEST || !!env.CI || env.DREAMCONTEXT_SKIP_CODEX_ENSURE === '1' || process.platform === 'win32';
}

export async function ensureCodex(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (codexEnsureSkipped(env, process.stdout.isTTY)) return;
  try {
    if (!codexEnsureNeeded()) return;
    console.log(`Codex ${CODEX_PIN.version}: installing beside anything already here.`);
    const sink: RunSink = {
      output: (c) => { if (c.endsWith('\n')) process.stdout.write(`  ${c}`); },
      progress: () => undefined,
      awaiting: () => undefined,
      deviceCode: () => undefined,
      onCancel: () => undefined,
    };
    const r = await runFix('codex-update', cliProbeContext(), sink, new AbortController().signal);
    console.log(r.ok ? 'Codex is ready.' : `Codex was not installed: ${r.detail ?? r.reason ?? 'unknown'}. Claude is not affected; run dreamcontext setup to try again.`);
  } catch (err) {
    console.log(`Codex was not installed: ${(err as Error).message}`);
  }
}
