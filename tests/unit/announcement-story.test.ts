import { describe, it, expect } from 'vitest';
import {
  parseAnnouncementStory,
  storyAssetUrl,
  storyCoverShot,
  ANNOUNCEMENT_ASSET_ROOT,
} from '../../dashboard/src/lib/announcementStory.js';

/**
 * Unit tests for the announcement STORY document — the screenshot-driven landing
 * page that replaced the Excalidraw board format in 0.22.
 *
 * The contract these lock down: a story is hand-authored JSON shipped as a static
 * asset, so a typo must degrade, never explode. One malformed block is dropped
 * and the rest of the page still renders; only a missing headline kills the whole
 * document (there is nothing left to show). Asset paths are confined to the
 * announcements asset root, so a story can never point the reader at a remote
 * image or walk out of the public directory.
 */

const shot = (over: Record<string, unknown> = {}) => ({ src: 'shots/x/hero.png', alt: 'A screenshot', ...over });
const clip = (over: Record<string, unknown> = {}) => ({
  src: 'clips/x/demo.mp4',
  poster: 'clips/x/demo.png',
  alt: 'A clip of the app',
  ...over,
});

describe('storyAssetUrl', () => {
  it('resolves a relative path under the announcements asset root', () => {
    expect(storyAssetUrl('shots/x/hero.png')).toBe(`${ANNOUNCEMENT_ASSET_ROOT}shots/x/hero.png`);
  });

  it.each([
    ['absolute path', '/etc/passwd'],
    ['windows-ish path', '\\\\server\\share'],
    ['http url', 'http://evil.example/x.png'],
    ['protocol-relative url', '//evil.example/x.png'],
    ['data url', 'data:image/png;base64,AAAA'],
    ['parent traversal', '../../secrets/x.png'],
    ['traversal mid-path', 'shots/../../x.png'],
    ['empty', ''],
    ['blank', '   '],
  ])('rejects %s', (_label, src) => {
    expect(storyAssetUrl(src)).toBeNull();
  });
});

