import { existsSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import matter from 'gray-matter';
import {
  merge3Bodies,
  unionChangelog,
  splitSections,
  joinSections,
  type SectionBlock,
} from '../task-backend/merge.js';
import { unionTaskMap, type TaskMapEntry } from '../task-backend/sync-state.js';
import { TASKS_MAP_REL } from '../task-backend/paths.js';
import { addPath, readOursTheirsBase } from './git.js';

/**
 * Deterministic merge engine for the brain-repo sync engine — see
 * `skill-sync/references/merge-rules.md` for the full table this implements.
 * Reuses `task-backend/merge.ts` (`merge3Bodies`/`unionChangelog`/section
 * split-join) rather than re-implementing 3-way prose merge.
 */

export type MergeClass =
  | 'changelog-json'
  | 'releases-json'
  | 'config-json'
  | 'tasks-map-json'
  | 'task-md'
  | 'knowledge-md'
  | 'feature-md'
  | 'taxonomy-json'
  | 'other'
  /**
   * full-repo only: a real project/code file (anything NOT under `_dream_context/`).
   * NEVER semantically merged and NEVER deferred to the prose agent — a code
   * conflict is git's native 3-way markers for the human to resolve in their editor.
   */
  | 'code';

/** Classify a conflicted path (as reported by git — may carry an `_dream_context/` prefix in in-tree mode). */
export function classifyPath(relPath: string): MergeClass {
  const norm = relPath.replace(/\\/g, '/').replace(/^_dream_context\//, '');
  if (norm === 'core/CHANGELOG.json') return 'changelog-json';
  if (norm === 'core/RELEASES.json') return 'releases-json';
  if (norm === 'state/.config.json') return 'config-json';
  if (norm === 'core/taxonomy.json') return 'taxonomy-json';
  if (norm === TASKS_MAP_REL) return 'tasks-map-json';
  if (/^state\/[^/]+\.md$/.test(norm)) return 'task-md';
  if (/^knowledge\/features\//.test(norm)) return 'feature-md';
  if (/^knowledge\//.test(norm)) return 'knowledge-md';
  return 'other';
}

function parseJsonArray(content: string): Record<string, unknown>[] {
  try {
    const parsed = JSON.parse(content || '[]');
    return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : [];
  } catch {
    return [];
  }
}

function parseJsonObject(content: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(content || '{}');
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function unionStringArray(a: unknown, b: unknown): string[] {
  const arrA = Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : [];
  const arrB = Array.isArray(b) ? b.filter((x): x is string => typeof x === 'string') : [];
  return [...new Set([...arrA, ...arrB])];
}

// ─── core/CHANGELOG.json — set-union by fingerprint, LIFO ───────────────────

function changelogFingerprint(e: Record<string, unknown>): string {
  return JSON.stringify([e.date, e.type, e.scope, e.description]);
}

export function mergeChangelogJson(_base: string, ours: string, theirs: string): { merged: string } {
  const oursArr = parseJsonArray(ours);
  const theirsArr = parseJsonArray(theirs);
  const oursFp = new Set(oursArr.map(changelogFingerprint));
  const seenTheirs = new Set<string>();
  const theirsOnly = theirsArr.filter((e) => {
    const fp = changelogFingerprint(e);
    if (oursFp.has(fp) || seenTheirs.has(fp)) return false;
    seenTheirs.add(fp);
    return true;
  });
  const merged = [...theirsOnly, ...oursArr];
  merged.sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
  return { merged: `${JSON.stringify(merged, null, 2)}\n` };
}

// ─── core/RELEASES.json — union by version/id, field-merge on same key ─────

export function mergeReleasesJson(_base: string, ours: string, theirs: string): { merged: string } {
  const oursArr = parseJsonArray(ours);
  const theirsArr = parseJsonArray(theirs);
  const keyOf = (e: Record<string, unknown>) => String(e.version ?? e.id ?? JSON.stringify(e));

  const byKey = new Map<string, Record<string, unknown>>();
  const order: string[] = [];
  for (const e of oursArr) {
    const k = keyOf(e);
    byKey.set(k, e);
    order.push(k);
  }
  for (const e of theirsArr) {
    const k = keyOf(e);
    const existing = byKey.get(k);
    if (!existing) {
      byKey.set(k, e);
      order.push(k);
      continue;
    }
    const mergedEntry: Record<string, unknown> = { ...existing };
    for (const field of ['features', 'tasks', 'changelog']) {
      mergedEntry[field] = unionArrayValues(existing[field], e[field]);
    }
    for (const field of ['date', 'summary', 'status', 'breaking']) {
      const a = existing[field];
      mergedEntry[field] = a === undefined || a === '' || a === null ? e[field] : a;
    }
    byKey.set(k, mergedEntry);
  }
  const merged = order.map((k) => byKey.get(k)!);
  return { merged: `${JSON.stringify(merged, null, 2)}\n` };
}

function unionArrayValues(a: unknown, b: unknown): unknown[] {
  const arrA = Array.isArray(a) ? a : [];
  const arrB = Array.isArray(b) ? b : [];
  const seen = new Set(arrA.map((x) => JSON.stringify(x)));
  return [...arrA, ...arrB.filter((x) => !seen.has(JSON.stringify(x)))];
}

// ─── state/.config.json — roster/pack/platform union, peopleIdentity union ─

export function mergeConfigJson(_base: string, ours: string, theirs: string): { merged: string } {
  const o = parseJsonObject(ours);
  const t = parseJsonObject(theirs);
  const merged: Record<string, unknown> = { ...t, ...o };
  merged.people = unionStringArray(o.people, t.people);
  merged.packs = unionStringArray(o.packs, t.packs);
  merged.platforms = unionStringArray(o.platforms, t.platforms);
  const oIdentity = o.peopleIdentity && typeof o.peopleIdentity === 'object' ? (o.peopleIdentity as Record<string, unknown>) : {};
  const tIdentity = t.peopleIdentity && typeof t.peopleIdentity === 'object' ? (t.peopleIdentity as Record<string, unknown>) : {};
  merged.peopleIdentity = { ...tIdentity, ...oIdentity };
  return { merged: `${JSON.stringify(merged, null, 2)}\n` };
}

// ─── core/taxonomy.json — union tag entries per facet ───────────────────────

export function mergeTaxonomyJson(_base: string, ours: string, theirs: string): { merged: string } {
  const o = parseJsonObject(ours);
  const t = parseJsonObject(theirs);
  const merged: Record<string, unknown> = { ...t, ...o };
  const oFacets = o.facets && typeof o.facets === 'object' ? (o.facets as Record<string, unknown>) : {};
  const tFacets = t.facets && typeof t.facets === 'object' ? (t.facets as Record<string, unknown>) : {};
  const facetKeys = new Set([...Object.keys(oFacets), ...Object.keys(tFacets)]);
  const mergedFacets: Record<string, string[]> = {};
  for (const key of facetKeys) {
    mergedFacets[key] = unionStringArray(oFacets[key], tFacets[key]);
  }
  merged.facets = mergedFacets;
  return { merged: `${JSON.stringify(merged, null, 2)}\n` };
}

// ─── state/.tasks-map.json — lossless union by remoteId, keyed on dcId (#204) ─

/**
 * The committed slug↔remoteId ledger deliberately syncs via git in full-repo
 * mode (brain-repo.ts) but had no merge class — a two-machine conflict on it
 * fell through to `mergeMarkdownDoc` (prose merge), which either mangled the
 * JSON or deferred it to the agent, leaving conflict markers in a file
 * `sync-state.ts` must be able to parse on every run. `unionTaskMap` (the
 * shared, tested primitive in `task-backend/sync-state.ts`) does the real
 * work; this just parses both sides and re-serializes.
 */
function parseTaskMapSide(content: string): TaskMapEntry[] {
  try {
    const parsed = JSON.parse(content || '[]');
    return Array.isArray(parsed) ? (parsed as TaskMapEntry[]) : [];
  } catch {
    return [];
  }
}

export function mergeTasksMapJson(_base: string, ours: string, theirs: string): { merged: string } {
  const merged = unionTaskMap([parseTaskMapSide(ours), parseTaskMapSide(theirs)]);
  return { merged: `${JSON.stringify(merged, null, 2)}\n` };
}

// ─── state/*.md (tasks) — furthest status wins + changelog union + body merge

const STATUS_ORDER = ['todo', 'in_progress', 'in_review', 'completed'];

function furthestStatus(a: unknown, b: unknown): unknown {
  const as = typeof a === 'string' ? a : undefined;
  const bs = typeof b === 'string' ? b : undefined;
  const ai = as ? STATUS_ORDER.indexOf(as) : -1;
  const bi = bs ? STATUS_ORDER.indexOf(bs) : -1;
  if (bi > ai) return bs;
  return as ?? bs;
}

function extractChangelogEntries(body: string): string[] {
  const sections = splitSections(body);
  const cl = sections.find((s) => s.name.toLowerCase() === 'changelog');
  if (!cl) return [];
  const lines = cl.content.split('\n');
  const entries: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (/^###\s+/.test(line)) {
      if (current.some((l) => l.trim())) entries.push(current.join('\n').trim());
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.some((l) => l.trim())) entries.push(current.join('\n').trim());
  return entries.filter((e) => e.length > 0);
}

function renderChangelogEntries(entries: string[]): string {
  return entries.length > 0 ? `\n${entries.join('\n\n')}\n` : '\n';
}

export function mergeTaskMd(
  base: string,
  ours: string,
  theirs: string,
): {
  merged: string;
  /**
   * Set ONLY on an add/add of two DISTINCT tasks (no common ancestor AND
   * differing `id:` dcId) — two people independently created a task under the
   * same name-derived slug. `merged` keeps the smaller-dcId side's raw text
   * verbatim at the original path; `sibling.content` is the other side's raw
   * text verbatim, for the caller to materialize at a re-slugged path. Smaller
   * dcId wins the bare slug so this agrees, by construction, with
   * `unionTaskMap`'s pass-2 collision walk (also dcId-ascending) — the map's
   * bare-slug winner and this file's keeper are always the same task, with no
   * cross-file lookup needed. `null` on every ordinary same-task merge.
   */
  sibling?: { content: string } | null;
} {
  const baseParsed = matter(base || '---\n---\n');
  const oursParsed = matter(ours || '---\n---\n');
  const theirsParsed = matter(theirs || '---\n---\n');

  const oursId = typeof oursParsed.data?.id === 'string' ? oursParsed.data.id : undefined;
  const theirsId = typeof theirsParsed.data?.id === 'string' ? theirsParsed.data.id : undefined;

  if (base.trim() === '' && oursId && theirsId && oursId !== theirsId) {
    const [keeper, sibling] = oursId < theirsId ? [ours, theirs] : [theirs, ours];
    return { merged: keeper, sibling: { content: sibling } };
  }

  const winnerStatus = furthestStatus(oursParsed.data?.status, theirsParsed.data?.status);

  const oursEntries = extractChangelogEntries(oursParsed.content);
  const theirsEntries = extractChangelogEntries(theirsParsed.content);
  const unioned = unionChangelog(oursEntries, theirsEntries);

  const bodyMerge = merge3Bodies(baseParsed.content, oursParsed.content, theirsParsed.content);
  const sections: SectionBlock[] = splitSections(bodyMerge.merged);
  const clIdx = sections.findIndex((s) => s.name.toLowerCase() === 'changelog');
  const clContent = renderChangelogEntries(unioned);
  if (clIdx >= 0) sections[clIdx] = { ...sections[clIdx], content: clContent };
  else sections.push({ name: 'Changelog', content: clContent });
  const mergedBody = joinSections(sections);

  const mergedData: Record<string, unknown> = {
    ...theirsParsed.data,
    ...oursParsed.data,
    ...(winnerStatus !== undefined ? { status: winnerStatus } : {}),
  };
  const merged = matter.stringify(mergedBody, mergedData);
  return { merged, sibling: null };
}

// ─── knowledge/** (incl. knowledge/features/**) and anything unclassified ──

/**
 * `merge3Bodies` (merge.ts:68) is remote-always-wins and never fails: on an
 * overlap it records `conflictSections` and silently returns the remote body.
 * When BOTH sides genuinely diverged (`conflictSections.length > 0`) the CLI
 * MUST discard that remote-wins output (`merged: null`) — writing it would
 * silently clobber the local author's prose. The report snapshots (base/ours/
 * theirs) are the agent's authoritative inputs instead. A clean union
 * (`conflictSections.length === 0`) is safe to write directly.
 */
export function mergeMarkdownDoc(base: string, ours: string, theirs: string): { merged: string | null; needsAgent: boolean } {
  const result = merge3Bodies(base, ours, theirs);
  if (result.conflictSections.length > 0) return { merged: null, needsAgent: true };
  return { merged: result.merged, needsAgent: false };
}

// ─── Orchestration over a real merge conflict set ───────────────────────────

export interface MergeResult {
  /** Paths resolved deterministically by the CLI and staged. */
  resolved: string[];
  /** Paths whose conflict needs a semantic prose merge by an agent — left unstaged, conflict markers intact. */
  deferredToAgent: { path: string; class: MergeClass }[];
  /**
   * full-repo only: real code/non-brain files whose conflict must go to the
   * HUMAN (their editor), never to the prose agent or a semantic merge. Left
   * untouched in the tree with git's native conflict markers.
   */
  deferredToHuman: { path: string; class: MergeClass }[];
}

export interface ResolveConflictsOptions {
  /**
   * full-repo mode: the WHOLE project is the synced unit, so a conflicted path
   * NOT under `_dream_context/` is real code — classify it as `code` and defer
   * it to the human instead of ever running the markdown/prose merge on it.
   */
  fullRepo?: boolean;
}

/** True for a conflicted path that is a real project/code file in full-repo mode (not a brain file). */
function isCodePath(relPath: string, opts: ResolveConflictsOptions): boolean {
  if (!opts.fullRepo) return false;
  const norm = relPath.replace(/\\/g, '/');
  return !norm.startsWith('_dream_context/');
}

/**
 * Next free `<slug>-2.md`, `<slug>-3.md`, … path for an add/add task-md split
 * (`mergeTaskMd`'s `sibling`), in the SAME directory as the original conflicted
 * path (preserving whichever prefix mode — in-tree `_dream_context/` or not —
 * `relPath` already carries). `existsSync` sees a sibling this same
 * `resolveConflicts` pass already wrote, so the suffix a colliding family gets
 * depends only on how many earlier-processed families wrote to this directory
 * — deterministic as long as task-md conflicts are processed in a fixed order
 * (see `reorderTaskMdFirst` below), never on the caller's input order.
 */
function reslugSiblingPath(cwd: string, relPath: string): string {
  const dir = dirname(relPath);
  const base = basename(relPath, '.md');
  let n = 2;
  let candidate = `${dir}/${base}-${n}.md`;
  while (existsSync(join(cwd, candidate))) {
    n += 1;
    candidate = `${dir}/${base}-${n}.md`;
  }
  return candidate;
}

/**
 * Reorder so every `task-md` conflict is processed in ascending path order,
 * regardless of the order the caller's `conflicts` array happened to list
 * them in. Needed because `reslugSiblingPath` decides a colliding family's `-N`
 * suffix by disk state accumulated DURING this pass (#204 determinism nit) —
 * without a fixed processing order, shuffling the input could hand two
 * different families different suffixes across otherwise-identical runs.
 * Every other class is insensitive to order, so only the task-md slots are
 * reassigned; non-task-md paths keep their original position untouched.
 */
function reorderTaskMdFirst(conflicts: string[], opts: ResolveConflictsOptions): string[] {
  const isTaskMdPath = (p: string) => !isCodePath(p, opts) && classifyPath(p) === 'task-md';
  const sortedTaskMd = conflicts.filter(isTaskMdPath).slice().sort((a, b) => a.localeCompare(b));
  let i = 0;
  return conflicts.map((p) => (isTaskMdPath(p) ? sortedTaskMd[i++] : p));
}

/**
 * Resolve every conflicted path from an in-progress `git merge`. Deterministic
 * classes are merged, written, and `git add`ed (resolved). `knowledge-md` /
 * `feature-md` / `other` classes that need an agent are left untouched in the
 * working tree (conflict markers intact, NOT staged) so the caller can either
 * leave the merge in progress (auto mode → `--continue` later) or `abortMerge`
 * back to a clean tree (pull-only mode). In full-repo mode, a conflicted CODE
 * file (anything outside `_dream_context/`) is classified `code` and deferred to
 * the HUMAN — never merged, never sent to the prose agent (mangling/silent loss
 * of source is unacceptable).
 */
export function resolveConflicts(cwd: string, conflicts: string[], opts: ResolveConflictsOptions = {}): MergeResult {
  const resolved: string[] = [];
  const deferredToAgent: { path: string; class: MergeClass }[] = [];
  const deferredToHuman: { path: string; class: MergeClass }[] = [];

  for (const relPath of reorderTaskMdFirst(conflicts, opts)) {
    // A real code file in full-repo mode never touches the semantic merge — it
    // stays exactly as git left it (native conflict markers) for the human.
    if (isCodePath(relPath, opts)) {
      deferredToHuman.push({ path: relPath, class: 'code' });
      continue;
    }
    const cls = classifyPath(relPath);
    const { base, ours, theirs } = readOursTheirsBase(cwd, relPath);
    let mergedContent: string | null = null;

    switch (cls) {
      case 'changelog-json':
        mergedContent = mergeChangelogJson(base, ours, theirs).merged;
        break;
      case 'releases-json':
        mergedContent = mergeReleasesJson(base, ours, theirs).merged;
        break;
      case 'config-json':
        mergedContent = mergeConfigJson(base, ours, theirs).merged;
        break;
      case 'taxonomy-json':
        mergedContent = mergeTaxonomyJson(base, ours, theirs).merged;
        break;
      case 'tasks-map-json':
        mergedContent = mergeTasksMapJson(base, ours, theirs).merged;
        break;
      case 'task-md': {
        const taskResult = mergeTaskMd(base, ours, theirs);
        mergedContent = taskResult.merged;
        if (taskResult.sibling) {
          const siblingPath = reslugSiblingPath(cwd, relPath);
          writeFileSync(join(cwd, siblingPath), taskResult.sibling.content, 'utf-8');
          addPath(cwd, siblingPath);
          resolved.push(siblingPath);
        }
        break;
      }
      case 'knowledge-md':
      case 'feature-md':
      case 'other': {
        const doc = mergeMarkdownDoc(base, ours, theirs);
        if (doc.needsAgent) {
          deferredToAgent.push({ path: relPath, class: cls });
          continue;
        }
        mergedContent = doc.merged;
        break;
      }
    }

    if (mergedContent !== null) {
      writeFileSync(join(cwd, relPath), mergedContent, 'utf-8');
      addPath(cwd, relPath);
      resolved.push(relPath);
    }
  }

  return { resolved, deferredToAgent, deferredToHuman };
}
