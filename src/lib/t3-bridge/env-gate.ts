/**
 * Is the write gate live for an unattended Codex run here? (Track T W4.) The gate is our PreToolUse
 * hook: it refuses writes to `_dream_context/marketing/.env` and to agent files. It does NOT refuse
 * READING any `.env`, on Claude either; the sandbox reads every file on both. `workspaceWrite`
 * would let a run write those files, and Codex has no deny list through `sandboxPolicy`, so with
 * no live hook an unattended run is refused.
 *
 * Codex runs a project's hooks only with `.codex/hooks.json` present, the project trusted AND that
 * hook trusted: it asks about the hooks separately ("Trust all and continue", seen live on 0.164).
 * `dreamcontext install --tool codex` writes the hooks; both trusts are the owner's. Codex stores
 * a hash we do not recompute, so an edited hook is caught by Codex itself, not here. The hook runs
 * the global `dreamcontext`, which must be a build that knows `--format codex`.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const NO_ENV_GATE = 'Codex would run here without the gate on marketing tokens and agent files. Run `dreamcontext install --tool codex` in this project, open `codex` there once, and trust both the folder and its hooks.';

const read = (p: string): string => { try { return readFileSync(p, 'utf-8'); } catch { return ''; } };

function trusted(config: string, path: string): boolean {
  const lines = config.split('\n');
  const at = lines.findIndex((l) => l.trim() === `[projects."${path}"]` || l.trim() === `[projects.'${path}']`);
  if (at < 0) return false;
  for (const line of lines.slice(at + 1)) {
    if (line.trim().startsWith('[')) return false;
    if (/^\s*trust_level\s*=\s*["']trusted["']/.test(line)) return true;
  }
  return false;
}

/** Codex's own record that the owner trusted this project's PreToolUse hook. */
function hookTrusted(config: string, path: string): boolean {
  const prefix = `[hooks.state."${join(path, '.codex', 'hooks.json')}:pre_tool_use:`;
  const lines = config.split('\n');
  const at = lines.findIndex((l) => l.trim().startsWith(prefix));
  if (at < 0) return false;
  let hash = false;
  for (const line of lines.slice(at + 1)) {
    if (line.trim().startsWith('[')) break;
    if (/^\s*enabled\s*=\s*false/.test(line)) return false;
    if (/^\s*trusted_hash\s*=/.test(line)) hash = true;
  }
  return hash;
}

export function codexEnvGateReady(cwd: string, home: string = homedir()): boolean {
  if (!read(join(cwd, '.codex', 'hooks.json')).includes('pre-tool-use')) return false;
  const config = read(join(home, '.codex', 'config.toml'));
  let real = cwd;
  try { real = realpathSync(cwd); } catch { /* the path as given */ }
  return [cwd, real].some((p) => trusted(config, p) && hookTrusted(config, p));
}