describe('parseAnnouncementStory', () => {
  it('returns null when there is no headline (nothing left to render)', () => {
    expect(parseAnnouncementStory({})).toBeNull();
    expect(parseAnnouncementStory({ hero: {} })).toBeNull();
    expect(parseAnnouncementStory({ hero: { headline: '  ' } })).toBeNull();
    expect(parseAnnouncementStory(null)).toBeNull();
    expect(parseAnnouncementStory('<!doctype html>')).toBeNull();
    expect(parseAnnouncementStory(42)).toBeNull();
  });

  it('parses a headline-only story (copy carries it, no screenshots needed)', () => {
    const story = parseAnnouncementStory({ hero: { headline: 'Ship it' } });
    expect(story).toEqual({ hero: { headline: 'Ship it' }, blocks: [] });
  });

  it('keeps hero eyebrow / sub / shot when well-formed', () => {
    const story = parseAnnouncementStory({
      hero: { eyebrow: 'v0.22.0', headline: 'Ship it', sub: 'The promise.', shot: shot({ caption: 'Cap' }) },
    });
    expect(story?.hero.eyebrow).toBe('v0.22.0');
    expect(story?.hero.sub).toBe('The promise.');
    expect(story?.hero.shot).toEqual({ src: 'shots/x/hero.png', alt: 'A screenshot', caption: 'Cap' });
  });

  it('drops a hero shot with no alt text rather than shipping an unlabelled image', () => {
    const story = parseAnnouncementStory({ hero: { headline: 'H', shot: { src: 'shots/x/hero.png' } } });
    expect(story?.hero.shot).toBeUndefined();
  });

  it('drops a hero shot whose src escapes the asset root', () => {
    const story = parseAnnouncementStory({
      hero: { headline: 'H', shot: { src: 'https://evil.example/x.png', alt: 'A' } },
    });
    expect(story?.hero.shot).toBeUndefined();
  });

  it('parses every block kind', () => {
    const story = parseAnnouncementStory({
      hero: { headline: 'H' },
      blocks: [
        { kind: 'stats', items: [{ value: '3×', label: 'Faster', note: 'measured' }] },
        { kind: 'split', title: 'T', body: 'B', shot: shot(), side: 'left' },
        { kind: 'shot', shot: shot(), title: 'T', body: 'B' },
        { kind: 'points', title: 'P', items: [{ title: 'a', text: 'b' }] },
        { kind: 'terminal', title: 'CLI', lines: ['$ run', 'done'] },
        { kind: 'note', text: 'The punchline.' },
      ],
    });
    expect(story?.blocks.map((b) => b.kind)).toEqual(['stats', 'split', 'shot', 'points', 'terminal', 'note']);
  });

  it('defaults a split to a right-hand shot and honours an explicit left', () => {
    const story = parseAnnouncementStory({
      hero: { headline: 'H' },
      blocks: [
        { kind: 'split', title: 'T', body: 'B', shot: shot() },
        { kind: 'split', title: 'T', body: 'B', shot: shot(), side: 'left' },
        { kind: 'split', title: 'T', body: 'B', shot: shot(), side: 'sideways' },
      ],
    });
    expect(story?.blocks.map((b) => (b as { side?: string }).side)).toEqual(['right', 'left', 'right']);
  });

  it('drops ONE malformed block and keeps the rest of the page', () => {
    const story = parseAnnouncementStory({
      hero: { headline: 'H' },
      blocks: [
        { kind: 'note', text: 'first' },
        { kind: 'split', title: 'no body or shot' },     // incomplete → dropped
        { kind: 'wormhole', text: 'unknown kind' },       // unknown → dropped
        { kind: 'stats', items: [] },                      // empty → dropped
        { kind: 'terminal', lines: [] },                   // empty → dropped
        'not an object',
        null,
        { kind: 'note', text: 'last' },
      ],
    });
    expect(story?.blocks).toEqual([{ kind: 'note', text: 'first' }, { kind: 'note', text: 'last' }]);
  });

  it('drops only the malformed ITEMS inside a block that still has content', () => {
    const story = parseAnnouncementStory({
      hero: { headline: 'H' },
      blocks: [{ kind: 'points', items: [{ title: 'a', text: 'b' }, { title: 'no text' }, 7] }],
    });
    expect(story?.blocks[0]).toEqual({ kind: 'points', items: [{ title: 'a', text: 'b' }] });
  });

  it('keeps a closer only when it has both a title and a body', () => {
    const withCloser = parseAnnouncementStory({ hero: { headline: 'H' }, closer: { title: 'T', body: 'B' } });
    expect(withCloser?.closer).toEqual({ title: 'T', body: 'B' });
    expect(parseAnnouncementStory({ hero: { headline: 'H' }, closer: { title: 'T' } })?.closer).toBeUndefined();
    expect(parseAnnouncementStory({ hero: { headline: 'H' }, closer: 'soon' })?.closer).toBeUndefined();
  });

  it('never throws on hostile input', () => {
    for (const input of [undefined, [], { hero: [] }, { hero: { headline: 'H' }, blocks: 'nope' }]) {
      expect(() => parseAnnouncementStory(input)).not.toThrow();
    }
    expect(parseAnnouncementStory({ hero: { headline: 'H' }, blocks: 'nope' })?.blocks).toEqual([]);
  });
});

/**
 * Clips carry one requirement a shot doesn't: a poster. Three surfaces render a
 * story as a still image (the feed teaser, the popup, the frame before the bytes
 * arrive), and none of them can run a video — so a clip with no poster is a hole
 * in all three and is dropped at parse time.
 */
