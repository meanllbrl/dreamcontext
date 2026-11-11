/**
 * `~/.dreamcontext/logs/telegram-asks.log`: one line per question sent to Telegram, and one per
 * question's pictures (how many of its drawings went, which did not and why). The server's stdout
 * is /dev/null in the app, so without this a lost question or a missing picture leaves no trace
 * (owner 2026-11-10: "resimli sorular Telegram'a düşmüyor" could not be told from the log).
 * Rotated at 512 KB; a write that fails never breaks a send.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { redactSecrets } from '../../lib/telegram/format.js';

export const ASK_LOG_MAX_BYTES = 512 * 1024;

export function appendAskLog(home: string, line: string): void {
  try {
    const dir = join(home, '.dreamcontext', 'logs');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, 'telegram-asks.log');
    try { if (statSync(file).size > ASK_LOG_MAX_BYTES) renameSync(file, `${file}.1`); } catch { /* none yet */ }
    const clean = redactSecrets(line).replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 600);
    appendFileSync(file, `${new Date().toISOString()} ${clean}\n`, { mode: 0o600 });
  } catch { /* the log never breaks a send */ }
}
