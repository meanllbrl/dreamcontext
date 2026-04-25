import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  pickVisionProvider,
  parseLabelsFromText,
  LABEL_ALLOWLIST,
  labelHookFrame,
  runVisionPassOnPost,
  updatePatternTagsInBridge,
  type VisionFetcher,
} from '../../src/lib/marketing/vision.js';

function makeDir(): string {
  const raw = join(tmpdir(), `mk-vision-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  return realpathSync(raw);
}

const PNG_1x1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cf' +
    'c0c0c00400000000ffff0300000600055750c80a0000000049454e44ae426082',
  'hex',
);

function mockFetcher(responses: Array<{ ok: boolean; status: number; body: string }>): VisionFetcher {
  let i = 0;
  return async () => {
    const r = responses[i] ?? responses[responses.length - 1];
    i += 1;
    return { ok: r.ok, status: r.status, text: async () => r.body };
  };
}

describe('marketing/vision — pickVisionProvider', () => {
  it('picks openai when OPENAI_VISION_API_KEY set', () => {
    expect(pickVisionProvider({ OPENAI_VISION_API_KEY: 'sk-xxx' })).toEqual({
      provider: 'openai',
      apiKey: 'sk-xxx',
    });
  });

  it('picks google when only GOOGLE_API_KEY set', () => {
    expect(pickVisionProvider({ GOOGLE_API_KEY: 'g-yyy' })).toEqual({
      provider: 'google',
      apiKey: 'g-yyy',
    });
  });

  it('prefers openai over google when both set', () => {
    expect(pickVisionProvider({ OPENAI_VISION_API_KEY: 'sk-x', GOOGLE_API_KEY: 'g-y' })).toEqual({
      provider: 'openai',
      apiKey: 'sk-x',
    });
  });

  it('returns null when neither set', () => {
    expect(pickVisionProvider({})).toBeNull();
  });

  it('treats empty / whitespace key as unset', () => {
    expect(pickVisionProvider({ OPENAI_VISION_API_KEY: '   ' })).toBeNull();
  });
});

describe('marketing/vision — parseLabelsFromText', () => {
  it('parses a clean JSON array', () => {
    expect(parseLabelsFromText('["face-zoom"]')).toEqual(['face-zoom']);
    expect(parseLabelsFromText('["talking-head","prop-driven"]')).toEqual(['talking-head', 'prop-driven']);
  });

  it('strips code fences', () => {
    expect(parseLabelsFromText('```json\n["text-only"]\n```')).toEqual(['text-only']);
    expect(parseLabelsFromText('```\n["b-roll"]\n```')).toEqual(['b-roll']);
  });

  it('extracts an array embedded in prose', () => {
    expect(parseLabelsFromText('Here is the answer: ["face-zoom", "group-shot"]. End.')).toEqual([
      'face-zoom',
      'group-shot',
    ]);
  });

  it('caps to 2 labels even if model returns more', () => {
    expect(
      parseLabelsFromText('["face-zoom","talking-head","prop-driven","group-shot"]'),
    ).toEqual(['face-zoom', 'talking-head']);
  });

  it('drops anything not in allowlist', () => {
    expect(parseLabelsFromText('["face-zoom","cinematic","unicorn"]')).toEqual(['face-zoom']);
  });

  it('lowercases / trims candidates', () => {
    expect(parseLabelsFromText('["FACE-ZOOM"," text-only "]')).toEqual(['face-zoom', 'text-only']);
  });

  it('dedupes', () => {
    expect(parseLabelsFromText('["face-zoom","face-zoom"]')).toEqual(['face-zoom']);
  });

  it('returns [] on empty / non-array / unparseable input', () => {
    expect(parseLabelsFromText('')).toEqual([]);
    expect(parseLabelsFromText('not json at all')).toEqual([]);
    expect(parseLabelsFromText('"just a string"')).toEqual([]);
    expect(parseLabelsFromText('{"key": "value"}')).toEqual([]);
  });

  it('respects the LABEL_ALLOWLIST contract', () => {
    expect(LABEL_ALLOWLIST).toContain('face-zoom');
    expect(LABEL_ALLOWLIST).toContain('text-only');
    expect(LABEL_ALLOWLIST).toContain('prop-driven');
  });
});

describe('marketing/vision — labelHookFrame (mocked HTTP)', () => {
  let dir: string;
  let frame: string;

  beforeEach(() => {
    dir = makeDir();
    frame = join(dir, 'frame.png');
    writeFileSync(frame, PNG_1x1);
  });

  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('parses an OpenAI response and returns labels', async () => {
    const fetcher = mockFetcher([{
      ok: true,
      status: 200,
      body: JSON.stringify({
        choices: [{ message: { content: '["face-zoom"]' } }],
      }),
    }]);
    const labels = await labelHookFrame(frame, { provider: 'openai', apiKey: 'sk-x', fetcher });
    expect(labels).toEqual(['face-zoom']);
  });

  it('parses a Google response and returns labels', async () => {
    const fetcher = mockFetcher([{
      ok: true,
      status: 200,
      body: JSON.stringify({
        candidates: [{ content: { parts: [{ text: '["talking-head","prop-driven"]' }] } }],
      }),
    }]);
    const labels = await labelHookFrame(frame, { provider: 'google', apiKey: 'g-y', fetcher });
    expect(labels).toEqual(['talking-head', 'prop-driven']);
  });

  it('throws on non-2xx HTTP', async () => {
    const fetcher = mockFetcher([{ ok: false, status: 500, body: 'err' }]);
    await expect(
      labelHookFrame(frame, { provider: 'openai', apiKey: 'sk-x', fetcher }),
    ).rejects.toThrow(/HTTP 500/);
  });

  it('returns [] when frame file does not exist', async () => {
    const labels = await labelHookFrame(join(dir, 'missing.png'), {
      provider: 'openai', apiKey: 'sk-x', fetcher: mockFetcher([]),
    });
    expect(labels).toEqual([]);
  });
});

describe('marketing/vision — runVisionPassOnPost', () => {
  let dir: string;
  let postPath: string;
  let mdPath: string;

  beforeEach(() => {
    dir = makeDir();
    const framesDir = join(dir, 'frames');
    mkdirSync(framesDir, { recursive: true });
    const f0 = join(framesDir, 'frame_0.png');
    const f1 = join(framesDir, 'frame_1.png');
    writeFileSync(f0, PNG_1x1);
    writeFileSync(f1, PNG_1x1);

    postPath = join(dir, 'abc.json');
    mdPath = join(dir, 'abc.md');
    writeFileSync(postPath, JSON.stringify({
      id: 'h__abc',
      shortcode: 'abc',
      pattern_tags: [],
      vision_summary: null,
      frames: [
        { timestamp: 0, path: f0, type: 'hook' },
        { timestamp: 1, path: f1, type: 'hook' },
        { timestamp: 5, path: 'whatever', type: 'regular' },
      ],
    }, null, 2));
    writeFileSync(mdPath, '---\nid: h__abc\nshortcode: abc\npattern_tags: []\n---\n\nbody\n');
  });

  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('skips when no provider key configured', async () => {
    // Clear provider env vars for this test
    const env = { ...process.env };
    delete process.env.OPENAI_VISION_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    try {
      const result = await runVisionPassOnPost(postPath);
      expect(result.skipped).toBe('no-provider');
    } finally {
      process.env = env;
    }
  });

  it('skips when post has no hook frames', async () => {
    writeFileSync(postPath, JSON.stringify({
      id: 'h__yt', shortcode: 'yt', pattern_tags: [], vision_summary: null,
      frames: [{ timestamp: 5, path: 'x', type: 'regular' }],
    }));
    const result = await runVisionPassOnPost(postPath, {
      provider: 'openai', apiKey: 'sk-x', fetcher: mockFetcher([]),
    });
    expect(result.skipped).toBe('no-hook-frames');
  });

  it('skips when pattern_tags already populated', async () => {
    const existing = JSON.parse(readFileSync(postPath, 'utf-8'));
    existing.pattern_tags = ['face-zoom'];
    writeFileSync(postPath, JSON.stringify(existing));
    const result = await runVisionPassOnPost(postPath, {
      provider: 'openai', apiKey: 'sk-x', fetcher: mockFetcher([]),
    });
    expect(result.skipped).toBe('already-labeled');
  });

  it('labels hook frames and writes pattern_tags + vision_summary back to disk', async () => {
    const fetcher = mockFetcher([
      { ok: true, status: 200, body: JSON.stringify({ choices: [{ message: { content: '["face-zoom"]' } }] }) },
      { ok: true, status: 200, body: JSON.stringify({ choices: [{ message: { content: '["talking-head","prop-driven"]' } }] }) },
    ]);
    const result = await runVisionPassOnPost(postPath, {
      provider: 'openai', apiKey: 'sk-x', fetcher,
    });
    expect(result.skipped).toBeNull();
    expect(result.framesLabeled).toBe(2);
    expect(result.patternTags.sort()).toEqual(['face-zoom', 'prop-driven', 'talking-head']);

    const post = JSON.parse(readFileSync(postPath, 'utf-8'));
    expect(post.pattern_tags.sort()).toEqual(['face-zoom', 'prop-driven', 'talking-head']);
    expect(post.vision_summary).toMatch(/Vision-tagged 2\/2/);
    expect(post.frames[0].labels).toEqual(['face-zoom']);
    expect(post.frames[1].labels).toEqual(['talking-head', 'prop-driven']);
    expect(post.frames[2].labels).toBeUndefined(); // regular frame untouched

    // Bridge md updated
    const md = readFileSync(mdPath, 'utf-8');
    expect(md).toContain('pattern_tags: ["face-zoom", "prop-driven", "talking-head"]');
  });

  it('continues past per-frame failure and labels what it can', async () => {
    const fetcher = mockFetcher([
      { ok: false, status: 500, body: 'oops' },
      { ok: true, status: 200, body: JSON.stringify({ choices: [{ message: { content: '["face-zoom"]' } }] }) },
    ]);
    const result = await runVisionPassOnPost(postPath, {
      provider: 'openai', apiKey: 'sk-x', fetcher,
    });
    expect(result.framesLabeled).toBe(1);
    expect(result.patternTags).toEqual(['face-zoom']);
  });

  it('writes empty-result vision_summary when nothing labeled', async () => {
    const fetcher = mockFetcher([
      { ok: true, status: 200, body: JSON.stringify({ choices: [{ message: { content: '[]' } }] }) },
      { ok: true, status: 200, body: JSON.stringify({ choices: [{ message: { content: '[]' } }] }) },
    ]);
    const result = await runVisionPassOnPost(postPath, {
      provider: 'openai', apiKey: 'sk-x', fetcher,
    });
    expect(result.framesLabeled).toBe(0);
    expect(result.patternTags).toEqual([]);
    const post = JSON.parse(readFileSync(postPath, 'utf-8'));
    expect(post.vision_summary).toMatch(/no allowlisted patterns/);
  });
});

describe('marketing/vision — updatePatternTagsInBridge', () => {
  it('replaces existing pattern_tags line', () => {
    const before = '---\nid: x\npattern_tags: []\n---\n\nbody\n';
    const after = updatePatternTagsInBridge(before, ['face-zoom', 'b-roll']);
    expect(after).toContain('pattern_tags: ["face-zoom", "b-roll"]');
    expect(after).toContain('body');
  });

  it('inserts pattern_tags when missing', () => {
    const before = '---\nid: x\nshortcode: abc\n---\n\nbody\n';
    const after = updatePatternTagsInBridge(before, ['text-only']);
    expect(after).toMatch(/pattern_tags: \["text-only"\]/);
  });

  it('returns input unchanged when no frontmatter', () => {
    const before = '# no frontmatter';
    expect(updatePatternTagsInBridge(before, ['face-zoom'])).toBe(before);
  });
});