describe('parseAnnouncementStory — video blocks', () => {
  it('parses a video block with its clip', () => {
    const story = parseAnnouncementStory({
      hero: { headline: 'H' },
      blocks: [{ kind: 'video', title: 'T', body: 'B', clip: clip({ caption: 'C', frame: 'plain', sound: true }) }],
    });
    expect(story?.blocks).toEqual([
      {
        kind: 'video',
        title: 'T',
        body: 'B',
        clip: { src: 'clips/x/demo.mp4', poster: 'clips/x/demo.png', alt: 'A clip of the app', caption: 'C', frame: 'plain', sound: true },
      },
    ]);
  });

  it('defaults to a silent looping clip (sound is opt-in)', () => {
    const story = parseAnnouncementStory({ hero: { headline: 'H' }, blocks: [{ kind: 'video', clip: clip() }] });
    expect(story?.blocks[0]).toMatchObject({ kind: 'video' });
    expect((story?.blocks[0] as { clip: { sound?: boolean } }).clip.sound).toBeUndefined();
  });

  it.each([
    ['no poster', { poster: undefined }],
    ['blank poster', { poster: '  ' }],
    ['no alt', { alt: undefined }],
    ['a src that escapes the asset root', { src: 'https://evil.example/x.mp4' }],
    ['a poster that escapes the asset root', { poster: '../../secret.png' }],
    ['an extension the player cannot decode', { src: 'clips/x/demo.mkv' }],
    ['an image masquerading as a clip', { src: 'clips/x/demo.png' }],
  ])('drops a video block with %s', (_label, over) => {
    const story = parseAnnouncementStory({
      hero: { headline: 'H' },
      blocks: [{ kind: 'video', clip: clip(over) }, { kind: 'note', text: 'survives' }],
    });
    expect(story?.blocks).toEqual([{ kind: 'note', text: 'survives' }]);
  });

  it('accepts webm as well as mp4', () => {
    const story = parseAnnouncementStory({
      hero: { headline: 'H' },
      blocks: [{ kind: 'video', clip: clip({ src: 'clips/x/demo.webm' }) }],
    });
    expect(story?.blocks).toHaveLength(1);
  });

  it('lets a release lead with a clip, and prefers it over a hero shot', () => {
    const story = parseAnnouncementStory({
      hero: { headline: 'H', shot: shot({ alt: 'still' }), clip: clip({ alt: 'moving' }) },
      blocks: [],
    });
    expect(story?.hero.clip?.alt).toBe('moving');
    expect(story?.hero.shot?.alt).toBe('still');
  });
});

describe('storyCoverShot', () => {
  it('prefers the hero shot', () => {
    const story = parseAnnouncementStory({
      hero: { headline: 'H', shot: shot({ alt: 'hero' }) },
      blocks: [{ kind: 'shot', shot: shot({ alt: 'block' }) }],
    });
    expect(storyCoverShot(story)?.alt).toBe('hero');
  });

  it('falls back to the first shot-bearing block', () => {
    const story = parseAnnouncementStory({
      hero: { headline: 'H' },
      blocks: [
        { kind: 'note', text: 'no image here' },
        { kind: 'split', title: 'T', body: 'B', shot: shot({ alt: 'split shot' }) },
        { kind: 'shot', shot: shot({ alt: 'later' }) },
      ],
    });
    expect(storyCoverShot(story)?.alt).toBe('split shot');
  });

  // The teaser and the popup render an `<img>`, so a story that leads with
  // motion still has to hand them a still — the clip's poster, wearing the
  // clip's own alt text.
  it('uses the hero clip’s poster as the cover, over a hero shot', () => {
    const story = parseAnnouncementStory({
      hero: { headline: 'H', shot: shot({ alt: 'still' }), clip: clip({ alt: 'moving', caption: 'cap' }) },
      blocks: [],
    });
    expect(storyCoverShot(story)).toEqual({ src: 'clips/x/demo.png', alt: 'moving', caption: 'cap' });
  });

  it('falls back to a video block’s poster when nothing earlier carries an image', () => {
    const story = parseAnnouncementStory({
      hero: { headline: 'H' },
      blocks: [
        { kind: 'note', text: 'no image here' },
        { kind: 'video', clip: clip({ alt: 'the clip' }) },
        { kind: 'shot', shot: shot({ alt: 'later' }) },
      ],
    });
    expect(storyCoverShot(story)?.alt).toBe('the clip');
  });

  it('returns null for a story with no images at all (a CLI release)', () => {
    const story = parseAnnouncementStory({
      hero: { headline: 'H' },
      blocks: [{ kind: 'terminal', lines: ['$ dreamcontext sleep'] }],
    });
    expect(storyCoverShot(story)).toBeNull();
    expect(storyCoverShot(null)).toBeNull();
    expect(storyCoverShot(undefined)).toBeNull();
  });
});
