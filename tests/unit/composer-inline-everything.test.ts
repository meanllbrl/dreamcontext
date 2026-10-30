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
      [el.url, undefined, 4], [undefined, '📄', 4], [undefined, '📁', 4], [undefined, '📌', 4],
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

describe('the room around a chip (owner 2026-10-30, round 2)', () => {
  it('a no-break space on each side inside the token, drawn untinted beside the chip', () => {
    const el = element();
    const segs = refMirrorSegments(`a ${tok(el)} b`, [], [el]);
    const i = segs.findIndex((s) => s.kind === 'ref');
    expect(segs[i - 1]).toMatchObject({ kind: 'text', text: '\u2068\u00A0' });
    expect(segs[i + 1].kind).toBe('text');
    expect(segs[i + 1].text).toMatch(/^\u00A0[\u2061-\u2064]+\u2069$/);
    expect(segs[i].text.startsWith(GLYPH_IMAGE)).toBe(true);
  });

  it('a chip in the box opens the lines up; the measured height re-reads the line height', () => {
    const css = readFileSync(join(import.meta.dirname, '../../dashboard/src/components/sleepy/chat/composer.css'), 'utf8');
    const base = Number(/--chat-cmp-lh: ([\d.]+);/.exec(css)?.[1]);
    const withChips = Number(/\.chat-cmp\[data-chips\] \{ --chat-cmp-lh: ([\d.]+); \}/.exec(css)?.[1]);
    expect(withChips).toBeGreaterThan(base);
    const src = readFileSync(join(import.meta.dirname, '../../dashboard/src/components/sleepy/chat/Composer.tsx'), 'utf8');
    expect(src).toMatch(/data-chips=\{hlSegments\.some\(\(x\) => x\.kind === 'ref'\) \? '' : undefined\}/);
    expect(src).toMatch(/if \(chips !== prev\.chips\) \{\n\s+metricsRef\.current = null;/);
  });
});

describe('a chip never breaks across lines (round 2)', () => {
  it('its picture room is joined (no break opportunity inside a chip), and an older room still reads', () => {
    expect(GLYPH_IMAGE).toBe('\u2003\u2060\u2003\u2060');
    const el = element();
    const t = tok(el);
    const old = t.replace(GLYPH_IMAGE, '\u2003\u2003');
    expect(parseRefTokens(old)[0].glyph).toBe(GLYPH_IMAGE);
    expect(reconcileRefs(`a ${old} b`, [el]).draft).toBe(`a ${old} b`);
    // A damaged room (its FSI gone) still goes whole.
    const bare = `x ${t.slice(1)} y`;
    expect(reconcileRefs(bare, []).draft).toBe('x  y');
  });
});

describe('the mirror keeps the textarea metrics (round 2)', () => {
  it("global.css's pen padding on <mark> is cancelled for the mirror's chips and mentions", () => {
    const css = readFileSync(join(import.meta.dirname, '../../dashboard/src/components/sleepy/chat/composer.css'), 'utf8');
    expect(css).toMatch(/\.chat-cmp-hl :is\(\.chat-cmp-hl-ref, \.chat-cmp-hl-mention\) \{ padding-inline: 0; margin-inline: 0; \}/);
    const global = readFileSync(join(import.meta.dirname, '../../dashboard/src/styles/global.css'), 'utf8');
    // The rule it cancels: if the pen ever stops padding marks, this guard can go.
    expect(global).toMatch(/\nmark \{[\s\S]*?padding: 0 0\.22em;/);
  });
});

describe("the toolbar as the prototype draws it (owner 2026-10-30, r3)", () => {
  const src = readFileSync(join(import.meta.dirname, '../../dashboard/src/components/sleepy/chat/Composer.tsx'), 'utf8');
  const css = readFileSync(join(import.meta.dirname, '../../dashboard/src/components/sleepy/chat/composer.css'), 'utf8');
  it('no Sleepy glyph on the mode button, line chevrons, the + first, no resting voice caption', () => {
    expect(src).not.toMatch(/SleepyMascot/);
    expect(src).not.toMatch(/chat-cmp-caret" aria-hidden>▾/);
    expect(src.indexOf('<AttachButton onPick={stablePick} />')).toBeLessThan(src.indexOf('<ModeTrigger'));
    expect(src).toMatch(/&& voice\.state !== 'idle' && \(/);
    expect(src).toMatch(/`Hold to talk · \$\{hotkeyLabel\(pushToTalk\)\}`/);
    expect(src).toMatch(/className=\{`chat-cmp-iconbtn chat-cmp-mic/);
  });
  it("the prototype's sizes and radii", () => {
    expect(css).toMatch(/\.chat-cmp-modeltrigger \{[^}]*height: 30px;[^}]*border-radius: 8px;[^}]*font-size: 13px;/);
    expect(css).toMatch(/\.chat-cmp-iconbtn \{[^}]*width: 30px;[^}]*height: 30px;[^}]*border-radius: 8px;/);
    expect(css).toMatch(/\.chat-cmp-send \{[^}]*width: 32px;[^}]*height: 32px;[^}]*background: var\(--color-accent-strong\);/);
    expect(css).toMatch(/\.chat-cmp-card \{[^}]*border-radius: var\(--radius-2xl, 24px\);/);
    expect(css).toMatch(/\.chat-cmp-ic \{[^}]*width: 16px;[^}]*stroke-width: 1\.75;/);
  });
});
