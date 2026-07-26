/**
 * Pure data layer for an announcement STORY — the landing-page document that IS
 * an announcement. Dependency-free (no React, no CSS, no api/client) so root
 * Vitest (tests/unit/*.test.ts) can import it directly, exactly like its sibling
 * `announcements.ts`.
 *
 * Why a story and not a board. Announcements used to be Excalidraw boards: a
 * canvas you had to pan and zoom to read, drawn from shapes that only ever
 * *described* the product. A story is a scrollable landing page made of real
 * app SCREENSHOTS plus short copy — the reader sees the thing that shipped, in
 * the app's own type and colours, in one downward scroll.
 *
 * The document is authored by hand as JSON (`dashboard/public/announcements/
 * <id>.json`) and rendered by `AnnouncementStory.tsx`. Everything here is a
 * validator: unknown block kinds and malformed blocks are DROPPED, never thrown,
 * so a typo in one card can't blank the whole announcement.
 */

/** A screenshot (or any static image) shipped alongside the story. */
export interface StoryShot {
  /**
   * Path RELATIVE to the announcements asset root (`/announcements/`), e.g.
   * `shots/native-agent-chat/hero.png`. Deliberately not a URL: announcements
   * must render with no network, so remote images and absolute paths are
   * rejected by `parseShot` rather than silently 404-ing in the reader.
   */
  src: string;
  /** Alt text — required, because a screenshot IS the content here. */
  alt: string;
  /** Optional caption printed under the frame. */
  caption?: string;
  /** Frame treatment. `window` (default) draws the app-window chrome around the
   *  shot; `plain` renders a bare bordered image (crops, zoom-ins, diagrams). */
  frame?: 'window' | 'plain';
}

/**
 * A short video of the product — for the things whose value IS motion (a pane
 * opening, an agent working, a transition) and which a still can only describe.
 *
 * A clip carries a `poster` because it has three jobs a video element can't do
 * on its own: fill the frame before the bytes arrive, stand in when decoding
 * fails, and BE the story's cover in the feed teaser and the popup (both of
 * which render an image, not a player). A clip without one is dropped.
 */
export interface StoryClip {
  /** Path relative to the announcements asset root, e.g. `clips/v0-22-0/chat.mp4`. */
  src: string;
  /** Still frame for the same path. Required — see above. */
  poster: string;
  /** What the clip SHOWS, for anyone who can't watch it. Required, like a shot's. */
  alt: string;
  caption?: string;
  /** Frame treatment, same vocabulary as a shot. */
  frame?: 'window' | 'plain';
  /**
   * True when the clip has meaningful audio: it then gets controls and does NOT
   * autoplay. Silent product loops (the default) autoplay muted and loop, the
   * way a GIF used to — motion that explains itself without asking for a click.
   */
  sound?: boolean;
}

/** A row of 2–4 headline numbers. Use for proof, not decoration. */
export interface StatsBlock {
  kind: 'stats';
  items: { value: string; label: string; note?: string }[];
}

/** Copy on one side, screenshot on the other. The workhorse block. */
export interface SplitBlock {
  kind: 'split';
  title: string;
  body: string;
  shot: StoryShot;
  /** Which side the SHOT sits on (default `right`). Alternate down the page. */
  side?: 'left' | 'right';
}

/** A full-width screenshot with an optional title/body above it. */
export interface ShotBlock {
  kind: 'shot';
  shot: StoryShot;
  title?: string;
  body?: string;
}

/** A full-width clip with an optional title/body above it — `shot`, in motion. */
export interface VideoBlock {
  kind: 'video';
  clip: StoryClip;
  title?: string;
  body?: string;
}

/** 2–3 short cards — the "three things this changes" beat. */
export interface PointsBlock {
  kind: 'points';
  title?: string;
  items: { title: string; text: string }[];
}

/** A monospace transcript, for the parts of the product that have no UI. */
export interface TerminalBlock {
  kind: 'terminal';
  title?: string;
  /** One entry per line. Lines starting with `$ ` render as input. */
  lines: string[];
}

/** One highlighted sentence — the pull quote / the punchline. */
export interface NoteBlock {
  kind: 'note';
  text: string;
}

