/**
 * "Attach files…" puts a picture in the text like a paste does (owner 2026-10-28: the picked photo
 * still sat in the row above the whole prompt), and the sent bubble draws each picture where its
 * chip stood instead of the raw `[Picture N: <path>]` line the agent reads.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { isTokenRef, refToken } from '../../dashboard/src/components/sleepy/chat/composerRefs.js';
import {
  __resetScratchForTests, composeOutgoing, markInserted, pendingUploads, readScratch, stagePicked,
} from '../../dashboard/src/components/sleepy/chat/composerScratch.js';
import { splitPictureParts, splitUserMediaAndPictures } from '../../dashboard/src/components/sleepy/chat/chatEntities.js';
import { quotePath } from '../../dashboard/src/lib/agentComposer.js';

beforeEach(() => { __resetScratchForTests(); });

const copyTo = (dir: string) => async (p: string) => `${dir}/${p.split('/').pop()}`;
const preview = (p: string) => `/api/agent/file?path=${encodeURIComponent(p)}&raw=1`;

/** What the composer's effect does with pending chips: each token at the caret, in order. */
function insertPending(convId: string, draft: string): string {
  const pending = readScratch(convId).attachments.filter((a) => isTokenRef(a) && a.pending);
  markInserted(convId, pending.map((a) => a.id), Object.fromEntries(pending.map((a) => [a.id, a.name])));
  return draft + pending.map((a) => refToken({ ...a, chip: a.name })).join(' ');
}

describe('stagePicked — the + menu', () => {
  it('one picked picture is an inline, pending chip (the same shape a paste stages), copied into the drop folder', async () => {
    stagePicked('c', ['/Users/x/Desktop/shot.png'], 'file', copyTo('/vault/_dream_context/tmp/agent-drops'), preview);
    const [img] = readScratch('c').attachments;
    expect(img).toMatchObject({ kind: 'image', name: 'shot.png', inline: true, pending: true, uploading: true });
    expect(isTokenRef(img)).toBe(true);
    await Promise.all(pendingUploads('c'));
    const done = readScratch('c').attachments[0];
    expect(done).toMatchObject({ path: '/vault/_dream_context/tmp/agent-drops/shot.png', uploading: false, failed: false });
    expect(done.url).toBe(preview('/vault/_dream_context/tmp/agent-drops/shot.png'));
  });

  it('three pictures stay three chips in pick order; a PDF and a folder keep the path row', () => {
    stagePicked('c', ['/a/1.png', '/a/2.JPG', '/a/notes.pdf', '/a/3.webp'], 'file', () => new Promise(() => {}), preview);
    stagePicked('c', ['/a/dir'], 'folder', () => Promise.resolve('never'), preview);
    const atts = readScratch('c').attachments;
    expect(atts.filter((a) => a.inline).map((a) => a.name)).toEqual(['1.png', '2.JPG', '3.webp']);
    expect(atts.find((a) => a.name === 'notes.pdf')).toMatchObject({ kind: 'file', path: '/a/notes.pdf' });
    expect(atts.find((a) => a.name === 'notes.pdf')?.inline).toBeUndefined();
    expect(atts.find((a) => a.name === 'dir')).toMatchObject({ kind: 'folder', path: '/a/dir' });
  });

  it('a refused copy keeps the original path: the agent still gets the picture', async () => {
    stagePicked('c', ['/a/odd.png'], 'file', () => Promise.resolve(null), preview);
    await Promise.all(pendingUploads('c'));
    expect(readScratch('c').attachments[0]).toMatchObject({ path: '/a/odd.png', failed: false, uploading: false });
    expect(readScratch('c').attachments[0].url).toBeUndefined();
  });

  it('a send pairs each comment with the picture whose chip it follows', async () => {
    stagePicked('c', ['/a/1.png', '/a/2.png', '/a/3.png'], 'file', copyTo('/d'), preview);
    await Promise.all(pendingUploads('c'));
    const toks = readScratch('c').attachments.map((a) => refToken({ ...a, chip: a.name }));
    const draft = `look: ${toks[0]} too dark ${toks[1]} fine ${toks[2]} crop it`;
    const { message } = composeOutgoing(draft, readScratch('c').attachments, null, quotePath);
    expect(message).toBe('look:\n\n[Picture 1: /d/1.png]\ntoo dark\n\n[Picture 2: /d/2.png]\nfine\n\n[Picture 3: /d/3.png]\ncrop it');
  });

  it('a pending chip goes in at the caret like a pasted one', () => {
    stagePicked('c', ['/a/1.png'], 'file', () => new Promise(() => {}), preview);
    const draft = insertPending('c', 'before ');
    expect(draft.startsWith('before ')).toBe(true);
    expect(readScratch('c').attachments[0].pending).toBe(false);
  });
});

