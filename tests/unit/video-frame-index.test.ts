/**
 * Tests for the video-watching engine's frame indexer
 * (skill-packs/video-watching/scripts/build_frame_index.py).
 *
 * Context: issue #15 — the engine was under-sampling UI/onboarding recordings. The
 * fix moved frame selection into one time-based ffmpeg pass and made build_frame_index
 * responsible for (a) reconstructing each frame's `type` (scene vs gap) from inter-frame
 * spacing relative to MAX_GAP, and (b) reporting coverage (the largest unsampled gap)
 * so under-sampling is caught before a downstream deep-analysis pass.
 *
 * This pins that deterministic contract. The script is stdlib-only Python; we drive it
 * the same way transcribe.sh does — synthesize a frames/ dir + frame_times.txt, run it,
 * and assert on frames.json + the printed coverage line.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT = resolve(
  __dirname,
  '../../skill-packs/video-watching/scripts/build_frame_index.py',
);

interface FrameRow {
  file: string;
  t: number | null;
  at: string;
  type: 'scene' | 'gap' | 'anchor';
}

let dir: string;

beforeEach(() => {
  const raw = join(tmpdir(), `ac-vw-index-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(raw, 'frames'), { recursive: true });
  dir = realpathSync(raw);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Lay down empty jpgs (the indexer only globs names) + the ffmpeg-style pts dump. */
function scaffold(times: number[], opts: { anchors?: boolean } = {}): void {
  const frames = join(dir, 'frames');
  times.forEach((_, i) => writeFileSync(join(frames, `frame_${String(i + 1).padStart(4, '0')}.jpg`), ''));
  // metadata=print header lines: "frame:N  pts:...  pts_time:T"
  const dump = times.map((t, i) => `frame:${i}    pts:${Math.round(t * 1000)}    pts_time:${t.toFixed(6)}`).join('\n');
  writeFileSync(join(frames, 'frame_times.txt'), dump + '\n');
  if (opts.anchors !== false) {
    writeFileSync(join(frames, 'anchor_first.jpg'), '');
    writeFileSync(join(frames, 'anchor_last.jpg'), '');
  }
}

function run(duration: number, env: Record<string, string> = {}): { stdout: string; rows: FrameRow[] } {
  const stdout = execFileSync('python3', [SCRIPT, dir, String(duration)], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  const rows = JSON.parse(readFileSync(join(dir, 'frames.json'), 'utf8')) as FrameRow[];
  return { stdout, rows };
}

describe('video-watching build_frame_index.py', () => {
  it('labels a frame "gap" when spaced >= MAX_GAP and "scene" when it arrived sooner', () => {
    // 2.6s after t=0 -> periodic fill (gap); 4.0 is only 1.4s after 2.6 -> a scene change.
    scaffold([0.0, 2.6, 4.0, 6.6, 9.2]);
    const { rows } = run(12, { MAX_GAP: '2.5' });

    const byFile = Object.fromEntries(rows.map((r) => [r.file, r]));
    expect(byFile['frames/frame_0002.jpg'].type).toBe('gap'); // 2.6 since prev
    expect(byFile['frames/frame_0003.jpg'].type).toBe('scene'); // 1.4 since prev
    expect(byFile['frames/frame_0004.jpg'].type).toBe('gap'); // 2.6 since prev
  });

  it('always keeps both anchors and sorts the timeline', () => {
    scaffold([0.0, 4.0, 8.0]);
    const { rows } = run(12, { MAX_GAP: '2.5' });

    const anchors = rows.filter((r) => r.type === 'anchor');
    expect(anchors.map((r) => r.file).sort()).toEqual([
      'frames/anchor_first.jpg',
      'frames/anchor_last.jpg',
    ]);
    const ts = rows.map((r) => r.t ?? Infinity);
    expect(ts).toEqual([...ts].sort((a, b) => a - b)); // non-decreasing
  });

  it('reports the largest unsampled gap, bounded by [0, duration]', () => {
    // gaps: 0->2.6, 2.6->4, 4->6.6, 6.6->9.2, 9.2->12(dur) == 2.8 is the largest.
    scaffold([0.0, 2.6, 4.0, 6.6, 9.2]);
    const { stdout } = run(12, { MAX_GAP: '2.5' });
    expect(stdout).toMatch(/longest unsampled gap = 2\.8s/);
  });

  it('warns when the longest gap exceeds 2x MAX_GAP (under-sampling)', () => {
    // One 9s hole on a 10s clip with MAX_GAP=2.5 -> 9 > 5 -> warn.
    scaffold([0.0, 1.0]);
    const { stdout } = run(10, { MAX_GAP: '2.5' });
    expect(stdout).toMatch(/⚠ coverage gap is >2x MAX_GAP/);
    expect(stdout).toMatch(/--mode ui/);
  });

  it('does not warn when coverage is within bounds', () => {
    scaffold([0.0, 2.0, 4.0, 6.0, 8.0]);
    const { stdout } = run(10, { MAX_GAP: '2.5' });
    expect(stdout).not.toMatch(/⚠/);
  });

  // ── regressions for findings surfaced by multi-review ──────────────────────

  it('dedupes the eq(n,0) seed frame against anchor_first instead of duplicating t=0', () => {
    // The seed frame (frame_0001 @ t=0) coincides with anchor_first @ t=0. Only one
    // entry should survive at t=0, and it must be the anchor (not a frame mislabeled "scene").
    scaffold([0.0, 2.6, 5.2]);
    const { rows } = run(8, { MAX_GAP: '2.5' });
    const atZero = rows.filter((r) => r.t === 0);
    expect(atZero).toHaveLength(1);
    expect(atZero[0].type).toBe('anchor');
    expect(atZero[0].file).toBe('frames/anchor_first.jpg');
  });

  it('still surfaces the tail gap when duration is unknown (ffprobe returned 0)', () => {
    // Frames stop at t=5 but the clip is longer; with duration=0 the right edge must fall
    // back to the last sample so an under-sampled tail is not silently invisible.
    // gaps with right edge = 5.0: 0->1 (1), 1->5 (4) == 4.0 largest.
    scaffold([0.0, 1.0, 5.0]);
    const { stdout } = run(0, { MAX_GAP: '2.5' });
    expect(stdout).toMatch(/longest unsampled gap = 4\.0s/);
  });

  it('handles an empty frame_times.txt without crashing (anchors only)', () => {
    scaffold([]); // no frame_*.jpg, empty dump, but anchors present
    const { stdout, rows } = run(10, { MAX_GAP: '2.5' });
    expect(rows.every((r) => r.type === 'anchor')).toBe(true);
    expect(stdout).toMatch(/coverage: longest unsampled gap/);
  });
});
