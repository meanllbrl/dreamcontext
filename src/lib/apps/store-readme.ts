/**
 * The store page of an app is read from its README.md (app-paylasim-magaza r2, section 5).
 *
 *   ---
 *   tagline: One sentence about it.
 *   category: Weather            # optional
 *   ---
 *
 *   # Name
 *
 *   ## What it does
 *   A paragraph or two.
 *
 *   ## Screenshots
 *   ![Today](store/today.png)
 *
 *   ## What's new
 *   ### 2 · 2026-11-05
 *   - Shows tomorrow too.
 *
 * What the code does (actions, schedules, the settings it asks for, web addresses) comes from the
 * manifest and the gate's scan, never from here: a README would go stale, the manifest cannot lie.
 * A README without this shape still draws a page: its first paragraph is the tagline and every
 * missing section is simply not drawn.
 */

export const STORE_DIR = 'store';
export const MAX_SCREENSHOTS = 3;
export const TAGLINE_MAX = 80;
const ABOUT_MAX = 1500;
const NOTE_MAX = 300;
const MAX_ENTRIES = 10;
/** Only the head of a README is read, and each line only so far: no input can make a parse slow. */
const README_MAX = 64 * 1024;
const LINE_MAX = 2000;
const HEADING_MAX = 300;

/** A screenshot path the store draws: a flat image under `store/`, nothing else. */
export const SCREENSHOT_RE = /^store\/[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.(?:png|jpe?g|webp)$/;

export interface StoreEntry { version: string; date: string | null; notes: string[] }

export interface StoreReadme {
  tagline: string | null;
  /** True when the tagline is the README's first sentence, not its `tagline:` line. */
  taglineGuessed: boolean;
  category: string | null;
  about: string | null;
  screenshots: Array<{ alt: string; path: string }>;
  whatsNew: StoreEntry[];
}

export interface StoreReadiness {
  ready: number;
  of: 3;
  missing: Array<'tagline' | 'about' | 'whatsNew'>;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/g;

function clean(s: string, max: number): string {
  const t = s.replace(CONTROL, '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/**
 * One header value: a quoted value is taken whole (`"The #1 tracker"`); an unquoted one loses a
 * trailing ` # comment` (space, hash, space), never a `#` inside a word.
 */
function fieldValue(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try { const j = JSON.parse(v); if (typeof j === 'string') return j; } catch { /* plain */ }
    return v.slice(1, -1);
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  const hash = v.search(/[ \t]#[ \t]/);
  return (hash >= 0 ? v.slice(0, hash) : v.endsWith(' #') ? v.slice(0, -2) : v).trim();
}

/** A header value as written back: quoted when a reader would cut or misread it. */
function writeValue(v: string): string {
  return /#|^['"]|:\s|^\s|\s$/.test(v) ? JSON.stringify(v) : v;
}

/**
 * The text of a `##` (or `###`) heading line, or null. No regex runs on the line: a long run of
 * spaces in a hostile README cannot make it backtrack.
 */
function headingText(line: string, level: 2 | 3): string | null {
  if (line.length > HEADING_MAX) return null;
  const marks = '#'.repeat(level);
  if (!line.startsWith(marks) || line[level] === '#' || (line[level] !== ' ' && line[level] !== '\t')) return null;
  let t = line.slice(level).trim();
  while (t.endsWith('#')) t = t.slice(0, -1);
  t = t.trim();
  return t || null;
}

/** `---` header lines → its values (only the two the store reads). */
function splitFrontmatter(text: string, full = false): { fields: Record<string, string>; body: string } {
  // Only the head of the file, each line cut short: every scan below stays cheap on any input.
  const src = (full ? text : text.slice(0, README_MAX)).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n').map((l) => (l.length > LINE_MAX ? l.slice(0, LINE_MAX) : l)).join('\n');
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(src);
  if (!m) return { fields: {}, body: src };
  const fields: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    fields[kv[1].toLowerCase()] = fieldValue(kv[2]);
  }
  return { fields, body: src.slice(m[0].length) };
}

function sectionKey(title: string): 'about' | 'screenshots' | 'whatsNew' | null {
  const t = title.toLowerCase().replace(/[’']/g, '').replace(/\s+/g, ' ').trim();
  if (t === 'what it does') return 'about';
  if (t === 'screenshots') return 'screenshots';
  if (t === 'whats new') return 'whatsNew';
  return null;
}

/** The first plain paragraph after the title: no heading, image, list, quote or code. */
function firstParagraph(lines: string[]): string | null {
  let buf: string[] = [];
  let fence = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('```')) { fence = !fence; if (buf.length) break; continue; }
    if (fence) continue;
    if (!line) { if (buf.length) break; continue; }
    if (/^(#|!\[|[-*+] |\d+\. |>|\||<)/.test(line)) { if (buf.length) break; continue; }
    buf.push(line);
  }
  // Only a sentence is wanted: the link strip runs on the first 1000 characters, never more.
  const p = buf.join(' ').slice(0, 1000).replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '');
  return p.trim() ? p : null;
}

function firstSentence(p: string): string {
  const m = /^(.+?[.!?])(?:\s|$)/.exec(p);
  return clean(m ? m[1] : p, TAGLINE_MAX + 40);
}

/**
 * `full`: the publisher's own README, read to its end (the version numbering and the insert point
 * must see a What's new that starts past 64 KB). Someone else's README (a preview, Shared Apps) is
 * read at its head only. Every scan is bounded per line either way.
 */
export function parseStoreReadme(text: string, opts: { full?: boolean } = {}): StoreReadme {
  const { fields, body } = splitFrontmatter(text ?? '', !!opts.full);
  const lines = body.split('\n');
  const sections: Record<string, string[]> = {};
  const lead: string[] = [];
  let cur: string | null = null;
  let fence = false;
  for (const line of lines) {
    if (line.trim().startsWith('```')) fence = !fence;
    const h2 = !fence ? headingText(line, 2) : null;
    if (h2) { cur = sectionKey(h2) ?? `other:${h2}`; sections[cur] ??= []; continue; }
    if (cur) sections[cur].push(line); else lead.push(line);
  }

  const fmTagline = fields.tagline ? clean(fields.tagline, TAGLINE_MAX + 40) : '';
  const guess = fmTagline ? null : firstParagraph(lead);
  const aboutText = sections.about ? sections.about.join('\n').replace(CONTROL, '').trim() : '';

  const screenshots: StoreReadme['screenshots'] = [];
  // At most 3 pictures are drawn: the first 20 lines of the section, 500 characters each, are enough.
  for (const line of (sections.screenshots ?? []).filter((l) => l.trim()).slice(0, 20).map((l) => l.slice(0, 500))) {
    for (const m of line.matchAll(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
      const path = m[2].replace(/^\.\//, '');
      if (SCREENSHOT_RE.test(path) && !screenshots.some((s) => s.path === path) && screenshots.length < MAX_SCREENSHOTS) {
        screenshots.push({ alt: clean(m[1], 60), path });
      }
    }
  }

  const whatsNew: StoreEntry[] = [];
  let entry: StoreEntry | null = null;
  for (const line of sections.whatsNew ?? []) {
    const h3 = headingText(line, 3);
    if (h3) {
      if (whatsNew.length >= MAX_ENTRIES) break;
      const [v, d] = h3.split(/\s[·—–-]\s/).map((x) => x.trim());
      entry = { version: clean(v.replace(/^v(?=\d)/i, ''), 20), date: d && /^\d{4}-\d{2}-\d{2}$/.test(d.trim()) ? d.trim() : null, notes: [] };
      whatsNew.push(entry);
      continue;
    }
    const t = line.replace(/^\s*[-*+]\s+/, '').trim();
    if (entry && t && entry.notes.length < 8) entry.notes.push(clean(t, NOTE_MAX));
  }

  return {
    tagline: fmTagline || (guess ? firstSentence(guess) : null),
    taglineGuessed: !fmTagline && !!guess,
    category: fields.category ? clean(fields.category, 24) || null : null,
    about: aboutText ? (aboutText.length > ABOUT_MAX ? `${aboutText.slice(0, ABOUT_MAX - 1).trimEnd()}…` : aboutText) : null,
    screenshots,
    whatsNew,
  };
}

/** The three things a store page needs that only the publisher can write. */
export function storeReadiness(s: StoreReadme): StoreReadiness {
  const missing: StoreReadiness['missing'] = [];
  if (!s.tagline || s.taglineGuessed) missing.push('tagline');
  if (!s.about) missing.push('about');
  if (!s.whatsNew.length) missing.push('whatsNew');
  return { ready: 3 - missing.length, of: 3, missing };
}

/** One line for `apps validate` per missing part; empty when the store page is complete. */
export function storeWarnings(text: string | null): string[] {
  if (text === null) return ['README.md: missing. Write it with the store skeleton (/apps): a tagline line, ## What it does, ## What\'s new'];
  const s = parseStoreReadme(text, { full: true });
  const out: string[] = [];
  const r = storeReadiness(s);
  if (r.missing.includes('tagline')) out.push(`README.md tagline: ${s.taglineGuessed ? 'only guessed from the first sentence' : 'missing'}. Add "tagline: <one sentence>" in the --- header at the top (up to ${TAGLINE_MAX} characters)`);
  else if ((s.tagline ?? '').length > TAGLINE_MAX) out.push(`README.md tagline: longer than ${TAGLINE_MAX} characters. Shorten it to one sentence`);
  if (r.missing.includes('about')) out.push('README.md ## What it does: missing. Say in a short paragraph what the app does for its user');
  if (r.missing.includes('whatsNew')) out.push('README.md ## What\'s new: missing. Add "### 1 · <date>" and a line about the first version');
  return out;
}

/** A new app's README: the store skeleton, its gaps for the agent to fill (`apps validate` says which). */
export function readmeSkeleton(name: string, date: string): string {
  const title = name.replace(/[\r\n]/g, ' ').trim();
  return `---\ntagline:\n---\n\n# ${title}\n\n## What it does\n\n## What's new\n\n### 1 · ${date}\n- First version.\n`;
}

/** The next version number: one more than the newest numbered entry, else 1. */
export function nextVersion(s: StoreReadme): string {
  // One more than the highest whole-number version, wherever it sits (newest-first or not); a date
  // or a dotted version is not a number this counts.
  const nums = s.whatsNew.map((e) => (/^\d{1,6}$/.test(e.version) ? Number(e.version) : 0));
  return String(Math.max(0, ...nums) + 1);
}

/** The untouched entry `apps new` writes: one "First version." line. */
function isSkeletonEntry(s: StoreReadme): boolean {
  return s.whatsNew.length === 1 && s.whatsNew[0].version === '1' && s.whatsNew[0].notes.length === 1 && s.whatsNew[0].notes[0] === 'First version.';
}

/**
 * The README with the publish screen's edits: a tagline written into the `---` header, and a
 * `### N · date` entry on top of What's new for the note. Everything else stays byte for byte.
 * With nothing to change, the same text comes back (normalised to `\n` line ends).
 */
export function applyStoreEdits(text: string, edits: { name: string; tagline?: string | null; note?: string | null; date: string; firstPublish?: boolean }): string {
  let src = (text ?? '').replace(/\r\n?/g, '\n');
  if (!src.trim()) src = `# ${edits.name.replace(/[\r\n]/g, ' ').trim()}\n`;
  const tagline = edits.tagline ? clean(edits.tagline, TAGLINE_MAX + 40) : '';
  const before = parseStoreReadme(src, { full: true });
  if (tagline && (before.tagline !== tagline || before.taglineGuessed)) {
    const fm = /^﻿?---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(src);
    if (fm) {
      const lines = fm[1].split('\n');
      const at = lines.findIndex((l) => /^tagline\s*:/i.test(l));
      if (at >= 0) lines[at] = `tagline: ${writeValue(tagline)}`; else lines.unshift(`tagline: ${writeValue(tagline)}`);
      src = `---\n${lines.join('\n')}\n---\n${src.slice(fm[0].length)}`;
    } else {
      src = `---\ntagline: ${writeValue(tagline)}\n---\n\n${src.replace(/^﻿/, '')}`;
    }
  }
  const note = edits.note ? clean(edits.note, NOTE_MAX) : '';
  const parsed = parseStoreReadme(src, { full: true });
  if (note) {
    // The first publish replaces the skeleton's unshipped "1 · <creation date>" entry: the
    // version that ships first is 1, dated the day it ships.
    const replace = !!edits.firstPublish && isSkeletonEntry(parsed);
    const entry = `### ${replace ? '1' : nextVersion(parsed)} · ${edits.date}\n- ${note}\n`;
    let lines = src.split('\n');
    let fence = false;
    let at = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().startsWith('```')) fence = !fence;
      const h2 = !fence ? headingText(lines[i], 2) : null;
      if (h2 && sectionKey(h2) === 'whatsNew') { at = i; break; }
    }
    if (at >= 0 && replace) {
      const from = lines.findIndex((l, i) => i > at && headingText(l, 3) !== null);
      if (from > at) {
        let to = from + 1;
        while (to < lines.length && headingText(lines[to], 3) === null && headingText(lines[to], 2) === null) to++;
        lines = [...lines.slice(0, from), ...lines.slice(to)];
      }
    }
    if (at >= 0) {
      lines.splice(at + 1, 0, '', ...entry.trimEnd().split('\n'));
      // One blank line around the new entry, found by walking the lines (no regex over the file).
      const end = at + 1 + entry.trimEnd().split('\n').length + 1;
      let extra = 0;
      while (end + extra + 1 < lines.length && lines[end + extra] === '' && lines[end + extra + 1] === '') extra++;
      if (extra) lines.splice(end, extra);
      if (end < lines.length && lines[end] !== '' && headingText(lines[end], 3) !== null) lines.splice(end, 0, '');
      src = lines.join('\n');
    } else {
      src = `${src.trimEnd()}\n\n## What's new\n\n${entry}`;
    }
  }
  return src.endsWith('\n') ? src : `${src}\n`;
}
