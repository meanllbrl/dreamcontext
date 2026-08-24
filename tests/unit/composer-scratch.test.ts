/**
 * The composer's STAGED state — attachment chips and the reply quote — keyed by conversation
 * so a respawn cannot eat it.
 *
 * The bug this closes is the other half of the draft loss: switching mode, or moving permission
 * to Bypass (which CLI 2.1.220 refuses to apply live), respawns the process and unmounts the
 * pane. The draft is carried onto the incoming session; the chips and the quote could not be
 * carried the same way, because a chip's image preview is an object URL the composer owned and
 * REVOKED ON UNMOUNT — a copy would have arrived holding a dead URL. So they moved to a store
 * keyed by the conversation id, which no respawn changes.
 *
 * Two things are asserted here that no amount of reading catches:
 *   1. the LIFETIME rules (what is revoked, and — more important — what is NOT), and
 *   2. that an upload settling AFTER the respawn still lands on its chip, which is the reason
 *      this is conversation-scoped rather than session-scoped.
 *
 * `composerScratch.ts` is deliberately React-free so root vitest's plain-Node environment can
 * load it directly — the same trick `chat-mode-mirror.test.ts` uses on `chatModes.ts`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  __resetScratchForTests, addAttachments, dropScratch, dropSentAttachments, nextAttachmentId,
  readScratch, removeAttachment, settleAttachment, setQuote, subscribeScratch,
  type Attachment,
} from '../../dashboard/src/components/sleepy/chat/composerScratch.js';

const CONV = 'conv-aaaa';
const OTHER = 'conv-bbbb';

/** Every object URL the store released, in order. */
let revoked: string[] = [];

beforeEach(() => {
  __resetScratchForTests();
  revoked = [];
  // Node has no DOM object-URL registry; the store's job is to CALL this exactly once per
  // entry that leaves, which a spy is the only way to observe.
  vi.stubGlobal('URL', {
    ...URL,
    revokeObjectURL: (u: string) => { revoked.push(u); },
  });
});

const image = (url: string, over: Partial<Attachment> = {}): Attachment => ({
  id: nextAttachmentId(), kind: 'image', name: 'Pasted image', url, uploading: true, ...over,
});
const file = (path: string): Attachment => ({
  id: nextAttachmentId(), kind: 'file', name: path.split('/').pop() ?? path, path,
});

describe('composerScratch — staging', () => {
  it('reads empty for a conversation nothing was staged against', () => {
    expect(readScratch(CONV)).toEqual({ attachments: [], quote: null });
  });

  it('keeps conversations apart', () => {
    addAttachments(CONV, [file('/a/one.ts')]);
    setQuote(OTHER, 'the other conversation');
    expect(readScratch(CONV).attachments).toHaveLength(1);
    expect(readScratch(CONV).quote).toBeNull();
    expect(readScratch(OTHER).attachments).toHaveLength(0);
    expect(readScratch(OTHER).quote).toBe('the other conversation');
  });

  it('never reuses an attachment id, even across a remount', () => {
    // The ids used to come from a per-component ref that restarted at 1 on every mount, so the
    // first chip attached after a respawn collided with one staged before it — and then
    // removing either hit the wrong chip.
    const before = [nextAttachmentId(), nextAttachmentId()];
    const after = [nextAttachmentId(), nextAttachmentId()];
    expect(new Set([...before, ...after]).size).toBe(4);
  });
});

