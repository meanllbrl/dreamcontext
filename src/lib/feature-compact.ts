/**
 * feature-compact — move a feature PRD's old Changelog entries into a dated archive (SL-4).
 *
 * PRDs only grew: 65 files, 3.0M chars, the largest 327K with a 100K-char Changelog. sleep-product
 * was told to `cat` them whole and carried that through 45 turns. History belongs in the archive,
 * where recall still finds it; the PRD keeps its current truth and its newest entries.
 *
 * A MOVE, NEVER A DELETE (knowledge/patterns/a-delete-is-never-inferred-from-absence.md):
 *  1. plan: split the `## Changelog` section into its entries by slicing, so the kept and moved
 *     blocks put back in order are the original section byte for byte (checked);
 *  2. write each month's archive (`knowledge/archive/features/<name>-<YYYY-MM>.md`), then READ
 *     IT BACK and require every moved block in it verbatim;
 *  3. only then rewrite the PRD, and read it back too.
 * Any failed check stops before the PRD is touched. Writes go through a temp file + rename, and
 * no path is followed through a symlink. Only entries whose heading starts with a date older than
 * the cutoff move, never the newest `keep`; an undated entry is never moved. The PRD gains one
 * pointer line naming where its older entries went.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const ARCHIVE_FEATURES_REL = 'knowledge/archive/features';
export const COMPACT_POINTER_MARK = '<!-- features-compact -->';

export interface ChangelogEntry {
  /** YYYY-MM-DD from the heading, or null for an undated heading. */
  date: string | null;
  text: string;
}

export interface ChangelogSplit {
  /** Everything before the `## Changelog` section's first entry (heading line included). */
  head: string;
  entries: ChangelogEntry[];
  /** Everything from the next `## ` section on (empty when Changelog is last). */
  tail: string;
  /** Text before the Changelog section. */
  before: string;
}

/** Split a PRD around its `## Changelog` section, or null when it has none. Lossless. */
export function splitChangelog(doc: string): ChangelogSplit | null {
  const heading = /^## Changelog[ \t]*$/m.exec(doc);
  if (!heading) return null;
  const sectionStart = heading.index;
  const afterHeading = doc.indexOf('\n', sectionStart);
  const bodyStart = afterHeading < 0 ? doc.length : afterHeading + 1;
  const nextSection = /^## (?!#)/m;
  const rest = doc.slice(bodyStart);
  const next = nextSection.exec(rest);
  const sectionEnd = next ? bodyStart + next.index : doc.length;
  const body = doc.slice(bodyStart, sectionEnd);
  const entryRe = /^### /gm;
  const starts: number[] = [];
  for (const m of body.matchAll(entryRe)) starts.push(m.index!);
  const head = doc.slice(sectionStart, bodyStart) + body.slice(0, starts.length ? starts[0] : body.length);
  const entries: ChangelogEntry[] = starts.map((s, i) => {
    const text = body.slice(s, i + 1 < starts.length ? starts[i + 1] : body.length);
    const m = /^###\s+(\d{4}-\d{2}-\d{2})\b/.exec(text);
    return { date: m ? m[1] : null, text };
  });
  return { before: doc.slice(0, sectionStart), head, entries, tail: doc.slice(sectionEnd) };
}

export function joinChangelog(s: ChangelogSplit): string {
  return s.before + s.head + s.entries.map((e) => e.text).join('') + s.tail;
}

export interface CompactPlan {
  keep: ChangelogEntry[];
  move: ChangelogEntry[];
  /** Moved entries grouped by archive month (YYYY-MM). */
  byMonth: Map<string, ChangelogEntry[]>;
}

/**
 * Which entries move: dated before `cutoff` (YYYY-MM-DD) and not among the `keep` newest dated
 * entries. Undated entries always stay.
 */
export function planCompaction(entries: ChangelogEntry[], cutoff: string, keepNewest: number): CompactPlan {
  // The `keepNewest` newest dated entries stay whatever their age (ties: the earlier in the file).
  const newest = entries
    .map((e, i) => ({ e, i }))
    .filter((x) => x.e.date)
    .sort((a, b) => (b.e.date as string).localeCompare(a.e.date as string) || a.i - b.i)
    .slice(0, Math.max(0, keepNewest))
    .map((x) => x.i);
  const protectedIdx = new Set(newest);
  const keep: ChangelogEntry[] = [];
  const move: ChangelogEntry[] = [];
  entries.forEach((e, i) => {
    if (!e.date || protectedIdx.has(i) || e.date >= cutoff) keep.push(e);
    else move.push(e);
  });
  const byMonth = new Map<string, ChangelogEntry[]>();
  for (const e of move) {
    const month = (e.date as string).slice(0, 7);
    byMonth.set(month, [...(byMonth.get(month) ?? []), e]);
  }
  return { keep, move, byMonth };
}

export interface CompactResult {
  feature: string;
  moved: number;
  movedChars: number;
  archives: string[];
  /** Why nothing was done, when nothing was. */
  skipped: string | null;
}

function refuseLink(p: string): void {
  if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw new Error(`refusing to follow a symlink: ${p}`);
}

