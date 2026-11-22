import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readUsageMeter } from '../claude-usage-meter.js';

/**
 * C5 (plan iyilesme-360 D11): the main Super's prompt hook line while its account's window is
 * at or above {@link NEAR_LIMIT_PERCENT}. Read-only: no state is written, the guide's "tell him
 * once" carries the dedupe. A member Super, a child, a plain chat, an unreadable meter or a
 * reset already past: no line. Never throws.
 */
export const NEAR_LIMIT_PERCENT = 85;

/** Is one of `ids` the session of THIS brain's main Super record (never a member's)? */
export function mainSuperSession(contextRoot: string, ids: readonly string[]): boolean {
  const own = ids.filter(Boolean);
  if (own.length === 0) return false;
  try {
    const f = join(contextRoot, 'state', '.super-agent.json');
    const st = lstatSync(f);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 4 * 1024 * 1024) return false;
    const v = JSON.parse(readFileSync(f, 'utf-8')) as { session?: unknown };
    return typeof v.session === 'string' && own.includes(v.session);
  } catch { return false; }
}

const hhmm = (ms: number): string => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** The line, or null. `configDir` = this process's account folder (`CLAUDE_CONFIG_DIR`, else HOME). */
export function nearLimitLine(opts: { contextRoot: string; ids: readonly string[]; configDir?: string; home?: string; now?: number }): string | null {
  try {
    if (!mainSuperSession(opts.contextRoot, opts.ids)) return null;
    const home = opts.home ?? homedir();
    const reading = readUsageMeter(opts.configDir || home, home);
    if (!reading) return null;
    const now = opts.now ?? Date.now();
    const hot = reading.limits
      .filter((l) => Number.isFinite(l.percent) && l.percent >= NEAR_LIMIT_PERCENT && Number.isFinite(l.resetsAt) && l.resetsAt > now)
      .map((l) => `${l.key === 'weekly' ? 'weekly' : '5-hour'} ${Math.round(l.percent)}% · resets ${hhmm(l.resetsAt)}`);
    if (hot.length === 0) return null;
    return `[usage] ${hot.join(', ')}. New non-urgent children wait or start on sonnet; running work continues. Tell him once for this reset.`;
  } catch { return null; }
}