describe('composerScratch — the respawn', () => {
  it('survives a pane remount with nothing revoked', () => {
    addAttachments(CONV, [image('blob:pic-1', { uploading: false, path: '/tmp/pic-1.png' }), file('/a/one.ts')]);
    setQuote(CONV, 'the message being replied to');

    // A respawn is exactly this: the pane goes away, the CONVERSATION id does not. There is no
    // unmount hook to fire any more — that is the fix — so the only thing to assert is that
    // reading the same key still yields everything, and that nothing was released.
    const after = readScratch(CONV);
    expect(after.attachments.map((a) => a.name)).toEqual(['Pasted image', 'one.ts']);
    expect(after.quote).toBe('the message being replied to');
    expect(revoked, 'a respawn must not revoke a preview the user can still see').toEqual([]);
  });

  it('lands an upload that settles AFTER the respawn, and tells the new pane', () => {
    const chip = image('blob:pic-2');
    addAttachments(CONV, [chip]);
    expect(readScratch(CONV).attachments[0].uploading).toBe(true);

    // The pane that pasted it is gone; the one that replaced it subscribes.
    const seen: Array<Attachment[]> = [];
    subscribeScratch(CONV, (s) => seen.push(s.attachments));

    settleAttachment(CONV, chip.id, '/tmp/dc/pic-2.png');

    const now = readScratch(CONV).attachments[0];
    expect(now.uploading).toBe(false);
    expect(now.path).toBe('/tmp/dc/pic-2.png');
    expect(now.failed).toBeFalsy();
    expect(seen, 'the replacement pane is not notified, so its chip would sit "uploading…"')
      .toHaveLength(1);
    expect(seen[0][0].path).toBe('/tmp/dc/pic-2.png');
  });

  it('marks a refused upload failed rather than dropping the chip', () => {
    const chip = image('blob:pic-3');
    addAttachments(CONV, [chip]);
    settleAttachment(CONV, chip.id, null);
    const now = readScratch(CONV).attachments[0];
    expect(now.failed).toBe(true);
    expect(now.uploading).toBe(false);
    expect(now.path).toBeUndefined();
  });

  it('does not resurrect a chip the user removed while its bytes were in flight', () => {
    const chip = image('blob:pic-4');
    addAttachments(CONV, [chip]);
    removeAttachment(CONV, chip.id);
    settleAttachment(CONV, chip.id, '/tmp/dc/pic-4.png');
    expect(readScratch(CONV).attachments).toEqual([]);
  });
});

describe('composerScratch — lifetimes', () => {
  it('revokes exactly the removed chip, and only an image', () => {
    const pic = image('blob:pic-5');
    const doc = file('/a/two.ts');
    addAttachments(CONV, [pic, doc]);
    removeAttachment(CONV, doc.id);
    expect(revoked, 'a file chip has no object URL to release').toEqual([]);
    removeAttachment(CONV, pic.id);
    expect(revoked).toEqual(['blob:pic-5']);
  });

  it('on send, drops what HAD A PATH and keeps what did not — including an in-flight chip', () => {
    // The composer's old rule was "keep the failed ones". It agrees with this one for a settled
    // chip and disagrees in exactly the case the store exists for: a chip pasted just before a
    // respawn is `uploading`, with no path and no `failed` flag, and the old rule dropped it as
    // though it had been sent.
    const sent = image('blob:sent', { uploading: false, path: '/tmp/dc/sent.png' });
    const inFlight = image('blob:inflight');
    const refused = image('blob:refused', { uploading: false, failed: true });
    addAttachments(CONV, [sent, inFlight, refused, file('/a/three.ts')]);
    setQuote(CONV, 'quoted');

    dropSentAttachments(CONV);

    const left = readScratch(CONV).attachments.map((a) => a.id);
    expect(left).toEqual([inFlight.id, refused.id]);
    expect(revoked, 'only the previews that went with the message').toEqual(['blob:sent']);
    expect(readScratch(CONV).quote, 'a send consumes the quote').toBeNull();
  });

  it('releases everything when the CONVERSATION closes, and says so to subscribers', () => {
    addAttachments(CONV, [image('blob:x'), image('blob:y'), file('/a/four.ts')]);
    setQuote(CONV, 'gone too');
    const seen: Array<{ n: number; quote: string | null }> = [];
    subscribeScratch(CONV, (s) => seen.push({ n: s.attachments.length, quote: s.quote }));

    dropScratch(CONV);

    expect(revoked).toEqual(['blob:x', 'blob:y']);
    expect(readScratch(CONV)).toEqual({ attachments: [], quote: null });
    expect(seen).toEqual([{ n: 0, quote: null }]);
  });

  it('stops delivering after unsubscribe', () => {
    let hits = 0;
    const off = subscribeScratch(CONV, () => { hits++; });
    setQuote(CONV, 'one');
    off();
    setQuote(CONV, 'two');
    expect(hits).toBe(1);
    expect(readScratch(CONV).quote).toBe('two');
  });

  it('forgets a conversation that has nothing staged, rather than holding an empty record', () => {
    const pic = image('blob:z');
    addAttachments(CONV, [pic]);
    setQuote(CONV, 'q');
    setQuote(CONV, null);
    removeAttachment(CONV, pic.id);
    // Observable through the shared empty: an emptied conversation reads identically to one
    // never touched, so a long session cannot accumulate a record per finished conversation.
    expect(readScratch(CONV)).toBe(readScratch('never-seen-this-one'));
  });
});

