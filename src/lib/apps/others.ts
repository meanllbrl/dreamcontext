/**
 * What the Apps page shows beside this Mac's registered apps (plan-veri r3, K5; app-veri-ortak r6, K9):
 *  - TEAM DATA: `_dream_context/apps/<slug>/` with TRACKED files (`git ls-files`) and no app
 *    registered here: a teammate's app whose hand-made data (emekle üretilmiş veri) came with the
 *    brain. "Takımın app'i · verisi bu beyinde (N dosya)"; the title from its knowledge note.
 *  - a TEAM NOTE: `knowledge/apps/<x>.md` with `app: <slug>` that no app here is registered as.
 *    A teammate's app: its knowledge came with the brain, its data and code did not.
 *  - ORPHAN DATA: `_dream_context/apps/<slug>/` with no app registered and nothing tracked: a
 *    removed app's data.
 * Read-only, lstat + realpath contained, slugs through APP_SLUG_RE, titles plain text.
 *
 * Also the one read of an app's team-data state for every surface ({@link appDataStatus}: the
 * Apps page, `dc.data.status()`, `apps data`): it asks `sharedSet` (data-share.ts) and nothing
 * else decides what is shared.
 */

import { lstatSync, readdirSync, readFileSync, realpathSync, type Stats } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { APP_SLUG_RE } from './bundle.js';
import { appDataDir, appsDataRoot, checkAppDataChain, contextRootOf } from './data-dir.js';
import { readManifest } from './manifest.js';
import { declMatches, sharedSet, type DataDecl, type DataMode, type Held, type HeldReason } from './data-share.js';
import { readConsent, type Consent } from './data-consent.js';
import { listConflicts } from './data-conflicts.js';
import { listApps, type AppRecord } from './registry.js';
import * as git from '../git-sync/git.js';
import { brainPrefix } from '../agents/agent-sync.js';

export type AppOther =
  | { kind: 'team-data'; slug: string; title: string; files: number; dataPath: string; knowledgeId: string | null }
  | { kind: 'team-note'; slug: string; title: string; note: string; knowledgeId: string }
  | { kind: 'orphan-data'; slug: string; dataPath: string };

const MAX_NOTES = 200;

function realInside(root: string, p: string): boolean {
  try {
    const r = relative(realpathSync.native(root), realpathSync.native(p));
    return r !== '' && !r.startsWith('..') && !isAbsolute(r);
  } catch { return false; }
}

