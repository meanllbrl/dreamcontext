/**
 * Is the write gate live for an unattended Codex run here? (Track T W4.) The gate is our PreToolUse
 * hook: it refuses writes to `_dream_context/marketing/.env` and to agent files. It does NOT refuse
 * READING any `.env`, on Claude either; the sandbox reads every file on both. `workspaceWrite`
 * would let a run write those files, and Codex has no deny list through `sandboxPolicy`, so with
 * no live hook an unattended run is refused.
 *
 * Two ways it is live, and Codex itself says which (`hooks/list`, `codex-user-gate.ts`), so an
 * edited hook, hooks switched off or a Codex that will not answer all refuse the run. The Mac-wide
 * one: `dreamcontext install --tool codex --global`, one approval for every folder and account.
 * The per-project one that came first: `.codex/hooks.json` in a trusted project, its hook trusted.
 *
 * The hook runs the GLOBAL `dreamcontext`, and an older build refuses `--format` and exits: Codex
 * then goes on without the gate, silently. So the hook is also asked, once, the way Codex would.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cliAwarePath } from '../automations/cli-path.js';
import { claudeAwarePath } from '../claude-path.js';
import { carryGateToAccount, codexGateLive, codexHomeFor, codexRpc, listCodexHooks, type Rpc } from './codex-user-gate.js';

export const NO_ENV_GATE = 'Codex would run here without the gate on marketing tokens and agent files. Run `dreamcontext install --tool codex --global` once: one approval for this whole Mac, of dreamcontext\'s own gate hook and nothing else. The global dreamcontext must be this version or newer.';

const read = (p: string): string => { try { return readFileSync(p, 'utf-8'); } catch { return ''; } };

/** Does the `dreamcontext` a Codex hook would find understand that hook? Empty input allows. */
function globalHookAnswers(cwd: string): boolean {
  const r = spawnSync('dreamcontext', ['hook', 'pre-tool-use', '--format', 'codex'], { cwd, input: '', env: { ...process.env, PATH: cliAwarePath(claudeAwarePath()) }, timeout: 15_000 });
  return r.status === 0;
}

/**
 * What is missing for the gate here, in the owner's words; null when it is live. Asked just before
 * a child starts, so an account that signed in after the approval gets it carried over here.
 */
export function codexEnvGateGap(cwd: string, home: string = homedir(), hookAnswers: (cwd: string) => boolean = globalHookAnswers, account?: string | null, rpc: Rpc = codexRpc): string | null {
  const primary = join(home, '.codex');
  const codexHome = codexHomeFor(home, account);
  const onMac = read(join(primary, 'hooks.json')).includes('pre-tool-use');
  const here = read(join(cwd, '.codex', 'hooks.json')).includes('pre-tool-use');
  if (!onMac && !here) return 'dreamcontext\'s gate hook is not on this Mac yet.';
  if (onMac && codexHome !== primary) carryGateToAccount(cwd, home, codexHome, rpc);
  const hooks = listCodexHooks(cwd, codexHome, rpc);
  if (!hooks) return 'Codex did not answer when asked about its hooks.';
  if (!codexGateLive(hooks, codexHome, cwd)) return 'Codex does not report dreamcontext\'s gate hook as approved here.';
  return hookAnswers(cwd) ? null : 'The global dreamcontext did not answer the Codex hook.';
}

export function codexEnvGateReady(cwd: string, home: string = homedir(), hookAnswers: (cwd: string) => boolean = globalHookAnswers, account?: string | null, rpc: Rpc = codexRpc): boolean {
  return codexEnvGateGap(cwd, home, hookAnswers, account, rpc) === null;
}
