/**
 * Unit tests for `splitUserMedia` — what a SENT chat message shows of itself.
 *
 * The composer can only hand the agent a picture as a path in the message text (the chat
 * protocol is text-only), so the transcript has to undo that for the human: draw the
 * attachment, and don't leave the path sitting in the bubble. The rules pinned here are the
 * narrow ones — an absolute or quoted path is an attachment, prose is never touched — because
 * this function rewrites what the user sees of their own words.
 */
import { describe, it, expect } from 'vitest';
import { splitUserMedia } from '../../dashboard/src/components/sleepy/chat/chatEntities.js';

const DROP = '/Users/me/projects/app/_dream_context/tmp/agent-drops';

describe('splitUserMedia', () => {
  it('lifts a trailing quoted attachment out of the text', () => {
    const raw = `what is wrong here '${DROP}/1785-CleanShot 2026-07-27 at 17.55.53@2x.png'`;
    expect(splitUserMedia(raw)).toEqual({
      text: 'what is wrong here',
      media: [`${DROP}/1785-CleanShot 2026-07-27 at 17.55.53@2x.png`],
    });
  });

  it('lifts a trailing bare absolute path (quotePath leaves simple paths unquoted)', () => {
    const raw = `read this ${DROP}/1785-shot.png`;
    expect(splitUserMedia(raw)).toEqual({ text: 'read this', media: [`${DROP}/1785-shot.png`] });
  });

  it('handles a paste-only message — no text, just the picture', () => {
    const raw = `${DROP}/1785-shot.png`;
    expect(splitUserMedia(raw)).toEqual({ text: '', media: [`${DROP}/1785-shot.png`] });
  });

  it('lifts a whole trailing run of attachments', () => {
    const raw = `compare these ${DROP}/a.png '${DROP}/b two.jpg' ${DROP}/c.webp`;
    expect(splitUserMedia(raw)).toEqual({
      text: 'compare these',
      media: [`${DROP}/a.png`, `${DROP}/b two.jpg`, `${DROP}/c.webp`],
    });
  });

  it('draws video and audio attachments too (markdown has no video syntax; this is a path)', () => {
    expect(splitUserMedia(`watch ${DROP}/demo.mp4`).media).toEqual([`${DROP}/demo.mp4`]);
    expect(splitUserMedia(`hear ${DROP}/note.m4a`).media).toEqual([`${DROP}/note.m4a`]);
  });

  it('leaves prose completely alone — a relative filename is NOT an attachment', () => {
    const raw = 'the failing test is in shot.png, look at check foo.png';
    expect(splitUserMedia(raw)).toEqual({ text: raw, media: [] });
  });

  it('leaves a trailing NON-media absolute path in the text (a file attachment stays readable)', () => {
    const raw = 'explain /Users/me/projects/app/src/index.ts';
    expect(splitUserMedia(raw)).toEqual({ text: raw, media: [] });
  });

  it('keeps a mid-sentence attachment in the text but still draws it', () => {
    const raw = `is ${DROP}/a.png the same as the mock?`;
    expect(splitUserMedia(raw)).toEqual({ text: raw, media: [`${DROP}/a.png`] });
  });

  it('returns an ordinary message untouched', () => {
    expect(splitUserMedia('run npm test and report failures')).toEqual({
      text: 'run npm test and report failures',
      media: [],
    });
    expect(splitUserMedia('')).toEqual({ text: '', media: [] });
  });

  it('de-duplicates a path attached twice and caps the strip at six', () => {
    const twice = `${DROP}/a.png ${DROP}/a.png`;
    expect(splitUserMedia(twice).media).toEqual([`${DROP}/a.png`]);

    const many = Array.from({ length: 9 }, (_, i) => `${DROP}/s${i}.png`).join(' ');
    const { media, text } = splitUserMedia(many);
    expect(media).toHaveLength(6);
    expect(text).toBe(''); // every token was an attachment — nothing left to read
  });

  it('preserves the newlines of a quoted reply above the attachment', () => {
    const raw = `> Claude said this\n\nand this? ${DROP}/a.png`;
    expect(splitUserMedia(raw)).toEqual({
      text: '> Claude said this\n\nand this?',
      media: [`${DROP}/a.png`],
    });
  });
});
