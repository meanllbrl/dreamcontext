import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import {
  merge3Bodies,
  unionChangelog,
  splitSections,
  joinSections,
  type SectionBlock,
} from '../task-backend/merge.js';
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
  | 'task-md'
  | 'knowledge-md'
  | 'feature-md'
  | 'taxonomy-json'
  | 'other';

/** Classify a conflicted path (as reported by git — may carry an `_dream_context/` prefix in in-tree mode). */
export function classifyPath(relPath: string): MergeClass {
  const norm = relPath.replace(/\\/g, '/').replace(/^_dream_context\//, '');
  if (norm === 'core/CHANGELOG.json') return 'changelog-json';
  if (norm === 'core/RELEASES.json') return 'releases-json';
  if (norm === 'state/.config.json') return 'config-json';
  if (norm === 'core/taxonomy.json') return 'taxonomy-json';
  if (/^state\/[^/]+\.md$/.test(norm)) return 'task-md';
  if (/^core\/features\//.test(norm)) return 'feature-md';
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

export function mergeTaskMd(base: string, ours: string, theirs: string): { merged: string } {
  const baseParsed = matter(base || '---\n---\n');
  const oursParsed = matter(ours || '---\n---\n');
  const theirsParsed = matter(theirs || '---\n---\n');

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
  return { merged };
}

// ─── knowledge/**, core/features/** (and anything unclassified) ────────────

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
}

/**
 * Resolve every conflicted path from an in-progress `git merge`. Deterministic
 * classes are merged, written, and `git add`ed (resolved). `knowledge-md` /
 * `feature-md` / `other` classes that need an agent are left untouched in the
 * working tree (conflict markers intact, NOT staged) so the caller can either
 * leave the merge in progress (auto mode → `--continue` later) or `abortMerge`
 * back to a clean tree (pull-only mode).
 */
export function resolveConflicts(cwd: string, conflicts: string[]): MergeResult {
  const resolved: string[] = [];
  const deferredToAgent: { path: string; class: MergeClass }[] = [];

  for (const relPath of conflicts) {
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
      case 'task-md':
        mergedContent = mergeTaskMd(base, ours, theirs).merged;
        break;
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

  return { resolved, deferredToAgent };
}
