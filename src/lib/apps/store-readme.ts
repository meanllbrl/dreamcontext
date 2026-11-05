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

/** `---` header lines → its values (only the two the store reads). */
function splitFrontmatter(text: string): { fields: Record<string, string>; body: string } {
  const src = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(src);
  if (!m) return { fields: {}, body: src };
  const fields: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    // A trailing `# comment` is the writer's, not the value (a value with " #" in it is rare).
    let v = kv[2].replace(/\s+#.*$/, '').trim();
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    fields[kv[1].toLowerCase()] = v;
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
  const p = buf.join(' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '');
  return p.trim() ? p : null;
}

function firstSentence(p: string): string {
  const m = /^(.+?[.!?])(?:\s|$)/.exec(p);
  return clean(m ? m[1] : p, TAGLINE_MAX + 40);
}

export function parseStoreReadme(text: string): StoreReadme {
  const { fields, body } = splitFrontmatter(text ?? '');
  const lines = body.split('\n');
  const sections: Record<string, string[]> = {};
  const lead: string[] = [];
  let cur: string | null = null;
  let fence = false;
  for (const line of lines) {
    if (line.trim().startsWith('```')) fence = !fence;
    const h2 = !fence ? /^##\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (h2 && !line.startsWith('###')) { cur = sectionKey(h2[1]) ?? `other:${h2[1]}`; sections[cur] ??= []; continue; }
    if (cur) sections[cur].push(line); else lead.push(line);
  }

  const fmTagline = fields.tagline ? clean(fields.tagline, TAGLINE_MAX + 40) : '';
  const guess = fmTagline ? null : firstParagraph(lead);
  const aboutText = sections.about ? sections.about.join('\n').replace(CONTROL, '').trim() : '';

  const screenshots: StoreReadme['screenshots'] = [];
  for (const line of sections.screenshots ?? []) {
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
    const h3 = /^###\s+(.+?)\s*$/.exec(line);
    if (h3) {
      if (whatsNew.length >= MAX_ENTRIES) break;
      const [v, d] = h3[1].split(/\s+[·—–-]\s+/);
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
  const s = parseStoreReadme(text);
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
  const n = Number.parseInt(s.whatsNew[0]?.version ?? '', 10);
  return Number.isFinite(n) && n > 0 ? String(n + 1) : '1';
}

/**
 * The README with the publish screen's edits: a tagline written into the `---` header, and a
 * `### N · date` entry on top of What's new for the note. Everything else stays byte for byte.
 * With nothing to change, the same text comes back (normalised to `\n` line ends).
 */
export function applyStoreEdits(text: string, edits: { name: string; tagline?: string | null; note?: string | null; date: string }): string {
  let src = (text ?? '').replace(/\r\n?/g, '\n');
  if (!src.trim()) src = `# ${edits.name.replace(/[\r\n]/g, ' ').trim()}\n`;
  const tagline = edits.tagline ? clean(edits.tagline, TAGLINE_MAX + 40) : '';
  const before = parseStoreReadme(src);
  if (tagline && (before.tagline !== tagline || before.taglineGuessed)) {
    const fm = /^﻿?---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(src);
    if (fm) {
      const lines = fm[1].split('\n');
      const at = lines.findIndex((l) => /^tagline\s*:/i.test(l));
      if (at >= 0) lines[at] = `tagline: ${tagline}`; else lines.unshift(`tagline: ${tagline}`);
      src = `---\n${lines.join('\n')}\n---\n${src.slice(fm[0].length)}`;
    } else {
      src = `---\ntagline: ${tagline}\n---\n\n${src.replace(/^﻿/, '')}`;
    }
  }
  const note = edits.note ? clean(edits.note, NOTE_MAX) : '';
  const parsed = parseStoreReadme(src);
  if (note) {
    const entry = `### ${nextVersion(parsed)} · ${edits.date}\n- ${note}\n`;
    const lines = src.split('\n');
    let fence = false;
    let at = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().startsWith('```')) fence = !fence;
      const h2 = !fence ? /^##\s+(.+?)\s*#*\s*$/.exec(lines[i]) : null;
      if (h2 && !lines[i].startsWith('###') && sectionKey(h2[1]) === 'whatsNew') { at = i; break; }
    }
    if (at >= 0) {
      lines.splice(at + 1, 0, '', ...entry.trimEnd().split('\n'));
      src = lines.join('\n').replace(/\n{3,}(### )/g, '\n\n$1');
    } else {
      src = `${src.trimEnd()}\n\n## What's new\n\n${entry}`;
    }
  }
  return src.endsWith('\n') ? src : `${src}\n`;
}