function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.compact-${process.pid}.tmp`;
  writeFileSync(tmp, text, 'utf-8');
  renameSync(tmp, path);
}

function archiveHeader(feature: string, month: string, today: string): string {
  return [
    '---',
    `name: ${feature.replace(/\//g, '-')}-${month}`,
    'type: knowledge',
    `description: ${JSON.stringify(`Changelog entries of the ${feature} feature PRD dated ${month}, moved out of knowledge/features/${feature}.md by features compact (byte-verified) so the PRD stays readable. History of what shipped and why for ${feature}.`)}`,
    'tags: [archive]',
    `date: ${today}`,
    '---',
    '',
    `# ${feature}: changelog ${month}`,
    '',
    '',
  ].join('\n');
}

/**
 * Compact one PRD. `dryRun` plans and reports without writing. Throws only on a refused path or
 * a failed verification, before the PRD is touched.
 */
export function compactFeature(
  contextRoot: string,
  feature: string,
  prdPath: string,
  opts: { cutoff: string; keepNewest: number; today: string; dryRun?: boolean },
): CompactResult {
  refuseLink(prdPath);
  const original = readFileSync(prdPath, 'utf-8');
  const split = splitChangelog(original);
  if (!split) return { feature, moved: 0, movedChars: 0, archives: [], skipped: 'no ## Changelog section' };
  if (joinChangelog(split) !== original) throw new Error(`${feature}: changelog split is not lossless; nothing moved`);
  const plan = planCompaction(split.entries, opts.cutoff, opts.keepNewest);
  if (plan.move.length === 0) return { feature, moved: 0, movedChars: 0, archives: [], skipped: 'no entry old enough to move' };

  const archiveDir = join(contextRoot, ARCHIVE_FEATURES_REL);
  const base = feature.replace(/\//g, '-');
  const archives = [...plan.byMonth.keys()].sort().map((m) => join(archiveDir, `${base}-${m}.md`));
  const movedChars = plan.move.reduce((a, e) => a + e.text.length, 0);
  if (opts.dryRun) return { feature, moved: plan.move.length, movedChars, archives, skipped: null };

  for (const p of [join(contextRoot, 'knowledge'), join(contextRoot, 'knowledge', 'archive'), archiveDir]) refuseLink(p);
  mkdirSync(archiveDir, { recursive: true });

  // 1-2: archives first, each read back and checked.
  for (const [month, entries] of plan.byMonth) {
    const path = join(archiveDir, `${base}-${month}.md`);
    refuseLink(path);
    const existing = existsSync(path) ? readFileSync(path, 'utf-8') : archiveHeader(feature, month, opts.today);
    const add = entries.filter((e) => !existing.includes(e.text.trimEnd()));
    const sep = existing.endsWith('\n') ? '' : '\n';
    const next = add.length ? existing + sep + add.map((e) => (e.text.endsWith('\n') ? e.text : `${e.text}\n`)).join('') : existing;
    if (next !== existing) atomicWrite(path, next);
    const back = readFileSync(path, 'utf-8');
    for (const e of entries) {
      if (!back.includes(e.text.trimEnd())) throw new Error(`${feature}: archive ${path} does not hold a moved entry after writing; the PRD was not changed`);
    }
  }

  // 3: the PRD, with one pointer line and the kept entries.
  const rel = `${ARCHIVE_FEATURES_REL}/${base}-<YYYY-MM>.md`;
  const pointer = `${COMPACT_POINTER_MARK}\n> Older entries live in \`${rel}\` (moved by \`dreamcontext features compact\`, byte-verified); recall finds them.\n\n`;
  const head = split.head.includes(COMPACT_POINTER_MARK) ? split.head : split.head.replace(/^(## Changelog[ \t]*\n)(\n?)/, `$1\n${pointer}`);
  const next = split.before + head + plan.keep.map((e) => e.text).join('') + split.tail;
  // Every byte that left the PRD is a moved entry (plus the pointer that came in).
  const removed = original.length - (next.length - (head.length - split.head.length));
  if (removed !== movedChars) throw new Error(`${feature}: compaction would remove ${removed} chars but moved ${movedChars}; the PRD was not changed`);
  atomicWrite(prdPath, next);
  if (readFileSync(prdPath, 'utf-8') !== next) throw new Error(`${feature}: the PRD did not read back as written`);
  return { feature, moved: plan.move.length, movedChars, archives, skipped: null };
}

/** YYYY-MM-DD `days` before `now`. */
export function cutoffDate(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

/** The PRDs worth compacting: over `minChars` in total. */
export function oversizedPrds(files: Array<{ feature: string; path: string }>, minChars: number): Array<{ feature: string; path: string; chars: number }> {
  const out: Array<{ feature: string; path: string; chars: number }> = [];
  for (const f of files) {
    try {
      if (lstatSync(f.path).isSymbolicLink()) continue;
      const chars = readFileSync(f.path, 'utf-8').length;
      if (chars > minChars) out.push({ ...f, chars });
    } catch { /* unreadable: left alone */ }
  }
  return out.sort((a, b) => b.chars - a.chars);
}

/** Exposed for tests: the path a month's archive goes to. */
export function archivePathFor(contextRoot: string, feature: string, month: string): string {
  return join(contextRoot, ARCHIVE_FEATURES_REL, `${feature.replace(/\//g, '-')}-${month}.md`);
}

