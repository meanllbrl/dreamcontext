/**
 * `~/.dreamcontext/logs/window-open.log`: one JSON line per step of the app's window opening a
 * chat for the server: a `super delegate` frame sent, answered, answered late, given up on; a
 * Telegram turn waiting for its Super to open. The server's stdout is /dev/null in the app, so
 * without this "the window did not confirm in time" (field 2026-11-15, three times in a row)
 * left no trace of how long the window took or whether it ever answered. Each line carries the
 * machine's load and free memory at that moment. Rotated at 512 KB; a failing write never breaks
 * an open.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { freemem, homedir, loadavg } from 'node:os';
import { join } from 'node:path';

export const OPEN_LOG_MAX_BYTES = 512 * 1024;

let homeOverride: string | null = null;
/** Test seam: where the log goes (null = the real home). */
export function _setOpenLogHomeForTests(home: string | null): void { homeOverride = home; }

/** `home`: the caller's own home (the Telegram hub's, so its tests never write the real log). */
export function appendOpenLog(event: string, fields: Record<string, unknown> = {}, home?: string): void {
  try {
    const dir = join(homeOverride ?? home ?? homedir(), '.dreamcontext', 'logs');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, 'window-open.log');
    try { if (statSync(file).size > OPEN_LOG_MAX_BYTES) renameSync(file, `${file}.1`); } catch { /* none yet */ }
    const line = JSON.stringify({
      at: new Date().toISOString(), event, ...fields,
      load1: Math.round(loadavg()[0] * 10) / 10, freeMB: Math.round(freemem() / 1048576),
    }).slice(0, 1_000);
    appendFileSync(file, `${line}\n`, { mode: 0o600 });
  } catch { /* the log never breaks an open */ }
}