function plain(v: unknown, max: number): string {
  // eslint-disable-next-line no-control-regex
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f<>`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function frontmatter(text: string): Record<string, unknown> | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  try { const v = parseYaml(m[1]) as unknown; return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null; } catch { return null; }
}

/** `apps/` prefix of this brain inside its git repo (`_dream_context/apps/`), or null. */
export function appsGitPrefix(projectRoot: string): string | null {
  try {
    if (!git.isGitRepo(projectRoot)) return null;
    const p = brainPrefix(projectRoot, contextRootOf(projectRoot));
    return p === null ? null : `${p}apps/`;
  } catch { return null; }
}

/**
 * Tracked files under `apps/`, per slug, as data-folder-relative paths. Empty when there is no
 * git or git cannot answer (then nothing reads as a teammate's).
 */
export function trackedAppFiles(projectRoot: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const prefix = appsGitPrefix(projectRoot);
  if (prefix === null) return out;
  let paths: string[];
  try { paths = git.indexPaths(projectRoot, [prefix]); } catch { return out; }
  for (const p of paths) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const i = rest.indexOf('/');
    if (i <= 0) continue;
    const slug = rest.slice(0, i);
    if (!APP_SLUG_RE.test(slug)) continue;
    const list = out.get(slug) ?? [];
    list.push(rest.slice(i + 1));
    out.set(slug, list);
  }
  return out;
}

interface Note { slug: string; title: string; name: string }

function readNotes(contextRoot: string): Note[] {
  const noteDir = join(contextRoot, 'knowledge', 'apps');
  const out: Note[] = [];
  let names: string[] = [];
  try { names = readdirSync(noteDir).filter((n) => n.endsWith('.md')).sort().slice(0, MAX_NOTES); } catch { /* none */ }
  for (const name of names) {
    const p = join(noteDir, name);
    try {
      const st = lstatSync(p);
      if (st.isSymbolicLink() || !st.isFile() || st.size > 64 * 1024 || !realInside(contextRoot, p)) continue;
      const fm = frontmatter(readFileSync(p, 'utf-8'));
      const slug = typeof fm?.app === 'string' ? fm.app : '';
      if (!APP_SLUG_RE.test(slug) || out.some((n) => n.slug === slug)) continue;
      out.push({ slug, title: plain(fm?.title, 80) || plain(fm?.name, 80) || slug, name });
    } catch { /* unreadable: not listed */ }
  }
  return out;
}

export function appOthers(projectRoot: string, registered: ReadonlySet<string>, opts: { tracked?: Map<string, string[]> } = {}): AppOther[] {
  const contextRoot = contextRootOf(projectRoot);
  const out: AppOther[] = [];
  const notes = readNotes(contextRoot);
  const tracked = opts.tracked ?? trackedAppFiles(projectRoot);
  const dataRoot = appsDataRoot(projectRoot);
  const teamSlugs = new Set<string>();
  // Team data first: a teammate's app whose data is in this brain (one row, never also orphan).
  for (const [slug, files] of [...tracked.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (registered.has(slug) || !files.length) continue;
    const note = notes.find((n) => n.slug === slug);
    teamSlugs.add(slug);
    out.push({ kind: 'team-data', slug, title: note?.title ?? slug, files: files.length, dataPath: `_dream_context/apps/${slug}`, knowledgeId: note ? `apps/${note.name.slice(0, -3)}` : null });
  }
  for (const n of notes) {
    if (registered.has(n.slug) || teamSlugs.has(n.slug)) continue;
    out.push({ kind: 'team-note', slug: n.slug, title: n.title, note: `_dream_context/knowledge/apps/${n.name}`, knowledgeId: `apps/${n.name.slice(0, -3)}` });
  }
  let dirs: string[] = [];
  try { dirs = readdirSync(dataRoot).sort(); } catch { /* none */ }
  for (const slug of dirs) {
    if (!APP_SLUG_RE.test(slug) || registered.has(slug) || teamSlugs.has(slug)) continue;
    const p = join(dataRoot, slug);
    try {
      const st = lstatSync(p);
      if (st.isSymbolicLink() || !st.isDirectory() || !realInside(contextRoot, p)) continue;
      out.push({ kind: 'orphan-data', slug, dataPath: `_dream_context/apps/${slug}` });
    } catch { /* gone */ }
  }
  return out;
}

// ─── one app's team-data state (K8, K9, K10) ─────────────────────────────────────────

/** Every non-folder entry under `dir`, relative and `/`-separated; links listed, never followed. */
export function listDataFiles(dir: string, max = 10_000): { rel: string; st: Stats }[] {
  const out: { rel: string; st: Stats }[] = [];
  let seen = 0;
  const walk = (d: string, prefix: string, depth: number): void => {
    let names: string[];
    try { names = readdirSync(d).sort(); } catch { return; }
    for (const name of names) {
      if (++seen > max) return;
      const abs = join(d, name);
      let st: Stats;
      try { st = lstatSync(abs); } catch { continue; }
      const rel = prefix + name;
      if (st.isDirectory()) { if (depth < 12) walk(abs, `${rel}/`, depth + 1); continue; }
      out.push({ rel, st });
    }
  };
  walk(dir, '', 1);
  return out;
}

export interface DataPathView { path: string; why: string; files: number; bytes: number; state: 'approved' | 'pending' | 'excluded' | 'declined' }

export interface AppDataStatus {
  mode: DataMode;
  decl: DataDecl | null;
  consent: Consent | null;
  /** Data-folder-relative files that go to the team now. */
  shared: string[];
  sharedBytes: number;
  held: Held[];
  /** Declared shared paths still awaiting the owner. */
  pending: string[];
  /** Every declared shared path with what it resolves to on disk now. */
  sharedPaths: DataPathView[];
  localPaths: { path: string; why: string }[];
  /** Tracked shared files not on this Mac's disk (absence is never a delete, K6). */
  missing: number;
  /** Paths with two versions (the conflict store's `conflict` entries). */
  conflicts: number;
  /** The data folder, or null when the chain is not safe. */
  dataDir: string | null;
}

function dataDirOf(rec: AppRecord): string | null {
  try {
    if (!checkAppDataChain(rec.projectRoot, rec.slug).ok) return null;
    return appDataDir(rec.projectRoot, rec.slug);
  } catch { return null; }
}

/** The bytes the other apps of this brain share now (the brain-wide 100 MB total). */
function otherAppsBytes(home: string, rec: AppRecord): number {
  let n = 0;
  for (const other of listApps(home, rec.projectRoot)) {
    if (other.hash === rec.hash) continue;
    try {
      const m = readManifest(other.root);
      if (!m.ok || !m.manifest.data) continue;
      n += sharedSet({ projectRoot: other.projectRoot, home }, other, m.manifest.data, readConsent(home, other.hash)).bytes;
    } catch { /* not counted */ }
  }
  return n;
}

/**
 * One app's team data as this Mac sees it now. `opts.tracked` = the brain's tracked files of this
 * app (defaults to asking git). Never throws: an unreadable manifest reads as undecided.
 */
export function appDataStatus(home: string, rec: AppRecord, opts: { tracked?: string[]; mode?: { fullRepo: boolean; cloudSyncOn: boolean }; nowMs?: number } = {}): AppDataStatus {
  const m = readManifest(rec.root);
  const decl = m.ok ? m.manifest.data : null;
  const consent = readConsent(home, rec.hash);
  const dir = dataDirOf(rec);
  const set = sharedSet({ projectRoot: rec.projectRoot, home }, rec, decl, consent, {
    ...(opts.mode ? { mode: opts.mode } : {}),
    ...(opts.nowMs !== undefined ? { nowMs: opts.nowMs } : {}),
    otherAppsSharedBytes: otherAppsBytes(home, rec),
  });
  const files = dir ? listDataFiles(dir) : [];
  const excluded = consent?.excluded ?? [];
  const approved = consent?.approved ?? [];
  const sharedPaths: DataPathView[] = (decl?.shared ?? []).map((e) => {
    const hit = files.filter((f) => declMatches(e.path, f.rel) && !(decl?.local ?? []).some((l) => declMatches(l.path, f.rel)));
    const state: DataPathView['state'] = excluded.includes(e.path) ? 'excluded' : consent?.declined ? 'declined' : approved.includes(e.path) ? 'approved' : 'pending';
    return { path: e.path, why: e.why, files: hit.length, bytes: hit.reduce((s, f) => s + f.st.size, 0), state };
  });
  const tracked = opts.tracked ?? trackedAppFiles(rec.projectRoot).get(rec.slug) ?? [];
  const onDisk = new Set(files.map((f) => f.rel));
  let conflicts = 0;
  try { conflicts = listConflicts(home, rec.hash).filter((c) => c.kind === 'conflict').length; } catch { /* none */ }
  return {
    mode: set.mode,
    decl,
    consent,
    shared: set.paths,
    sharedBytes: set.bytes,
    held: set.held,
    pending: set.pending,
    sharedPaths,
    localPaths: (decl?.local ?? []).map((e) => ({ path: e.path, why: e.why })),
    missing: tracked.filter((p) => !onDisk.has(p) && (decl?.shared ?? []).some((e) => declMatches(e.path, p))).length,
    conflicts,
    dataDir: dir,
  };
}

/** Held entries counted by reason (the Apps card shows counts, never content). */
export function heldCounts(held: readonly Held[]): Partial<Record<HeldReason, number>> {
  const out: Partial<Record<HeldReason, number>> = {};
  for (const h of held) out[h.reason] = (out[h.reason] ?? 0) + 1;
  return out;
}

/**
 * Is `relPath` a member of this app's live shared set by declaration (approved, not excluded,
 * not local, no decline)? The file gate (K4) is not asked: a delete of a tracked file needs only
 * membership.
 */
export function sharedMember(decl: DataDecl | null, consent: Consent | null, relPath: string): boolean {
  if (!decl || !consent || consent.declined) return false;
  if (consent.excluded.some((x) => declMatches(x, relPath))) return false;
  if (decl.local.some((x) => declMatches(x.path, relPath))) return false;
  return decl.shared.some((x) => declMatches(x.path, relPath) && consent.approved.includes(x.path));
}
