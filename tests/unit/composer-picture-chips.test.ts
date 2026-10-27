/**
 * A picture in the composer is a chip IN the text (owner 2026-10-27: "I write a separate comment
 * for each photo but it isn't understood"). It is the About chips' token (composerRefs.ts) with
 * its own glyph, so the caret, delete, paste and reconcile rules are the same ones; what is
 * pinned here is what is new: the staging, the token, the mirror's thumbnail run, and the wire,
 * where each picture's path stands right before the words he wrote after it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  GLYPH_IMAGE, deleteTokenAt, isTokenRef, parseRefTokens, reconcileRefs, refToken, sanitizePaste, stripTokens, tokensOnly,
} from '../../dashboard/src/components/sleepy/chat/composerRefs.js';
import {
  __resetScratchForTests, addAttachments, composeOutgoing, dropRefs, dropSentAttachments, markInserted, nextAttachmentId,
  pendingUploads, readScratch, restoreRefs, stageUpload, type Attachment,
} from '../../dashboard/src/components/sleepy/chat/composerScratch.js';
import { refMirrorSegments, refsInOrder } from '../../dashboard/src/components/sleepy/chat/ComposerRefLayer.js';

const q = (p: string) => (/\s/.test(p) ? `'${p}'` : p);
const pic = (name: string, path?: string): Attachment => ({ id: nextAttachmentId(), kind: 'image', name, inline: true, ...(path ? { path } : {}) });
const note = (id: string, line: string): Attachment => ({
  id: nextAttachmentId(), kind: 'about', name: line, text: `[About agenda line note=${id} section=now]\nline: ${JSON.stringify(line)}`,
});

beforeEach(() => { __resetScratchForTests(); });

describe('staging a picture', () => {
  it('a pasted or dropped image is staged inline and pending (the composer puts its chip at the caret); a file is not', () => {
    stageUpload('c', new File(['x'], 'shot.png', { type: 'image/png' }), () => new Promise(() => {}));
    stageUpload('c', new File(['x'], 'brief.pdf', { type: 'application/pdf' }), () => new Promise(() => {}));
    const [img, file] = readScratch('c').attachments;
    expect(img).toMatchObject({ kind: 'image', inline: true, pending: true, uploading: true });
    expect(isTokenRef(img)).toBe(true);
    expect(file.inline).toBeUndefined();
    expect(isTokenRef(file)).toBe(false);
    expect(pendingUploads('c')).toHaveLength(2);
    markInserted('c', [img.id], { [img.id]: 'shot.png' });
    expect(readScratch('c').attachments[0]).toMatchObject({ pending: false, chip: 'shot.png' });
  });
});

describe('the picture token', () => {
  it('opens with two EM SPACEs (blank in the box, the thumbnail room) and parses with its id', () => {
    const a = pic('shot.png');
    const t = refToken(a);
    expect(t.slice(1, 3)).toBe(GLYPH_IMAGE);
    const spans = parseRefTokens(`a ${t} b`);
    expect(spans).toHaveLength(1);
    expect(spans[0].glyph).toBe(GLYPH_IMAGE);
    expect(spans[0].label).toBe('shot.png');
    expect(stripTokens(`a ${t} b`)).toBe('a  b');
  });

  it('Backspace at its end takes it whole; reconcile drops a picture whose chip left the box', () => {
    const a = pic('shot.png', '/t/a.png');
    const draft = `${refToken(a)} looks off`;
    const del = deleteTokenAt(draft, refToken(a).length, 'backward');
    expect(del).toMatchObject({ draft: 'looks off', caret: 0, id: parseRefTokens(draft)[0].id });
    const r = reconcileRefs('looks off', [a]);
    expect(r.dropped).toEqual([a]);
    expect(reconcileRefs(draft, [a]).keep).toEqual([a]);
  });

  it('a token no staged picture claims becomes text, never a chip; a cut picture pastes back from recent', () => {
    const a = pic('shot.png', '/t/a.png');
    const t = refToken(a);
    expect(reconcileRefs(`x ${t}`, []).draft).toBe('x 🖼 shot.png');
    addAttachments('c', [a]);
    dropRefs('c', [a.id]);
    expect(readScratch('c').attachments).toHaveLength(0);
    expect(readScratch('c').recent?.[0].id).toBe(a.id);
    const sc = readScratch('c');
    const r = sanitizePaste(t, { draft: '', selStart: 0, selEnd: 0, staged: sc.attachments, recent: sc.recent ?? [] });
    expect(r.text).toBe(t);
    restoreRefs('c', r.restore);
    expect(readScratch('c').attachments[0]).toMatchObject({ id: a.id, kind: 'image', inline: true });
  });

  it('a slash command keeps only its chips; a peer message keeps only the About chips', () => {
    const a = pic('shot.png');
    const n = note('n1', 'line');
    const draft = `${refToken(n)} ${refToken(a)} /compact`;
    expect(parseRefTokens(tokensOnly(draft))).toHaveLength(2);
    expect(parseRefTokens(tokensOnly(draft, (s) => s.glyph !== GLYPH_IMAGE)).map((s) => s.glyph)).toEqual(['●']);
  });
});

describe('the wire: each picture, then the words written after it', () => {
  it("the owner's case: two pictures, one comment after each, paired in order", () => {
    const a = pic('one.png', '/v/tmp/agent-drops/1-one.png');
    const b = pic('two.png', '/v/tmp/agent-drops/2-two.png');
    const draft = `${refToken(a)} şu kısmı sevmedim\n${refToken(b)} buralara animasyon lazım`;
    const out = composeOutgoing(draft, [a, b], null, q);
    expect(out.message).toBe(
      '[Picture 1: /v/tmp/agent-drops/1-one.png]\nşu kısmı sevmedim\n\n[Picture 2: /v/tmp/agent-drops/2-two.png]\nburalara animasyon lazım',
    );
    expect(out.slash).toBe(false);
    expect(out.quoted.trim()).not.toBe('');
  });

  it('words before the first picture open the message; a file chip and the quote come first; a spaced path is quoted', () => {
    const a = pic('one.png', '/v/My Shots/1.png');
    const f: Attachment = { id: nextAttachmentId(), kind: 'file', name: 'spec.md', path: '/v/spec.md' };
    const out = composeOutgoing(`see these ${refToken(a)} too dark`, [f, a], 'earlier', q);
    expect(out.message).toBe("> earlier\n\nsee these /v/spec.md\n\n[Picture 1: '/v/My Shots/1.png']\ntoo dark");
  });

  it('a picture with nothing after it still goes; one that failed to attach sends no line, and N counts the sent ones', () => {
    const failed: Attachment = { ...pic('bad.heic'), failed: true };
    const a = pic('one.png', '/v/1.png');
    const out = composeOutgoing(`${refToken(failed)} broken ${refToken(a)}`, [failed, a], null, q);
    expect(out.message).toBe('broken\n\n[Picture 1: /v/1.png]');
  });

  it('works in the Super view beside an About chip, each keeping its own words', () => {
    const n = note('n7', 'Landing page');
    const a = pic('hero.png', '/v/hero.png');
    const out = composeOutgoing(`${refToken(n)} done? ${refToken(a)} the hero is cut`, [n, a], null, q, { superView: true });
    expect(out.message).toBe(`${n.text}\n\ndone?\n\n[Picture 1: /v/hero.png]\nthe hero is cut`);
  });

  it('a slash command carries no picture, and the pictures stay staged for the next message', () => {
    const a = pic('one.png', '/v/1.png');
    addAttachments('c', [a]);
    const out = composeOutgoing(`${refToken(a)} /compact`, [a], null, q);
    expect(out).toMatchObject({ message: '/compact', slash: true });
    dropSentAttachments('c', { keepAbout: true, keepInline: true });
    expect(readScratch('c').attachments).toHaveLength(1);
    dropSentAttachments('c');
    expect(readScratch('c').attachments).toHaveLength(0);
  });

  it('an image staged without a chip (not inline) folds as a path, exactly as before', () => {
    const legacy: Attachment = { id: nextAttachmentId(), kind: 'image', name: 'x.png', path: '/v/x.png' };
    expect(composeOutgoing('look', [legacy], null, q).message).toBe('look /v/x.png');
  });
});

describe('the mirror', () => {
  it('a picture run carries its preview, its thumbnail room and its state; About slots count About chips only', () => {
    const a: Attachment = { ...pic('one.png'), url: 'blob:one', uploading: true };
    const n = note('n1', 'line');
    const draft = `${refToken(a)} hi ${refToken(n)}`;
    const segs = refMirrorSegments(draft, [], [a, n]).filter((s) => s.kind === 'ref');
    expect(segs[0]).toMatchObject({ refId: a.id, img: 'blob:one', lead: 3, state: 'uploading' });
    expect(segs[0].text.slice(1, segs[0].lead)).toBe(GLYPH_IMAGE);
    expect(segs[1]).toMatchObject({ refId: n.id, slot: 1 });
    expect(refsInOrder(draft, [n, a]).map((x) => x.id)).toEqual([a.id, n.id]);
  });
});
