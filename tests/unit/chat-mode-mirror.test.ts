/**
 * The chat-mode list exists on BOTH sides of the wire and neither side can be the single
 * source of truth:
 *
 *   • `src/server/chat-modes.ts` owns the BEHAVIOUR — the per-mode system-prompt append and
 *     the allowlist `sanitizeChatMode` validates an untrusted URL parameter against.
 *   • `dashboard/src/lib/chatModes.ts` owns the MENU — the names, the one-line insights, the
 *     "Soon" badge, the disabled flag.
 *
 * Splitting them is deliberate (prose a user reads in a popover has no business travelling in
 * a system prompt, and vice versa), but a split list drifts silently and drifts BADLY: a mode
 * added server-side only is a briefing nobody can select; a mode added client-side only is a
 * menu row whose selection the sanitizer coerces to `basic`, so the user picks "Develop" and
 * gets plain Claude with no error anywhere. Neither shows up as a failing build.
 *
 * So the ids are pinned here, POSITIONALLY — order matters too, because the menu draws the
 * rows in array order and a reordered server list would silently reorder the grid.
 *
 * Importing both sides is what makes this cheap: `chatModes.ts` is deliberately React-free
 * (no JSX, no imports at all) so root vitest's plain-Node environment can load it directly,
 * the same trick `chat-surface-lockstep.test.ts` uses on `chatActions.ts`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHAT_MODES, DEFAULT_CHAT_MODE } from '../../src/server/chat-modes.js';
import {
  CHAT_MODE_ROWS, DEFAULT_CHAT_MODE as CLIENT_DEFAULT_CHAT_MODE, chatModeRow,
} from '../../dashboard/src/lib/chatModes.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

describe('chat modes — client menu <-> server allowlist mirror', () => {
  it('the menu offers exactly the modes the server accepts, in the same order', () => {
    expect(CHAT_MODE_ROWS.map((r) => r.id)).toEqual([...CHAT_MODES]);
  });

  it('both sides default to the same mode', () => {
    expect(CLIENT_DEFAULT_CHAT_MODE).toBe(DEFAULT_CHAT_MODE);
  });

  it('the default is one the server would actually accept', () => {
    expect([...CHAT_MODES]).toContain(CLIENT_DEFAULT_CHAT_MODE);
  });

  it('every row carries the copy the menu renders', () => {
    for (const row of CHAT_MODE_ROWS) {
      expect(row.name.trim(), `mode "${row.id}" has no name`).not.toBe('');
      expect(row.insight.trim(), `mode "${row.id}" has no insight`).not.toBe('');
    }
  });

  it('J.A.R.V.I.S is announced but unpickable — a badge AND the disabled flag', () => {
    // The pair is the point: `disabled` without a badge is a dead row the user pokes at, and
    // a badge without `disabled` is a selectable mode with no behaviour behind it.
    const jarvis = CHAT_MODE_ROWS.find((r) => r.id === 'jarvis');
    expect(jarvis?.disabled).toBe(true);
    expect(jarvis?.badge).toBeTruthy();
  });

  it('no OTHER row is disabled — a mode the server briefs must be selectable', () => {
    const disabled = CHAT_MODE_ROWS.filter((r) => r.disabled).map((r) => r.id);
    expect(disabled).toEqual(['jarvis']);
  });

  it('chatModeRow falls back to the default rather than returning undefined', () => {
    // A trigger with no word on it is worse than one naming the default, so the lookup is
    // total — including for a mode a future server adds before this build knows about it.
    expect(chatModeRow('plan').id).toBe('plan');
    expect(chatModeRow('nope' as never).id).toBe(DEFAULT_CHAT_MODE);
  });

  it('both files carry the MIRRORED comment that sends the next reader to the other one', () => {
    expect(read('src/server/chat-modes.ts')).toContain('dashboard/src/lib/chatModes.ts');
    expect(read('dashboard/src/lib/chatModes.ts')).toContain('src/server/chat-modes.ts');
  });
});