// ─── Source guards: the properties that live in code that ISN'T there ──────────────────

const ROOT = new URL('../../', import.meta.url).pathname;
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const code = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const COMPOSER = 'dashboard/src/components/sleepy/chat/Composer.tsx';
const PANE = 'dashboard/src/components/sleepy/ChatPane.tsx';
const SURFACE = 'dashboard/src/components/sleepy/AgentSurface.tsx';

describe('composerScratch — the wiring nobody can see at the call site', () => {
  it('the composer no longer revokes an object URL on unmount', () => {
    // This single line was the bug: an unmount is not evidence that the user is done with a
    // chip, because a respawn unmounts a pane whose chips are still wanted. Creating the URL
    // stays here (the paste handler has the File); releasing it belongs to the store.
    const src = code(read(COMPOSER));
    expect(src).toContain('URL.createObjectURL');
    expect(src, 'releasing a preview is composerScratch\'s job now').not.toContain('revokeObjectURL');
  });

  it('the composer stages against the conversation id, not its own state', () => {
    const src = code(read(COMPOSER));
    expect(src).toContain('session.claudeId');
    expect(src).toContain('readScratch(convId)');
    expect(src).toContain('subscribeScratch(convId');
    // The ref/state duality is gone with it: `submit` reads the store, which cannot be a
    // render behind, so there is no second copy to keep in sync.
    expect(src).not.toContain('attachmentsRef');
    expect(src, 'ids come from the store now — a per-component counter collides after a remount')
      .not.toContain('attSeqRef');
  });

  it('the pane reads its reply quote from the store', () => {
    const src = code(read(PANE));
    expect(src).toContain('readScratch(convId).quote');
    expect(src).toContain('setQuote(convId');
    expect(src, 'the quote is SEEDED from the store, not from null')
      .toContain('useState<string | null>(() => readScratch(convId).quote)');
    // `setReplyQuote` survives only as the subscription's sink. A direct write would put the
    // rendered value and the stored one on separate tracks, and the stored one is the one a
    // respawn reads.
    expect(src).not.toContain('setReplyQuote(null)');
    expect(src).not.toContain('setReplyQuote(text)');
  });

  it('is dropped ONLY where a conversation ends for good', () => {
    const src = code(read(SURFACE));
    const calls = src.split('dropScratch(').length - 1;
    expect(calls, 'exactly one call site: closeSessionById, beside clearPins').toBe(1);
    // Anchored on the pins sweep, which carries the argument for why this is the only path:
    // every respawn swaps the tab id in place without coming through here.
    const at = src.indexOf('dropScratch(');
    const window = src.slice(Math.max(0, at - 900), at);
    expect(window).toContain('clearPins(');
    expect(window).toContain('closeSessionById');
  });
});
