/**
 * Nothing sits above the composer's text (owner 2026-10-30): everything he attaches — a picked
 * element from a web card, a file, a folder, a board item, a chat's ↩ — is a chip IN the text at
 * the caret, on the one token mechanism pictures and About lines already use, and the message
 * keeps each chip followed by the words he wrote after it. Only the Super dock's page context is
 * never a chip in the text (it is drawn in the toolbar).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GLYPH_IMAGE, GLYPH_REPLY, isChatReply, isMediaRef, isTokenRef, parseRefTokens, reconcileRefs, refKey, refToken,
} from '../../dashboard/src/components/sleepy/chat/composerRefs.js';
import {
  __resetScratchForTests, addAttachments, chatReplyRef, composeOutgoing, dropSentAttachments, insertRef, nextAttachmentId,
  readScratch, restoreRefs, stagePicked, stageRefs, stageUpload, type Attachment,
} from '../../dashboard/src/components/sleepy/chat/composerScratch.js';
import { refMirrorSegments } from '../../dashboard/src/components/sleepy/chat/ComposerRefLayer.js';

beforeEach(() => { __resetScratchForTests(); });

const q = (p: string) => (/\s/.test(p) ? `'${p}'` : p);
const BLOCK = '[Selected element on card @card:c1 “Site”]\npage: /projects\nselector: #hf\nelement: <button id="hf">';
const element = (over: Partial<Attachment> = {}): Attachment => ({
  id: nextAttachmentId(), kind: 'element', name: 'ProjectsPanel · “hf-sync”', text: BLOCK, url: 'data:image/png;base64,AA',
  inline: true, ...over,
});
const pic = (name: string, path?: string): Attachment => ({ id: nextAttachmentId(), kind: 'image', name, inline: true, ...(path ? { path } : {}) });
const tok = (a: Attachment) => refToken({ ...a, chip: a.name });

describe('which attachments are chips in the text', () => {
  it('every kind he attaches, inline; the page context never', () => {
    for (const kind of ['image', 'file', 'folder', 'element', 'ref'] as const) {
      expect(isTokenRef({ kind, inline: true })).toBe(true);
      expect(isMediaRef({ kind, inline: true })).toBe(true);
    }
    expect(isTokenRef({ kind: 'about' })).toBe(true);
    expect(isMediaRef({ kind: 'about' })).toBe(false);
    expect(isTokenRef({ kind: 'page', inline: true })).toBe(false);
  });

  it('a file, a folder, an element and a board item wear the picture room; a chat reply the ↩', () => {
    for (const kind of ['file', 'folder', 'element', 'ref'] as const) {
      const t = refToken({ id: nextAttachmentId(), kind, name: 'x' });
      expect(parseRefTokens(t)[0].glyph).toBe(GLYPH_IMAGE);
    }
    const reply = chatReplyRef('hello there', 'Claude:');
    expect(isChatReply(reply)).toBe(true);
    expect(parseRefTokens(refToken(reply))[0].glyph).toBe(GLYPH_REPLY);
  });
});

describe('staging — every door stages inline and pending (the composer puts the chip at the caret)', () => {
  it('a picked file and folder', () => {
    stagePicked('c', ['/a/notes.pdf'], 'file', async () => null, (p) => p);
    stagePicked('c', ['/a/dir'], 'folder', async () => null, (p) => p);
    expect(readScratch('c').attachments).toEqual([
      expect.objectContaining({ kind: 'file', path: '/a/notes.pdf', inline: true, pending: true }),
      expect.objectContaining({ kind: 'folder', path: '/a/dir', inline: true, pending: true }),
    ]);
  });

  it('a dropped non-picture file', () => {
    stageUpload('c', new File(['x'], 'brief.pdf', { type: 'application/pdf' }), () => new Promise(() => {}));
    expect(readScratch('c').attachments[0]).toMatchObject({ kind: 'file', inline: true, pending: true, uploading: true });
  });

  it('a web card element pick, a board drop and the phone files (source)', () => {
    const src = (f: string) => readFileSync(join(import.meta.dirname, '../../dashboard/src', f), 'utf8');
    expect(src('components/sleepy/AgentSurface.tsx')).toMatch(/kind: 'element'[\s\S]{0,400}inline: true, pending: true/);
    expect(src('components/whiteboard/canvasGestures.ts')).toMatch(/kind: 'ref', name: chipName\(unit, ctx\.tx\), path, inline: true, pending: true/);
    const composer = src('components/sleepy/chat/Composer.tsx');
    expect(composer.match(/kind: 'file', name, size: file\.size[^\n]*inline: true, pending: true/g)).toHaveLength(2);
    // The row above the text is gone: no attachment strip, no quote strip.
    expect(composer).not.toMatch(/className="chat-cmp-attachments"/);
    expect(composer).not.toMatch(/className="chat-cmp-quote"/);
  });

  it('a chat ↩ is a chip at the caret; the same message twice is one chip', () => {
    expect(insertRef('c', chatReplyRef('same', 'Claude:'))).toBe('added');
    expect(insertRef('c', chatReplyRef('same', 'Claude:'))).toBe('flash');
    expect(readScratch('c').attachments).toHaveLength(1);
    expect(refKey(readScratch('c').attachments[0])).toBe('quote:> same');
    const src = readFileSync(join(import.meta.dirname, '../../dashboard/src/components/sleepy/ChatPane.tsx'), 'utf8');
    expect(src).toMatch(/insertRef\(session\.scratchId \|\| convId, chatReplyRef\(item\.text, label\)\)/);
    expect(src).not.toMatch(/setQuote\(convId, item\.text\)/);
  });
});

describe('the message: each chip followed by the words written after it', () => {
  it('one element chip: its block, then his words', () => {
    const el = element({ path: '/d/element-button.png' });
    const { message } = composeOutgoing(`${tok(el)} make this wider`, [el], null, q, { superView: true });
    expect(message).toBe(`${BLOCK}\npicture: /d/element-button.png\n\nmake this wider`);
  });

  it('a picture and an element mixed: strictly in the order they stand', () => {
    const p = pic('shot.png', '/d/shot.png');
    const el = element({ path: '/d/el.png' });
    const draft = `look ${tok(p)} this is off ${tok(el)} and this button too`;
    const { message } = composeOutgoing(draft, [p, el], null, q, { superView: true });
    expect(message).toBe(`look\n\n[Picture 1: /d/shot.png]\nthis is off\n\n${BLOCK}\npicture: /d/el.png\n\nand this button too`);
  });

  it('a file, a folder and a board item: each its path line, then his words', () => {
    const f: Attachment = { id: nextAttachmentId(), kind: 'file', name: 'a b.pdf', path: '/x/a b.pdf', inline: true };
    const d: Attachment = { id: nextAttachmentId(), kind: 'folder', name: 'dir', path: '/x/dir', inline: true };
    const r: Attachment = { id: nextAttachmentId(), kind: 'ref', name: 'Note', path: 'dcref:wb/q3/n1', inline: true };
    const draft = `${tok(f)} read it ${tok(d)} and this ${tok(r)} and the note`;
    expect(composeOutgoing(draft, [f, d, r], null, q).message)
      .toBe("'/x/a b.pdf'\nread it\n\n/x/dir\nand this\n\ndcref:wb/q3/n1\nand the note");
  });

  it('an element with no picture goes out as its block; a file that failed to attach leaves only the words', () => {
    const el = element({ url: undefined });
    const bad: Attachment = { id: nextAttachmentId(), kind: 'file', name: 'big.zip', failed: true, inline: true };
    const { message } = composeOutgoing(`${tok(el)} why ${tok(bad)} and this`, [el, bad], null, q);
    expect(message).toBe(`${BLOCK}\n\nwhy\n\nand this`);
  });

  it("a chat reply chip with his words after it is today's quote bytes exactly", () => {
    const reply = chatReplyRef('line one\nline two', 'Claude:');
    const legacy = composeOutgoing('sounds right', [], 'line one\nline two', q).message;
    expect(composeOutgoing(`${tok(reply)} sounds right`, [reply], null, q).message).toBe(legacy);
    expect(legacy).toBe('> line one\nline two\n\nsounds right');
  });
});

describe('a chat ↩ addressed to a peer (review finding)', () => {
  it("the quote is part of `quoted` (what a peer gets), as it was in the strip; a Super About block is not", () => {
    const reply = chatReplyRef('the plan', 'Claude:');
    const one = composeOutgoing(`${tok(reply)} @acme-pay do X`, [reply], null, q);
    expect(one.quoted).toBe('> the plan\n\n@acme-pay do X');
    const p = pic('a.png', '/d/a.png');
    const mixed = composeOutgoing(`${tok(reply)} @acme-pay do X ${tok(p)} see`, [reply, p], null, q);
    expect(mixed.quoted).toBe('> the plan\n\n@acme-pay do X\n\n[Picture 1: /d/a.png]\nsee');
    const about: Attachment = { id: nextAttachmentId(), kind: 'about', name: 'n', text: '[About agenda line note=n1 section=now]\nline: "x"' };
    expect(composeOutgoing(`${tok(about)} do Y`, [about], null, q, { superView: true }).quoted).toBe('do Y');
  });

  it('the peer branch carries the ↩ away and keeps the chips that were not sent (source)', () => {
    const src = readFileSync(join(import.meta.dirname, '../../dashboard/src/components/sleepy/chat/Composer.tsx'), 'utf8');
    expect(src).toMatch(/const keptAbout = tokensOnly\(text, \(s\) => \(s\.glyph !== GLYPH_IMAGE && !replyIds\.has\(s\.id\)\) \|\| unsent\.has\(s\.id\)\);/);
    expect(src).toMatch(/dropSentAttachments\(convId, \{ keepAbout: true \}\);\n\s+replies\.forEach\(\(a\) => removeAttachment\(convId, a\.id\)\);/);
  });
});

describe('after a send, and when the draft is replaced', () => {
  it('a sent chip leaves; a failed one stays staged (its chip stays in the box)', () => {
    addAttachments('c', [
      { id: 'att-1', kind: 'file', name: 'ok.pdf', path: '/x/ok.pdf', inline: true },
      { id: 'att-2', kind: 'file', name: 'bad.zip', failed: true, inline: true },
      element({ id: 'att-3' }),
    ]);
    dropSentAttachments('c');
    expect(readScratch('c').attachments.map((a) => a.id)).toEqual(['att-2']);
  });

  it('a slash command keeps every inline chip for the next message', () => {
    addAttachments('c', [{ id: 'att-1', kind: 'file', name: 'ok.pdf', path: '/x/ok.pdf', inline: true }, element({ id: 'att-2' })]);
    dropSentAttachments('c', { keepInline: true });
    expect(readScratch('c').attachments).toHaveLength(2);
  });

  it('a replaced draft puts an element chip back (pending) instead of losing it; a paste restores its kind', () => {
    const el = element();
    addAttachments('c', [el]);
    stageRefs('c', [], 'no chips here');
    expect(readScratch('c').attachments[0]).toMatchObject({ kind: 'element', pending: true });
    restoreRefs('d', [{ ...el, pending: false }]);
    expect(readScratch('d').attachments[0].kind).toBe('element');
  });

  it('reconcile keeps a token whose element is staged, and turns a stranger into text', () => {
    const el = element();
    const draft = `a ${tok(el)} b`;
    expect(reconcileRefs(draft, [el]).draft).toBe(draft);
    expect(reconcileRefs(draft, []).draft).not.toContain('⁨');
  });
});

describe('the mirror draws each chip in the picture room', () => {
  it('an element with its picture as a thumbnail; a file, a folder and a board item with their icon', () => {
    const el = element();
    const f: Attachment = { id: nextAttachmentId(), kind: 'file', name: 'a.pdf', inline: true };
    const d: Attachment = { id: nextAttachmentId(), kind: 'folder', name: 'dir', inline: true };
    const r: Attachment = { id: nextAttachmentId(), kind: 'ref', name: 'Note', inline: true };
    const segs = refMirrorSegments(`${tok(el)} x ${tok(f)} ${tok(d)} ${tok(r)}`, [], [el, f, d, r]).filter((s) => s.kind === 'ref');
    expect(segs.map((s) => [s.img, s.icon, s.lead])).toEqual([
      [el.url, undefined, 3], [undefined, '📄', 3], [undefined, '📁', 3], [undefined, '📌', 3],
    ]);
  });
});

describe('the field type (owner 2026-10-30: chips between the lines, never touching)', () => {
  const css = readFileSync(join(import.meta.dirname, '../../dashboard/src/components/sleepy/chat/composer.css'), 'utf8');
  const rule = (sel: string) => new RegExp(`\\n${sel.replace(/[.]/g, '\\.')} \\{([^}]*)\\}`).exec(css)?.[1] ?? '';
  it('the textarea and its mirror read ONE line height and size, roomier than 1.45', () => {
    const lh = Number(/--chat-cmp-lh: ([\d.]+);/.exec(css)?.[1]);
    expect(lh).toBeGreaterThanOrEqual(1.6);
    for (const sel of ['.chat-cmp-input', '.chat-cmp-hl']) {
      expect(rule(sel)).toMatch(/font-size: var\(--chat-cmp-fs\);/);
      expect(rule(sel)).toMatch(/line-height: var\(--chat-cmp-lh\);/);
    }
    expect(css).toMatch(/--chat-cmp-min-h: calc\(2 \* var\(--chat-cmp-lh\) \* var\(--chat-cmp-fs\) \+ 16px\);/);
  });
});