export type StoryBlock =
  | StatsBlock
  | SplitBlock
  | ShotBlock
  | VideoBlock
  | PointsBlock
  | TerminalBlock
  | NoteBlock;

export interface StoryHero {
  /** Small line above the headline — conventionally `v0.22.0 · 25 July 2026`. */
  eyebrow?: string;
  headline: string;
  /** One sentence: the promise, not the mechanism. */
  sub?: string;
  shot?: StoryShot;
  /**
   * A clip instead of a still. `clip` wins if both are given — a release that
   * recorded its headline moment should lead with it, and the clip's poster
   * still covers every surface that needs an image.
   */
  clip?: StoryClip;
}

export interface AnnouncementStory {
  hero: StoryHero;
  blocks: StoryBlock[];
  /** Closing beat: what to go do now. */
  closer?: { title: string; body: string };
}

/** Where story assets are served from (the manifest + stories live here too). */
export const ANNOUNCEMENT_ASSET_ROOT = '/announcements/';

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v : null;
}

/**
 * Resolve a story-relative asset path to a URL under the announcements root.
 * Returns null for anything that isn't a plain relative path — absolute paths,
 * protocol URLs (`https:`, `data:`, `//evil.example`) and `..` traversal are all
 * rejected so a story document can only ever point at assets that ship with it.
 */
export function storyAssetUrl(src: string): string | null {
  const s = str(src);
  if (!s) return null;
  if (s.startsWith('/') || s.startsWith('\\')) return null;
  if (s.includes('://') || s.includes(':')) return null;
  if (s.split('/').some((seg) => seg === '..')) return null;
  return ANNOUNCEMENT_ASSET_ROOT + s;
}

function parseShot(v: unknown): StoryShot | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  const src = str(r.src);
  const alt = str(r.alt);
  // A shot with no alt text is a hole in the story for anyone using a screen
  // reader, and a shot whose src escapes the asset root is a broken image —
  // both are dropped rather than rendered half-working.
  if (!src || !alt || !storyAssetUrl(src)) return null;
  const shot: StoryShot = { src, alt };
  const caption = str(r.caption);
  if (caption) shot.caption = caption;
  if (r.frame === 'plain' || r.frame === 'window') shot.frame = r.frame;
  return shot;
}

/** Extensions the announcement player will accept. Both are `<video>`-native. */
const CLIP_EXTENSIONS = ['.mp4', '.webm'];

function parseClip(v: unknown): StoryClip | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  const src = str(r.src);
  const poster = str(r.poster);
  const alt = str(r.alt);
  // Same contract as a shot — no alt is a hole for anyone who can't watch it,
  // an escaping src is a dead player — plus a poster, because three other
  // surfaces render this clip as a still image.
  if (!src || !poster || !alt) return null;
  if (!storyAssetUrl(src) || !storyAssetUrl(poster)) return null;
  // A path the browser can't decode is worse than no clip: it renders as a
  // black rectangle with no error anywhere.
  if (!CLIP_EXTENSIONS.some((ext) => src.toLowerCase().endsWith(ext))) return null;

  const clip: StoryClip = { src, poster, alt };
  const caption = str(r.caption);
  if (caption) clip.caption = caption;
  if (r.frame === 'plain' || r.frame === 'window') clip.frame = r.frame;
  if (r.sound === true) clip.sound = true;
  return clip;
}

/** Keep only entries that survive `pick`, and only if at least `min` remain. */
function pickList<T>(v: unknown, pick: (item: unknown) => T | null, min: number): T[] | null {
  if (!Array.isArray(v)) return null;
  const out: T[] = [];
  for (const item of v) {
    const parsed = pick(item);
    if (parsed) out.push(parsed);
  }
  return out.length >= min ? out : null;
}

