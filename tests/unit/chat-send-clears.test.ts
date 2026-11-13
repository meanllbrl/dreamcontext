/**
 * A sent message leaves the composer, and an answer's `ask` button works on a parked chat
 * (owner, 2026-11-12: "the message goes and STAYS in the box; the quick-answer button cannot be
 * pressed"). End to end: scripts/verify/chat-send-clears.mjs §6.
 *
 * Two causes, both on a PARKED chat (an idle tab stopped under load, drawn by ParkedChat on a
 * transcript-only session):
 *  1. Its first message wakes it: the same commit swaps the parked composer for the live
 *     chat's, so the parked one's mirror effect never ran to clear the kept draft
 *     (composerDrafts.ts) and the live composer restored the message just sent.
 *  2. The transcript session's `sendText` was a no-op, so `ask` filled nothing.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createTranscriptSession } from '../../dashboard/src/components/sleepy/transcriptSession';
import { __resetDraftsForTests, persistDraft, readDraft } from '../../dashboard/src/components/sleepy/chat/composerDrafts';

const fakeContainer = () => ({ className: 'agent-pane-chat', parentElement: null }) as unknown as HTMLDivElement;
const CONV = '4bbd2150-622a-40f1-b185-a0bb1512a771';

describe("a parked chat's composer has a real draft", () => {
  it('`sendText` (an ask button) appends, bumps the epoch the composer adopts on, and notifies', () => {
    const s = createTranscriptSession(CONV, fakeContainer);
    let fired = 0;
    s.subscribe(() => { fired++; });
    s.syncDraft('typed ');
    s.sendText('fix it and send the note');
    const m = s.getModel();
    expect(m.draft).toBe('typed fix it and send the note');
    expect(m.draftEpoch).toBe(1);
    expect(m.draftEpochReason).toBe('external');
    expect(fired).toBe(1);
  });

  it('`focus` reaches the registered textarea', () => {
    const s = createTranscriptSession(CONV, fakeContainer);
    let focused = 0;
    s.setFocusTarget({ focus: () => { focused++; } } as unknown as HTMLElement);
    s.focus();
    expect(focused).toBe(1);
  });

  it('still delivers nothing by itself: a parked message goes through the wake, not here', () => {
    const s = createTranscriptSession(CONV, fakeContainer);
    expect(s.send('x')).toBe(false);
    expect(s.steer('x')).toBe(false);
  });
});

describe('a send clears the kept draft at once, not in an effect', () => {
  beforeEach(() => __resetDraftsForTests());

  it('the kept record is gone the moment the box is written empty', () => {
    persistDraft('proj', CONV, { text: 'contra fix, send the note', attachments: [], quote: null });
    expect(readDraft('proj', CONV)?.text).toBe('contra fix, send the note');
    persistDraft('proj', CONV, { text: '', attachments: [], quote: null });
    expect(readDraft('proj', CONV)).toBeNull();
  });

  it("the composer's `sent()` writes the kept draft itself, beside clearing the box", () => {
    const src = readFileSync('dashboard/src/components/sleepy/chat/Composer.tsx', 'utf-8');
    const sent = src.slice(src.indexOf('const sent = () => {'), src.indexOf('if (sendVia) {'));
    expect(sent).toContain('setDraft(left);');
    expect(sent).toMatch(/persistDraft\(vault, convId, \{ text: left,/);
  });
});
