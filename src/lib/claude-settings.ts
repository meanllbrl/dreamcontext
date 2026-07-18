import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Toggle Claude Code's native auto-memory in `<projectRoot>/.claude/settings.json`.
 *
 * Claude Code v2.1.59+ auto-loads/writes a `MEMORY.md` per project; the documented
 * kill-switch is the `autoMemoryEnabled` setting. dreamcontext disables it by default
 * so it is the single source of project memory (two competing memory systems dilute
 * recall). `disable === true` writes `autoMemoryEnabled: false`; `false` writes `true`.
 *
 * Idempotent: returns `true` only when the file content actually changed. Preserves
 * every other key in the settings file (e.g. hooks). Server-safe — this module imports
 * no interactive deps, so server routes may import it (see control-plane-api.md).
 */
export function applyClaudeAutoMemory(projectRoot: string, disable: boolean): boolean {
  const settingsPath = join(projectRoot, '.claude', 'settings.json');

  const settings = readClaudeSettings(settingsPath);

  const desired = !disable; // autoMemoryEnabled is the inverse of "disable native memory"
  if (settings.autoMemoryEnabled === desired) return false;

  settings.autoMemoryEnabled = desired;
  writeClaudeSettings(settingsPath, settings);
  return true;
}

// ─── Shared read/write ──────────────────────────────────────────────────────

function readClaudeSettings(settingsPath: string): Record<string, unknown> {
  if (!existsSync(settingsPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through to empty
  }
  return {};
}

function writeClaudeSettings(settingsPath: string, settings: Record<string, unknown>): void {
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
}

// ─── statusLine registration (pack-shipped) ─────────────────────────────────

export interface StatusLineSetting {
  type: 'command';
  command: string;
  padding?: number;
}

export type StatusLineApplyResult = 'installed' | 'refreshed' | 'unchanged' | 'conflict';

/**
 * Register a pack-shipped statusLine in `<projectRoot>/.claude/settings.json`.
 *
 * Ownership policy — a user's own statusLine is NEVER clobbered:
 *  - no statusLine present            → write ours, 'installed'
 *  - present and identical            → 'unchanged'
 *  - present and ours (same script)   → overwrite (refresh on update), 'refreshed'
 *  - present and foreign              → leave it, 'conflict' (caller warns)
 *
 * "Ours" is detected by the script basename appearing in the existing command —
 * robust across `node .claude/x.cjs` vs an absolute-path variant.
 */
export function applyClaudeStatusLine(
  projectRoot: string,
  statusLine: StatusLineSetting,
): StatusLineApplyResult {
  const settingsPath = join(projectRoot, '.claude', 'settings.json');
  const settings = readClaudeSettings(settingsPath);

  const existing = settings.statusLine as Record<string, unknown> | undefined;
  if (existing && typeof existing === 'object') {
    const existingCmd = typeof existing.command === 'string' ? existing.command : '';
    if (JSON.stringify(existing) === JSON.stringify(statusLine)) return 'unchanged';
    const script = scriptBasename(statusLine.command);
    if (!script || !existingCmd.includes(script)) return 'conflict';
    settings.statusLine = statusLine;
    writeClaudeSettings(settingsPath, settings);
    return 'refreshed';
  }

  settings.statusLine = statusLine;
  writeClaudeSettings(settingsPath, settings);
  return 'installed';
}

/**
 * Remove a pack-shipped statusLine on uninstall — only when the registered
 * command still references the pack's script (never removes a foreign one).
 * Returns true when the setting was removed.
 */
export function removeClaudeStatusLine(projectRoot: string, command: string): boolean {
  const settingsPath = join(projectRoot, '.claude', 'settings.json');
  const settings = readClaudeSettings(settingsPath);

  const existing = settings.statusLine as Record<string, unknown> | undefined;
  if (!existing || typeof existing !== 'object') return false;
  const existingCmd = typeof existing.command === 'string' ? existing.command : '';
  const script = scriptBasename(command);
  if (!script || !existingCmd.includes(script)) return false;

  delete settings.statusLine;
  writeClaudeSettings(settingsPath, settings);
  return true;
}

/** Last path segment of the script a statusLine command runs (e.g. "statusline-goalskill.cjs"). */
function scriptBasename(command: string): string | null {
  const parts = command.trim().split(/\s+/);
  const scriptArg = parts.find((p) => /\.(cjs|mjs|js|sh|py)$/.test(p));
  if (!scriptArg) return null;
  const segs = scriptArg.split('/');
  return segs[segs.length - 1] || null;
}
