import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import fg from 'fast-glob';
import matter from 'gray-matter';
import { foldAscii } from '../fold-ascii.js';
import { splitChangelogEntries } from './clickup-map.js';
import { splitConflictMarkers } from './conflict-markers.js';
import { joinSections, splitSections, unionChangelog } from './merge.js';
import { TASKS_MAP_REL } from './paths.js';
import { SyncLedger, unionTaskMap, type TaskMapEntry } from './sync-state.js';
import { TaskBackendError } from './types.js';

/**
 * `dreamcontext tasks dedup` — heals `state/<slug>-2/-3/-4.md` duplicate
 * families created by a lost `.tasks-map.json` mapping (#204), and repairs
 * dcId↔remoteId cross-wiring left behind by earlier corruption. LOCAL ONLY:
 * never constructs or calls a remote adapter — every fix here is a file/ledger
 * operation on the machine it runs on.
 */

export interface DedupFamily {
  /** The slug the merged task lives at once dedup finishes (the bare base slug). */
  canonicalSlug: string;
  /** Every member slug in the family, sorted (includes the eventual canonical slug's own pre-merge file when it existed). */
  members: string[];
  /** The single remoteId shared by every mapped member; null when no member is mapped (never synced). */
  keepRemoteId: string | null;
  /** Which member's frontmatter + body is kept verbatim (only its Changelog section is replaced by the union). */
  keptBodyFrom: string;
  /** Set instead of merging when members map to genuinely DIFFERENT real remote tasks — never merged, files untouched. */
  skippedReason?: 'distinct-remote-ids';
}

export type MapRepairDisposition = 'repaired' | 'unrepairable' | 'dcId-collision';

/** One dcId↔remoteId cross-wiring finding (D7) — reported in the plan and, on apply, resolved per its disposition. */
export interface MapRepair {
  dcId: string;
  fromSlug: string;
  /** Present only when disposition === 'repaired'. */
  toSlug?: string;
  disposition: MapRepairDisposition;
}

export interface DedupPlan {
  families: DedupFamily[];
  /**
   * True iff the committed map currently carries conflict markers. Planning
   * computes the healed (unioned) map IN MEMORY ONLY — via `splitConflictMarkers`
   * + `unionTaskMap`, never `SyncLedger.healConflictedMap()` — so a `--dry-run`
   * report never writes to the git-tracked `.tasks-map.json`. The physical heal
   * write happens only inside `applyDedup`, on a confirmed (non-dry-run) run.
   */
  mapHealed: boolean;
  /** dcId↔remoteId cross-wiring detected across the WHOLE map (D7) — independent of family duplication. */
  mapRepairs: MapRepair[];
}

export interface DedupResult {
  merged: number;
  filesRemoved: number;
}

interface FileDescriptor {
  slug: string;
  dcId: string;
  name: string;
  updatedAt: string;
  mtimeMs: number;
}

function stateDirOf(contextRoot: string): string {
  return join(contextRoot, 'state');
}

/** Strip a trailing `-N` suffix (the `uniqueSlugFor` naming scheme) to find the shared family base. */
function baseSlugOf(slug: string): string {
  return slug.replace(/-\d+$/, '');
}

function readFileDescriptors(stateDir: string): FileDescriptor[] {
  if (!existsSync(stateDir)) return [];
  const out: FileDescriptor[] = [];
  for (const path of fg.sync('*.md', { cwd: stateDir, absolute: true })) {
    try {
      const { data } = matter(readFileSync(path, 'utf-8'));
      out.push({
        slug: basename(path, '.md'),
        dcId: typeof data.id === 'string' ? data.id : '',
        name: typeof data.name === 'string' ? data.name : '',
        updatedAt: typeof data.updated_at === 'string' ? data.updated_at : '',
        mtimeMs: statSync(path).mtimeMs,
      });
    } catch { /* unreadable mirror — not this command's job to repair a broken file */ }
  }
  return out;
}

/** Newest-body pick: `updated_at` (ISO date strings compare lexicographically), mtime as the tiebreak. */
function pickNewest(members: FileDescriptor[]): FileDescriptor {
  return [...members].sort((a, b) => {
    if (a.updatedAt !== b.updatedAt) return b.updatedAt.localeCompare(a.updatedAt);
    return b.mtimeMs - a.mtimeMs;
  })[0];
}

