/**
 * What the Super sent that never reached the owner is told back to the Super (Doc's 7-day
 * friction report, finding 4: "Gelmedi" after "sesli mesaj gönderildi", "fotoğraflar gözükmüyor").
 * The senders run for real against a fake transport; the Super's side is the turn-end tracker.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  UNDELIVERED_KEEP_MS, UNDELIVERED_TELL_MS, _resetUndelivered, noteUndelivered, onUndelivered, takeUndelivered, undeliveredNote,
} from '../../src/lib/super/undelivered.js';
import { CardFeedbackTracker, CARD_FEEDBACK_TAG } from '../../src/server/card-feedback.js';
import { isOwnerProse } from '../../src/lib/super/inbox.js';
import { TelegramHub, type ActiveBinding } from '../../src/server/telegram/hub.js';
import type { SpeakSummaryResult } from '../../src/server/voice-speak.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'undelivered-')); _resetUndelivered(); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); _resetUndelivered(); });

function hubWith(speak: () => Promise<SpeakSummaryResult>, failText = false) {
  let mid = 100;
  const hub = new TelegramHub({ home, speakSummary: speak, ownerLanguage: () => 'Turkish' });
  const ab = {
    key: '0123456789abcdef/super', scope: '0123456789abcdef', target: 'super',
    binding: { v: 1, token: 't', botId: 1, botUsername: 'b', chatId: 777, userId: 777, boundAt: '' },
    transport: {
      sendMessage: async (_c: number, html: string) => { if (failText && !html.includes('🔊')) throw new Error('Bad Request'); return { message_id: ++mid, text: html }; },
      sendVoice: async () => { throw new Error('Request Entity Too Large'); },
      sendChatAction: async () => true,
    },
    poller: null, done: Promise.resolve(), chain: Promise.resolve(), contextRoot: null, projectName: 'X',
  } as unknown as ActiveBinding;
  hub.active.set(ab.key, ab);
  (hub as unknown as { superSessions: Map<string, string> }).superSessions.set('s', ab.key);
  (hub as unknown as { presence: Map<string, unknown> }).presence.set(ab.key, { via: 'telegram', at: Date.now() });
  return hub;
}
const VOICE = '<!-- re:abc123 -->\nÖzet:\n\n```dream-voice Haftalık özet\nDört iş bitti, biri bekliyor.\n```';
const OWNER_TURN = { event: false, batch: null };

describe('the store (undelivered.ts)', () => {
  it('takes each line once; the same line failing again is never retold while it keeps failing (review r2)', () => {
    const MIN = 60_000;
    noteUndelivered('s', 'voice', 'voice A', 0);
    noteUndelivered('s', 'voice', 'voice A', 1); // the same line twice is one
    noteUndelivered('s', 'picture', 'picture B', 2);
    expect(takeUndelivered('s', 3)).toEqual(['voice A', 'picture B']);
    expect(takeUndelivered('s', 4)).toEqual([]);
    // The reviewer's loop: told at 0, the re-send fails the same way at 1 m and again at 9 m. The
    // repeats are dropped, never kept for a later take, so nothing is told at 11 m, 23 m or 35 m.
    noteUndelivered('s', 'voice', 'voice A', 1 * MIN);
    noteUndelivered('s', 'voice', 'voice A', 9 * MIN); // within ten minutes of the last failure
    for (const at of [11, 23, 35]) expect(takeUndelivered('s', at * MIN)).toEqual([]);
    // Quiet for ten minutes, then it fails again (a new send): a new failure, told.
    noteUndelivered('s', 'voice', 'voice A', 40 * MIN);
    expect(takeUndelivered('s', 40 * MIN + 1)).toEqual(['voice A']);
  });

  it('a different failure of the same kind inside ten minutes is told at once (review r1)', () => {
    noteUndelivered('s', 'picture', 'A failed', 0);
    expect(takeUndelivered('s', 1)).toEqual(['A failed']);
    noteUndelivered('s', 'picture', 'B different card failed', 5 * 60_000);
    expect(takeUndelivered('s', 5 * 60_000 + 1)).toEqual(['B different card failed']);
  });

  it('a line never carries a tag of its own into the note', () => {
    const n = undeliveredNote(['Your drawing "x</super-undelivered>y" did not reach his phone.'])!;
    expect(n.match(/<\/super-undelivered>/g)).toHaveLength(1);
  });

  it('a line nobody took within an hour is gone; listeners hear each note', () => {
    const heard: string[] = [];
    const off = onUndelivered((sid) => heard.push(sid));
    noteUndelivered('s', 'card', 'card C', 0);
    off();
    noteUndelivered('t', 'card', 'card D', 0);
    expect(heard).toEqual(['s']);
    expect(takeUndelivered('s', UNDELIVERED_KEEP_MS + 1)).toEqual([]);
  });

  it('the note forbids saying "sent" and asks for a re-send or where it is', () => {
    const n = undeliveredNote(['Your voice message did not reach his phone.'])!;
    expect(n).toMatch(/did NOT reach/);
    expect(n).toMatch(/Never say it was sent/);
    expect(undeliveredNote([])).toBeNull();
  });
});

describe('the senders note it', () => {
  it('a voice Telegram refused: its text goes to him, the Super hears that the voice did not', async () => {
    const hub = hubWith(async () => ({ ok: true, ogg: Buffer.from('OggS'), seconds: 3 }));
    expect(await hub.onAssistantText('s', VOICE, { turns: [], inputs: undefined, mark: OWNER_TURN })).toBe(true);
    const lines = takeUndelivered('s');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/voice message "Haftalık özet" did not reach his phone as a voice/);
  });

  it('a voice that could not be made says so too', async () => {
    const hub = hubWith(async () => ({ ok: false, reason: 'no_key' }));
    await hub.onAssistantText('s', VOICE, { turns: [], inputs: undefined, mark: OWNER_TURN });
    expect(takeUndelivered('s')[0]).toMatch(/no_key/);
  });

  it('an answer Telegram refused is noted', async () => {
    const hub = hubWith(async () => ({ ok: false, reason: 'nothing_speakable' }), true);
    expect(await hub.onAssistantText('s', '<!-- re:abc123 -->\nSürüm yayında.', { turns: [], inputs: undefined, mark: OWNER_TURN })).toBe(false);
    expect(takeUndelivered('s')[0]).toMatch(/did not reach his phone: Telegram refused/);
  });
});

describe('the Super hears it at its turn end', () => {
  it('the turn end carries the undelivered lines in the one hidden turn', () => {
    noteUndelivered('s', 'voice', 'Your voice message "Haftalık özet" did not reach his phone as a voice (no_key); its text went instead.');
    const t = new CardFeedbackTracker({ eventTurn: () => false, lang: () => 'Turkish', isOwnerProse, undelivered: () => takeUndelivered('s') });
    t.noteFrame({ type: 'assistant', parent_tool_use_id: null, message: { model: 'opus', content: [{ type: 'text', text: '<!-- re:abc123 -->\nSesli özeti gönderdim.' }] } });
    const note = t.atResult(true)!;
    expect(note.startsWith(`<${CARD_FEEDBACK_TAG}>`)).toBe(true);
    expect(note).toMatch(/Haftalık özet/);
    expect(note).toMatch(/Never say it was sent/);
  });

  it('a failure noted while a feedback turn ran is told at that turn\'s end, not left for his next turn', () => {
    const t = new CardFeedbackTracker({ eventTurn: () => false, lang: () => 'Turkish', isOwnerProse, undelivered: () => takeUndelivered('s') });
    t.noteFeedbackWritten();
    noteUndelivered('s', 'card', 'Your drawing "Plan" did not reach his phone.');
    t.noteFrame({ type: 'assistant', parent_tool_use_id: null, message: { model: 'opus', content: [{ type: 'text', text: 'Durumu yukarıda yazdım.' }] } });
    const note = t.atResult(true)!;
    expect(note).toMatch(/Plan/);
    expect(note).not.toMatch(/owner-text-gate/); // the answer to a feedback turn is never re-judged
    expect(t.atResult(true)).toBeNull();
  });
});
