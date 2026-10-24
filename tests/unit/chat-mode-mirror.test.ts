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
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  CHAT_MODES, DEFAULT_CHAT_MODE, MODE_VERSIONS, PICKER_MODES, modeBriefing,
} from '../../src/server/chat-modes.js';
import {
  CHAT_MODE_ROWS, DEFAULT_CHAT_MODE as CLIENT_DEFAULT_CHAT_MODE, chatModeRow,
} from '../../dashboard/src/lib/chatModes.js';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

describe('chat modes — client menu <-> server allowlist mirror', () => {
  it('the menu offers exactly the modes the server accepts, in the same order', () => {
    // PICKER_MODES, not CHAT_MODES: `assistant` is bound to the hidden vault and `super` is
    // started only by the hand-over button; neither is ever offered.
    expect(CHAT_MODE_ROWS.map((r) => r.id)).toEqual([...PICKER_MODES]);
    // Basic leads the list; Train Me is last.
    expect(CHAT_MODE_ROWS.map((r) => r.id)).toEqual(['basic', 'plan', 'develop', 'train']);
    expect([...CHAT_MODES]).toEqual(['basic', 'plan', 'develop', 'train', 'assistant', 'super']);
    expect([...CHAT_MODES]).toContain('assistant');
    expect(CHAT_MODE_ROWS.map((r) => r.id as string)).not.toContain('super');
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

  it('J.A.R.V.I.S is retired from the picker, and the Assistant is never offered in it', () => {
    const ids = CHAT_MODE_ROWS.map((r) => r.id as string);
    expect(ids).not.toContain('jarvis');
    expect(ids).not.toContain('assistant');
  });

  it('NO row is disabled — every mode the server briefs is selectable', () => {
    const disabled = CHAT_MODE_ROWS.filter((r) => r.disabled).map((r) => r.id);
    expect(disabled).toEqual([]);
  });

  it('a MATURITY chip is not a badge — it says how finished a mode is, and disables nothing', () => {
    // The two chips land in the same slot and mean opposite things: `badge` announces a mode
    // that is NOT offered, `maturity` labels one that IS. Overloading `badge` for "ALPHA"
    // would have bought one word by deleting the pair rule below, which catches a real
    // mistake — so the maturity chip is its own field and never implies `disabled`.
    for (const row of CHAT_MODE_ROWS) {
      if (row.maturity) expect(row.disabled, `mode "${row.id}"`).toBeFalsy();
    }
  });

  it('the badge/disabled PAIR is still enforced for whatever gets announced next', () => {
    // The mechanism outlives J.A.R.V.I.S's use of it: a future unbuilt mode must carry both
    // or neither, so nothing ships half-announced the way this one nearly shipped
    // half-enabled.
    for (const row of CHAT_MODE_ROWS) {
      expect(Boolean(row.disabled), `mode "${row.id}"`).toBe(Boolean(row.badge));
    }
  });

  it('Train Me is offered, selectable, and wears the ALPHA chip — not a badge', () => {
    const train = chatModeRow('train');
    expect(train.id).toBe('train');
    expect(train.name).toBe('Train Me');
    expect(train.maturity).toBe('ALPHA');
    expect(train.disabled).toBeFalsy();
    expect(train.badge).toBeUndefined();
  });

  it('chatModeRow falls back to the default rather than returning undefined', () => {
    // A trigger with no word on it is worse than one naming the default, so the lookup is
    // total — including for a mode a future server adds before this build knows about it.
    expect(chatModeRow('plan').id).toBe('plan');
    expect(chatModeRow('nope' as never).id).toBe(DEFAULT_CHAT_MODE);
  });

  it('every row prints the version its brief carries on the server', () => {
    for (const row of CHAT_MODE_ROWS) {
      expect(row.version, `mode "${row.id}"`).toBe(MODE_VERSIONS[row.id as keyof typeof MODE_VERSIONS]);
      expect(row.version, `mode "${row.id}"`).toMatch(/^\d+\.\d+$/);
    }
  });

  it('a brief cannot change without its version moving', () => {
    // The version in the picker is only worth printing if it moves when the brief does. Edited
    // a brief on purpose? Bump `MODE_VERSIONS` (and the client row), then record the new
    // fingerprint here under the new version.
    const PINNED: Record<string, [version: string, fingerprint: string]> = {
      basic: ['1.0', '7c497717dfe1'],
      plan: ['1.2', 'c2422f79697d'],
      develop: ['1.2', 'ec2224ba4cd4'],
      train: ['0.1', 'f613cadc20e7'],
    };
    for (const mode of PICKER_MODES) {
      const text = modeBriefing(mode, { worktreeAllowed: true }) + '\u0000' + modeBriefing(mode, { worktreeAllowed: false });
      const fingerprint = createHash('sha256').update(text).digest('hex').slice(0, 12);
      const [version, pinned] = PINNED[mode];
      expect(MODE_VERSIONS[mode as keyof typeof MODE_VERSIONS], `mode "${mode}": version moved, re-pin its fingerprint`).toBe(version);
      expect(fingerprint, `mode "${mode}": brief changed, bump MODE_VERSIONS.${mode}`).toBe(pinned);
    }
  });

  it('both files carry the MIRRORED comment that sends the next reader to the other one', () => {
    expect(read('src/server/chat-modes.ts')).toContain('dashboard/src/lib/chatModes.ts');
    expect(read('dashboard/src/lib/chatModes.ts')).toContain('src/server/chat-modes.ts');
  });
});