function planFamilies(descriptors: FileDescriptor[], ledgerMap: TaskMapEntry[]): DedupFamily[] {
  const remoteIdBySlug = new Map(ledgerMap.map((e) => [e.slug, e.remoteId] as const));

  const byBase = new Map<string, FileDescriptor[]>();
  for (const d of descriptors) {
    const base = baseSlugOf(d.slug);
    const arr = byBase.get(base) ?? [];
    arr.push(d);
    byBase.set(base, arr);
  }

  const families: DedupFamily[] = [];
  for (const members of byBase.values()) {
    if (members.length < 2) continue;

    const byName = new Map<string, FileDescriptor[]>();
    for (const m of members) {
      const key = foldAscii(m.name);
      const arr = byName.get(key) ?? [];
      arr.push(m);
      byName.set(key, arr);
    }

    for (const group of byName.values()) {
      if (group.length < 2) continue;

      const base = baseSlugOf(group[0].slug);
      const sortedSlugs = [...group].map((m) => m.slug).sort();
      const remoteIds = new Set(
        group.map((m) => remoteIdBySlug.get(m.slug)).filter((r): r is string => !!r),
      );

      if (remoteIds.size >= 2) {
        // Genuinely different real remote tasks that transiently share a
        // name-derived slug — never merged, never touched.
        families.push({
          canonicalSlug: base,
          members: sortedSlugs,
          keepRemoteId: null,
          keptBodyFrom: pickNewest(group).slug,
          skippedReason: 'distinct-remote-ids',
        });
        continue;
      }

      families.push({
        canonicalSlug: base,
        members: sortedSlugs,
        keepRemoteId: remoteIds.size === 1 ? [...remoteIds][0] : null,
        keptBodyFrom: pickNewest(group).slug,
      });
    }
  }

  return families.sort((a, b) => a.canonicalSlug.localeCompare(b.canonicalSlug));
}

/**
 * Compute the FULLY-REPAIRED map in memory — the single source both `planDedup`
 * (for the dry-run report) and `applyDedup` (for the one `rewriteMap` write)
 * call, so the printed plan and the applied result are always the same
 * computation. Never writes anything itself.
 *
 * Two independent passes, in order:
 *  1. Family repoint — non-skipped families collapse to ONE map entry at
 *     `canonicalSlug` (siblings dropped), carrying the kept body's dcId and
 *     the family's shared remoteId.
 *  2. dcId↔remoteId cross-wiring repair (D7) over the WHOLE resulting map,
 *     using the PRE-move file-identity snapshot (updated for family moves) as
 *     the live-file index:
 *       - exactly one entry for a dcId, and a live file elsewhere carries that
 *         dcId → repoint to that file's slug ('repaired')
 *       - exactly one entry, no live file carries its dcId → leave in place,
 *         flag ('unrepairable')
 *       - TWO OR MORE entries share one dcId (distinct remoteIds — the
 *         historical double-push corruption dedup exists to surface) →
 *         repoint NEITHER, leave all at their current slugs, flag every one
 *         ('dcId-collision'). Repointing any of them would require guessing
 *         which one owns the shared identity — guessing is exactly how a live
 *         mapping gets silently deleted.
 */
