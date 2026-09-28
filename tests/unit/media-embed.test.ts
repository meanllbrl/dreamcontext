import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * One inline player. Every clip or audio the app plays in place is drawn by
 * `sleepy/chat/MediaEmbed.tsx`; a surface that writes its own `<video>` or `<audio>`
 * is the regression this pins (owner, 2026-09-25: a fix in one place must land in
 * all of them).
 */
const ROOT = join(process.cwd(), 'dashboard/src');
const ATOM = 'components/sleepy/chat/MediaEmbed.tsx';

/**
 * Showcase clips, not files played in place: autoplay, muted, a poster, several sources.
 * They are a different element with a different life, so they stay where they are. Each
 * entry names why; a stale entry (the element gone) fails too, so the list stays honest.
 */
const SHOWCASE_CLIPS: Record<string, string> = {
  'components/about/Hero.tsx': 'the About hero: autoplay, muted, loop, webm+mp4 sources, no controls',
  'components/announcements/AnnouncementStory.tsx': 'a What is New story clip: poster, autoplay when silent, controls when it has sound',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

describe('MediaEmbed is the only inline player', () => {
  const files = walk(ROOT);

  it('no surface writes its own <video> or <audio> element', () => {
    const players = files
      .filter((f) => !f.endsWith(ATOM))
      .filter((f) => /^\s*<(video|audio)(\s|$)/m.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(ROOT.length + 1));
    const offenders = players.filter((rel) => !(rel in SHOWCASE_CLIPS));
    expect(offenders).toEqual([]);
    const stale = Object.keys(SHOWCASE_CLIPS).filter((rel) => !players.includes(rel));
    expect(stale, 'showcase entries whose element is gone').toEqual([]);
  });

  it('the three surfaces that play media in place import the atom', () => {
    for (const rel of [
      'components/sleepy/chat/TranscriptItem.tsx',
      'components/sleepy/chat/SlideOver.tsx',
      'components/agents/AgentMessage.tsx',
    ]) {
      const src = readFileSync(join(ROOT, rel), 'utf8');
      expect(src, rel).toMatch(/import \{ MediaEmbed \} from '[./]*sleepy\/chat\/MediaEmbed'|from '\.\/MediaEmbed'/);
      expect(src, rel).toMatch(/<MediaEmbed\b/);
    }
  });

  it('the atom itself draws both kinds with the shared attributes', () => {
    const src = readFileSync(join(ROOT, ATOM), 'utf8');
    expect(src).toMatch(/<audio[\s\S]*controls[\s\S]*preload="metadata"/);
    expect(src).toMatch(/<video[\s\S]*controls[\s\S]*preload="metadata"[\s\S]*playsInline/);
    expect(src).toMatch(/onLoadedMetadata/);
  });
});