describe('a quote-reply of a message with a picture', () => {
  it('marks the quoted picture line, so it is quoted text, not this message\'s picture', async () => {
    stagePicked('c', ['/a/new.png'], 'file', copyTo('/d'), preview);
    await Promise.all(pendingUploads('c'));
    const tok = refToken({ ...readScratch('c').attachments[0], chip: 'new.png' });
    const quote = 'look:\n\n[Picture 1: /d/old.png]\ntoo dark';
    const { message } = composeOutgoing(`compress ${tok} please`, readScratch('c').attachments, quote, quotePath);
    expect(message).toBe('> look:\n\n> [Picture 1: /d/old.png]\ntoo dark\n\ncompress\n\n[Picture 1: /d/new.png]\nplease');
    expect(splitPictureParts(message)?.parts).toEqual([{ n: 1, path: '/d/new.png', words: 'please' }]);
  });
});

describe('the sent bubble reads the picture lines', () => {
  it('splits a sent message into its pictures, each with the words after it; the marker is gone', () => {
    const sent = 'look:\n\n[Picture 1: /d/1.png]\ntoo dark\n\n[Picture 2: /d/2.png]\nfine';
    expect(splitPictureParts(sent)).toEqual({
      preamble: 'look:',
      parts: [{ n: 1, path: '/d/1.png', words: 'too dark' }, { n: 2, path: '/d/2.png', words: 'fine' }],
    });
  });

  it('unquotes a path the composer quoted (spaces, an apostrophe)', () => {
    const p = "/Users/o/Desktop/Screen Shot it's.png";
    const sent = `[Picture 1: ${quotePath(p)}]\nhere`;
    expect(splitPictureParts(sent)?.parts[0]).toEqual({ n: 1, path: p, words: 'here' });
  });

  it('the owner\'s exact report: a picture then his words — no raw marker left to show', () => {
    const sent = '[Picture 1: /Users/m/brain/_dream_context/tmp/agent-drops/1793138805311-Screenshot_2026-10-28_at_01.06.43.png]\nbu şekilde attach files dediğimde';
    const r = splitPictureParts(sent);
    expect(r?.preamble).toBe('');
    expect(r?.parts).toHaveLength(1);
    expect(r?.parts[0].words).toBe('bu şekilde attach files dediğimde');
  });

  it('text with no picture line is left alone; a typed "[Picture" mid-line is not a marker', () => {
    expect(splitPictureParts('just words')).toBeNull();
    expect(splitPictureParts('see [Picture 1: /a.png] here')).toBeNull();
  });

  it('files folded before the first picture are still drawn as media; the picture lines stay for the bubble', () => {
    const sent = "intro /a/report.png\n\n[Picture 1: /d/1.png]\nwords";
    const r = splitUserMediaAndPictures(sent);
    expect(r.media).toEqual(['/a/report.png']);
    expect(r.text).toBe('intro\n\n[Picture 1: /d/1.png]\nwords');
    expect(splitUserMediaAndPictures('plain /a/x.png').media).toEqual(['/a/x.png']);
  });
});
