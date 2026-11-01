import { CODEX_PIN } from '../lib/codex-pin.js';
import { codexEnsureNeeded } from '../lib/codex-ensure.js';
import { runFix, type RunSink } from '../lib/onboarding/fixes.js';
import { cliProbeContext } from './onboarding-tty.js';

/**
 * `dreamcontext update` keeps Codex provided: nothing to do on a machine whose Codex is fine,
 * else the pinned install, with its steps on screen. Never fails the update: Codex is a separate
 * row, and a project's refresh already landed by now.
 */
export async function ensureCodex(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (env.VITEST || env.CI || env.DREAMCONTEXT_SKIP_CODEX_ENSURE === '1' || process.platform === 'win32') return;
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
