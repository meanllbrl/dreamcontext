/**
 * Unit tests for `inlineMediaKind` — what a file reference in an answer becomes in the
 * transcript. The classifier is what decides between an `<img>`, a `<video>`, an `<audio>`
 * and "leave it alone", so a wrong answer here is either a broken element or a link that
 * should have been a player.
 */
import { describe, it, expect } from 'vitest';
import { inlineMediaKind } from '../../dashboard/src/components/sleepy/chat/chatEntities.js';

describe('inlineMediaKind', () => {
  it('classifies the image types the file endpoint serves raw', () => {
    for (const p of ['a.png', 'a.jpg', 'a.jpeg', 'a.gif', 'a.webp']) {
      expect(inlineMediaKind(p)).toBe('image');
    }
  });

  it('classifies video — the case markdown has no syntax for, so it arrives as a link', () => {
    for (const p of ['clip.mp4', 'clip.m4v', 'clip.webm', 'screen.mov', 'x.ogv']) {
      expect(inlineMediaKind(p)).toBe('video');
    }
  });

  it('classifies audio', () => {
    for (const p of ['v.mp3', 'v.m4a', 'v.wav', 'v.oga', 'v.ogg', 'v.flac']) {
      expect(inlineMediaKind(p)).toBe('audio');
    }
  });

  it('is case-insensitive about the extension', () => {
    expect(inlineMediaKind('/tmp/Screenshot.PNG')).toBe('image');
    expect(inlineMediaKind('/tmp/CLIP.MP4')).toBe('video');
  });

  it('ignores a query string or fragment', () => {
    expect(inlineMediaKind('clip.mp4?t=10')).toBe('video');
    expect(inlineMediaKind('shot.png#top')).toBe('image');
  });

  it('leaves everything else alone — a code file or doc link must stay a link', () => {
    for (const p of ['notes.md', 'main.ts', 'report.pdf', 'archive.zip', 'Makefile']) {
      expect(inlineMediaKind(p)).toBeNull();
    }
  });

  it('never mistakes a FOLDER for media, even one whose name contains a dot', () => {
    expect(inlineMediaKind('_dream_context/tmp/agent-drops/')).toBeNull();
    expect(inlineMediaKind('/tmp/my.photos/')).toBeNull();
  });

  it('SVG is not inlined as media — it is served as text, never as an image', () => {
    expect(inlineMediaKind('icon.svg')).toBeNull();
  });
});