function computeRepairedMap(
  descriptors: FileDescriptor[],
  ledgerMap: TaskMapEntry[],
  families: DedupFamily[],
): { finalMap: TaskMapEntry[]; repairs: MapRepair[] } {
  const dcIdBySlug = new Map(descriptors.map((d) => [d.slug, d.dcId] as const));

  const siblingSlugs = new Set<string>();
  const canonicalDcId = new Map<string, string>();
  for (const family of families) {
    if (family.skippedReason) continue;
    for (const slug of family.members) {
      if (slug !== family.canonicalSlug) siblingSlugs.add(slug);
    }
    canonicalDcId.set(family.canonicalSlug, dcIdBySlug.get(family.keptBodyFrom) ?? '');
  }

  // Pass 1 — family repoint.
  let working: TaskMapEntry[] = ledgerMap.filter((e) => !siblingSlugs.has(e.slug));
  for (const family of families) {
    if (family.skippedReason || family.keepRemoteId === null) continue;
    const already = working.find((e) => e.slug === family.canonicalSlug);
    if (already) {
      working = working.map((e) => (e.slug === family.canonicalSlug
        ? { ...e, dcId: canonicalDcId.get(family.canonicalSlug) ?? e.dcId, remoteId: family.keepRemoteId! }
        : e));
    } else {
      const source = ledgerMap.find((e) => family.members.includes(e.slug) && e.remoteId === family.keepRemoteId);
      if (source) {
        working.push({ ...source, slug: family.canonicalSlug, dcId: canonicalDcId.get(family.canonicalSlug) ?? source.dcId });
      }
    }
  }
  working.sort((a, b) => a.slug.localeCompare(b.slug));

  // Live-file index AFTER the family repoint (what will exist on disk once
  // merges/deletes run) — the reference `computeRepairedMap` repairs against.
  const liveDcIdBySlug = new Map<string, string>();
  for (const [slug, dcId] of dcIdBySlug) {
    if (siblingSlugs.has(slug)) continue;
    liveDcIdBySlug.set(slug, dcId);
  }
  for (const [slug, dcId] of canonicalDcId) {
    liveDcIdBySlug.set(slug, dcId);
  }
  const slugByDcId = new Map<string, string>();
  for (const [slug, dcId] of liveDcIdBySlug) {
    if (dcId) slugByDcId.set(dcId, slug);
  }

  // Pass 2 — dcId↔remoteId cross-wiring repair.
  const byDcId = new Map<string, TaskMapEntry[]>();
  for (const entry of working) {
    const arr = byDcId.get(entry.dcId) ?? [];
    arr.push(entry);
    byDcId.set(entry.dcId, arr);
  }

  const finalMap: TaskMapEntry[] = [];
  const repairs: MapRepair[] = [];
  for (const [dcId, group] of byDcId) {
    if (group.length >= 2) {
      for (const entry of group) {
        finalMap.push(entry);
        repairs.push({ dcId, fromSlug: entry.slug, disposition: 'dcId-collision' });
      }
      continue;
    }
    const entry = group[0];
    const liveSlug = slugByDcId.get(dcId);
    if (liveSlug === undefined) {
      finalMap.push(entry);
      repairs.push({ dcId, fromSlug: entry.slug, disposition: 'unrepairable' });
    } else if (liveSlug === entry.slug) {
      finalMap.push(entry);
    } else {
      finalMap.push({ ...entry, slug: liveSlug });
      repairs.push({ dcId, fromSlug: entry.slug, toSlug: liveSlug, disposition: 'repaired' });
    }
  }

  finalMap.sort((a, b) => a.slug.localeCompare(b.slug));
  repairs.sort((a, b) => a.fromSlug.localeCompare(b.fromSlug));

  const seenSlugs = new Set<string>();
  for (const e of finalMap) {
    if (seenSlugs.has(e.slug)) {
      throw new TaskBackendError(
        'corrupt_ledger',
        `tasks dedup computed a duplicate slug "${e.slug}" in the repaired map — refusing to write.`,
      );
    }
    seenSlugs.add(e.slug);
  }

  return { finalMap, repairs };
}

function renderChangelogSection(entries: string[]): string {
  return entries.length > 0 ? `<!-- LIFO: newest at top -->\n\n${entries.join('\n\n')}\n` : '';
}

/** Union every family member's Changelog entries, folded in deterministic (slug-sorted) order. */
function unionAllChangelogs(stateDir: string, sortedMemberSlugs: string[]): string[] {
  let entries: string[] = [];
  for (const slug of sortedMemberSlugs) {
    const path = join(stateDir, `${slug}.md`);
    if (!existsSync(path)) continue;
    const { content } = matter(readFileSync(path, 'utf-8'));
    const section = splitSections(content).find((s) => s.name.toLowerCase() === 'changelog');
    const memberEntries = section ? splitChangelogEntries(section.content) : [];
    entries = unionChangelog(entries, memberEntries);
  }
  return entries;
}

/**
 * Write the merged family to `canonicalSlug.md` (creating or overwriting it)
 * and delete every other member's file. The kept member's frontmatter and body
 * are preserved verbatim — only the Changelog section is replaced by the union
 * — so its `id:` (dcId) is exactly the value `computeRepairedMap` already used.
 */
function mergeFamilyFiles(stateDir: string, family: DedupFamily): void {
  const keptPath = join(stateDir, `${family.keptBodyFrom}.md`);
  const parsed = matter(readFileSync(keptPath, 'utf-8'));
  const sections = splitSections(parsed.content);

  const entries = unionAllChangelogs(stateDir, [...family.members].sort());
  const clIdx = sections.findIndex((s) => s.name.toLowerCase() === 'changelog');
  if (entries.length > 0) {
    const content = renderChangelogSection(entries);
    if (clIdx >= 0) sections[clIdx] = { ...sections[clIdx], content };
    else sections.push({ name: 'Changelog', content });
  } else if (clIdx >= 0) {
    sections.splice(clIdx, 1);
  }

  const mergedText = matter.stringify(joinSections(sections), parsed.data);
  writeFileSync(join(stateDir, `${family.canonicalSlug}.md`), mergedText, 'utf-8');

  for (const slug of family.members) {
    if (slug === family.canonicalSlug) continue;
    const path = join(stateDir, `${slug}.md`);
    if (existsSync(path)) rmSync(path);
  }
}

