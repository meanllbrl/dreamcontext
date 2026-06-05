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

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        settings = parsed as Record<string, unknown>;
      }
    } catch {
      settings = {};
    }
  }

  const desired = !disable; // autoMemoryEnabled is the inverse of "disable native memory"
  if (settings.autoMemoryEnabled === desired) return false;

  settings.autoMemoryEnabled = desired;
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  return true;
}