function parseBlock(v: unknown): StoryBlock | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;

  switch (r.kind) {
    case 'stats': {
      const items = pickList(r.items, (i) => {
        if (typeof i !== 'object' || i === null) return null;
        const t = i as Record<string, unknown>;
        const value = str(t.value);
        const label = str(t.label);
        if (!value || !label) return null;
        const note = str(t.note);
        return note ? { value, label, note } : { value, label };
      }, 1);
      return items ? { kind: 'stats', items } : null;
    }
    case 'split': {
      const title = str(r.title);
      const body = str(r.body);
      const shot = parseShot(r.shot);
      if (!title || !body || !shot) return null;
      return { kind: 'split', title, body, shot, side: r.side === 'left' ? 'left' : 'right' };
    }
    case 'shot': {
      const shot = parseShot(r.shot);
      if (!shot) return null;
      const block: ShotBlock = { kind: 'shot', shot };
      const title = str(r.title);
      const body = str(r.body);
      if (title) block.title = title;
      if (body) block.body = body;
      return block;
    }
    case 'video': {
      const clip = parseClip(r.clip);
      if (!clip) return null;
      const block: VideoBlock = { kind: 'video', clip };
      const title = str(r.title);
      const body = str(r.body);
      if (title) block.title = title;
      if (body) block.body = body;
      return block;
    }
    case 'points': {
      const items = pickList(r.items, (i) => {
        if (typeof i !== 'object' || i === null) return null;
        const t = i as Record<string, unknown>;
        const title = str(t.title);
        const text = str(t.text);
        return title && text ? { title, text } : null;
      }, 1);
      if (!items) return null;
      const block: PointsBlock = { kind: 'points', items };
      const title = str(r.title);
      if (title) block.title = title;
      return block;
    }
    case 'terminal': {
      const lines = Array.isArray(r.lines)
        ? r.lines.filter((l): l is string => typeof l === 'string')
        : null;
      if (!lines || lines.length === 0) return null;
      const block: TerminalBlock = { kind: 'terminal', lines };
      const title = str(r.title);
      if (title) block.title = title;
      return block;
    }
    case 'note': {
      const text = str(r.text);
      return text ? { kind: 'note', text } : null;
    }
    default:
      return null;
  }
}

/**
 * Validate a raw parsed story document. Returns null when there is no usable
 * story at all (a headline is the one hard requirement — everything else is a
 * garnish the renderer can do without); otherwise returns the story with every
 * malformed block dropped. Never throws.
 */
export function parseAnnouncementStory(raw: unknown): AnnouncementStory | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const heroRaw = (typeof r.hero === 'object' && r.hero !== null ? r.hero : {}) as Record<string, unknown>;

  const headline = str(heroRaw.headline);
  if (!headline) return null;

  const hero: StoryHero = { headline };
  const eyebrow = str(heroRaw.eyebrow);
  const sub = str(heroRaw.sub);
  const heroShot = parseShot(heroRaw.shot);
  const heroClip = parseClip(heroRaw.clip);
  if (eyebrow) hero.eyebrow = eyebrow;
  if (sub) hero.sub = sub;
  if (heroShot) hero.shot = heroShot;
  if (heroClip) hero.clip = heroClip;

  const blocks: StoryBlock[] = [];
  if (Array.isArray(r.blocks)) {
    for (const b of r.blocks) {
      const parsed = parseBlock(b);
      if (parsed) blocks.push(parsed);
    }
  }

  const story: AnnouncementStory = { hero, blocks };

  if (typeof r.closer === 'object' && r.closer !== null) {
    const c = r.closer as Record<string, unknown>;
    const title = str(c.title);
    const body = str(c.body);
    if (title && body) story.closer = { title, body };
  }

  return story;
}

/** A clip standing in as a still: its poster, carrying the clip's own alt text. */
function clipCover(clip: StoryClip): StoryShot {
  const cover: StoryShot = { src: clip.poster, alt: clip.alt };
  if (clip.caption) cover.caption = clip.caption;
  if (clip.frame) cover.frame = clip.frame;
  return cover;
}

/**
 * The one IMAGE that represents a story wherever a teaser is rendered (feed hero
 * card, What's New popup): the hero clip's poster, the hero shot, or the first
 * block that carries either. Always a still — those surfaces are lists, and a
 * list that autoplays video is a list nobody can read.
 */
export function storyCoverShot(story: AnnouncementStory | null | undefined): StoryShot | null {
  if (!story) return null;
  if (story.hero.clip) return clipCover(story.hero.clip);
  if (story.hero.shot) return story.hero.shot;
  for (const b of story.blocks) {
    if (b.kind === 'split' || b.kind === 'shot') return b.shot;
    if (b.kind === 'video') return clipCover(b.clip);
  }
  return null;
}