/**
 * Read the committed map for PLANNING purposes only — never writes. When the
 * file carries conflict markers, the healed (unioned) map is computed in
 * memory via `splitConflictMarkers` + `unionTaskMap` — the exact same
 * lossless primitive `SyncLedger.healConflictedMap()` uses internally — so
 * `planDedup` can report an honest, healed preview without ever touching the
 * git-tracked bytes on disk. A marker-free file still goes through the
 * ledger's own strict `readMap()` (throws on non-marker corruption, same as
 * every other caller).
 */
function readEffectiveMap(contextRoot: string): { map: TaskMapEntry[]; pendingHeal: boolean } {
  const mapPath = join(contextRoot, TASKS_MAP_REL);
  if (!existsSync(mapPath)) return { map: [], pendingHeal: false };

  const raw = readFileSync(mapPath, 'utf-8');
  const split = splitConflictMarkers(raw);
  if (split === null) {
    return { map: new SyncLedger(contextRoot).readMap(), pendingHeal: false };
  }

  const parseSide = (s: string): TaskMapEntry[] => {
    try {
      const parsed = JSON.parse(s || '[]');
      return Array.isArray(parsed) ? (parsed as TaskMapEntry[]) : [];
    } catch {
      return [];
    }
  };
  return { map: unionTaskMap([parseSide(split.ours), parseSide(split.theirs)]), pendingHeal: true };
}

/**
 * Plan a dedup pass — READ ONLY, never a file write or map write. A
 * conflict-markered `.tasks-map.json` is healed IN MEMORY (`readEffectiveMap`)
 * so planning can proceed and report an honest preview, but the physical heal
 * write is deferred entirely to `applyDedup` — `--dry-run` must never mutate
 * the git-tracked map, even mid-merge. `--dry-run` gates the family
 * merges/file deletions/map repoint below, which this function only reports,
 * never performs.
 */
export function planDedup(contextRoot: string): DedupPlan {
  const stateDir = stateDirOf(contextRoot);
  const descriptors = readFileDescriptors(stateDir);
  const { map: ledgerMap, pendingHeal } = readEffectiveMap(contextRoot);

  const families = planFamilies(descriptors, ledgerMap);
  const { repairs } = computeRepairedMap(descriptors, ledgerMap, families);

  return { families, mapHealed: pendingHeal, mapRepairs: repairs };
}

/**
 * Apply a previously computed plan. First performs the PHYSICAL heal write
 * (`SyncLedger.healConflictedMap()`) if the map still carries conflict
 * markers — this is the only place `tasks dedup` ever writes a heal to disk.
 * Then computes the ENTIRE final map in memory and commits it with ONE
 * `ledger.rewriteMap()` call — never incremental `recordMapping`/`migrateSlug`
 * calls, which each filter by a single slug and would dangle the stale entry
 * (or, in a swap-shaped double-mismatch, delete a live sibling mapping before
 * its own repair runs). File merges/deletions and `removeTaskSync` happen
 * AFTER the map commit. LOCAL ONLY — no remote adapter is ever constructed or
 * called.
 */
export function applyDedup(contextRoot: string, plan: DedupPlan): DedupResult {
  const ledger = new SyncLedger(contextRoot);
  ledger.healConflictedMap();

  const stateDir = stateDirOf(contextRoot);
  const descriptors = readFileDescriptors(stateDir);
  const ledgerMap = ledger.readMap();
  const { finalMap } = computeRepairedMap(descriptors, ledgerMap, plan.families);

  ledger.rewriteMap(finalMap);

  let merged = 0;
  let filesRemoved = 0;
  for (const family of plan.families) {
    if (family.skippedReason) continue;
    mergeFamilyFiles(stateDir, family);
    merged += 1;
    filesRemoved += family.members.length - 1;
    for (const slug of family.members) {
      if (slug !== family.canonicalSlug) ledger.removeTaskSync(slug);
    }
  }

  return { merged, filesRemoved };
}
