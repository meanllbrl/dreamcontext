/**
 * Is the `.env` gate live for an unattended Codex run here? (Track T W4, the owner's rule: the
 * gate works.) `workspaceWrite` reads every file and Codex has no deny list through
 * `sandboxPolicy`, so the gate is our PreToolUse hook, and Codex runs a project's hooks only with
 * `.codex/hooks.json` present, the project trusted AND that hook trusted: Codex asks about the
 * hooks separately ("Trust all and continue", seen live on 0.164), and a folder trusted without
 * them leaves the gate off. With no gate an unattended run is refused: nobody is there to see
 * `.env` go to the vendor. `dreamcontext install --tool codex` writes the hooks; both trusts are
 * the owner's. Codex stores a hash we do not recompute, so an edited hook is caught by Codex
 * itself (it stops running it), not here.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const NO_ENV_GATE = 'Codex would run here without the .env gate. Run `dreamcontext install --tool codex` in this project, open `codex` there once, and trust both the folder and its hooks.';

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
