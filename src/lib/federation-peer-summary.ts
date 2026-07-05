import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import fg from 'fast-glob';
import { readFrontmatter } from './frontmatter.js';
import { readJsonArray } from './json-file.js';
import { listVaults, resolveVaultContextRoot } from './vaults.js';
import { resolveConnectedVaults, currentVaultTarget } from './federation-recall.js';

/**
 * Ambient cross-project READ awareness (federation-awareness).
 *
 * This module produces a COMPACT, glance-sized summary of every peer the current
 * vault can READ — what each peer IS and what was last done there — and persists
 * it to a LOCAL cache file (`state/.peer-summaries.json`). The snapshot hot path
 * reads ONLY that cache (a single local file read); it NEVER resolves or reads a
 * peer vault. The cache is refreshed off the hot path: by `dreamcontext
 * federation peers`, by the sleep-federation cycle, and right after a
 * connect/disconnect.
 *
 * READ model (same as recall): peer B is readable from current vault A iff
 *   A→B connection direction is out/both AND not stale AND B has shareable:true.
 * `resolveConnectedVaults` already applies exactly that gate (out/both ∩ not
 * stale ∩ shareable), so we reuse it as the single source of truth.
 */

/** One peer's compact, glance-sized summary. Persisted in the cache file. */
export interface PeerSummary {
  /** Registered name of the peer vault. */
  vault: string;
  /** One-line "what it is" (peer soul/purpose or memory headline). May be ''. */
  whatItIs: string;
  /** Latest 1-2 changelog headlines (with dates). May be empty. */
  lastActivity: string[];
  /** Title of an in_progress/active task in the peer, if any. May be ''. */
  activeTask: string;
  /** A few top tags across the peer's knowledge (features live under
   *  knowledge/features/ now; `core/features/` is scanned too for back-compat
   *  with un-migrated peers). May be empty. */
  topTags: string[];
}

/** Shape persisted to `<contextRoot>/state/.peer-summaries.json`. */
export interface PeerSummaryCache {
  /** ISO timestamp the cache was generated. */
  generatedAt: string;
  peers: PeerSummary[];
}

const CACHE_REL_PATH = 'state/.peer-summaries.json';

/** Max changelog headlines kept per peer (a glance, not a dump). */
const MAX_ACTIVITY = 2;
/** Max tags kept per peer. */
const MAX_TAGS = 5;
/** Char cap on the one-line "what it is" so the snapshot stays compact. */
const WHAT_IT_IS_CHARS = 200;

/** Absolute path to a context root's peer-summary cache file. */
export function peerSummaryCachePath(contextRoot: string): string {
  return join(contextRoot, CACHE_REL_PATH);
}

/**
 * Cheap, synchronous read of the peer-summary cache. Returns `null` when the
 * file is absent or corrupt. NEVER throws — this is the ONLY thing the snapshot
 * hot path is allowed to call, and it must never resolve a peer.
 */
export function readPeerSummaryCache(contextRoot: string): PeerSummaryCache | null {
  const path = peerSummaryCachePath(contextRoot);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<PeerSummaryCache>;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.peers)) return null;
    const peers = (parsed.peers as unknown[])
      .filter((p): p is Record<string, unknown> => p !== null && typeof p === 'object')
      .map(sanitizePeer);
    return {
      generatedAt: typeof parsed.generatedAt === 'string' ? parsed.generatedAt : '',
      peers,
    };
  } catch {
    return null;
  }
}

/** Coerce one raw cache entry into a well-typed {@link PeerSummary}. */
function sanitizePeer(raw: Record<string, unknown>): PeerSummary {
  const strArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  return {
    vault: typeof raw.vault === 'string' ? raw.vault : '',
    whatItIs: typeof raw.whatItIs === 'string' ? raw.whatItIs : '',
    lastActivity: strArr(raw.lastActivity),
    activeTask: typeof raw.activeTask === 'string' ? raw.activeTask : '',
    topTags: strArr(raw.topTags),
  };
}

/**
 * Build a COMPACT summary of ONE peer by reading its core files directly —
 * strictly READ-ONLY on `peerRoot` (a `_dream_context/` directory). Never throws:
 * any unreadable part is simply omitted. This is a glance (a handful of lines),
 * not a corpus build — it reads soul + CHANGELOG.json + state tasks + knowledge
 * frontmatter, nothing heavier.
 */
export function buildPeerSummary(peerRoot: string, peerName: string): PeerSummary {
  return {
    vault: peerName,
    whatItIs: readWhatItIs(peerRoot),
    lastActivity: readLastActivity(peerRoot),
    activeTask: readActiveTask(peerRoot),
    topTags: readTopTags(peerRoot),
  };
}

/** One-line "what it is": first real prose line of the peer soul (or ''). */
function readWhatItIs(peerRoot: string): string {
  const soulPath = join(peerRoot, 'core', '0.soul.md');
  if (!existsSync(soulPath)) return '';
  try {
    const { data, content } = readFrontmatter(soulPath);
    const name = typeof data.name === 'string' ? data.name : '';
    const line = content
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#') && !l.startsWith('>') && !l.startsWith('<!--') && !l.startsWith('---'));
    let text = line ?? '';
    // Prefix the soul `name` only if it isn't already how the line opens.
    if (name && text && !text.toLowerCase().startsWith(name.toLowerCase())) {
      text = `${name}: ${text}`;
    } else if (name && !text) {
      text = name;
    }
    return text.length > WHAT_IT_IS_CHARS ? text.slice(0, WHAT_IT_IS_CHARS - 1).trimEnd() + '…' : text;
  } catch {
    return '';
  }
}

/** Latest 1-2 changelog headlines (with dates) from the peer CHANGELOG.json. */
function readLastActivity(peerRoot: string): string[] {
  const path = join(peerRoot, 'core', 'CHANGELOG.json');
  if (!existsSync(path)) return [];
  try {
    const entries = readJsonArray<Record<string, unknown>>(path);
    const out: string[] = [];
    for (const e of entries.slice(0, MAX_ACTIVITY)) {
      const date = String(e.date ?? '');
      const summary = typeof e.summary === 'string' ? e.summary : '';
      const desc = String(e.description ?? '');
      const headline = summary || (desc.length > 120 ? desc.slice(0, 117) + '...' : desc);
      if (!headline) continue;
      out.push(date ? `${date} — ${headline}` : headline);
    }
    return out;
  } catch {
    return [];
  }
}

/** Title of an in_progress/active task in the peer (most recent), or ''. */
function readActiveTask(peerRoot: string): string {
  const stateDir = join(peerRoot, 'state');
  if (!existsSync(stateDir)) return '';
  let files: string[];
  try {
    files = fg.sync('*.md', { cwd: stateDir, absolute: true });
  } catch {
    return '';
  }
  let best = '';
  let bestDate = '';
  for (const file of files) {
    try {
      const { data } = readFrontmatter(file);
      const status = String(data.status ?? '');
      if (status !== 'in_progress' && status !== 'active') continue;
      const title = String(data.name ?? data.title ?? '').trim();
      if (!title) continue;
      const updated = String(data.updated_at ?? data.created_at ?? '');
      if (!best || updated.localeCompare(bestDate) > 0) {
        best = title;
        bestDate = updated;
      }
    } catch {
      // skip unreadable
    }
  }
  return best;
}

/** A few most-common tags across the peer's knowledge + feature frontmatter. */
function readTopTags(peerRoot: string): string[] {
  const counts = new Map<string, number>();
  const dirs = [join(peerRoot, 'knowledge'), join(peerRoot, 'core', 'features')];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let files: string[];
    try {
      files = fg.sync('*.md', { cwd: dir, absolute: true });
    } catch {
      continue;
    }
    for (const file of files) {
      try {
        const { data } = readFrontmatter(file);
        if (!Array.isArray(data.tags)) continue;
        for (const tag of data.tags) {
          const t = String(tag).trim();
          if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
        }
      } catch {
        // skip unreadable
      }
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_TAGS)
    .map(([t]) => t);
}

/**
 * Resolve every readable peer, build each one's summary, and WRITE the cache to
 * `<contextRoot>/state/.peer-summaries.json`. This is the REAL peer-read path —
 * it is off the snapshot hot path (called by `federation peers`, the sleep
 * cycle, and connect/disconnect). NEVER throws per peer: a dead/stale/unreadable
 * peer is skipped and the others continue (never-throw registry contract).
 *
 * Returns the freshly-built summaries.
 */
export function refreshPeerSummaries(contextRoot: string, home?: string): PeerSummary[] {
  const { name, target } = currentVaultTarget(dirname(contextRoot), home);
  // resolveConnectedVaults applies the READ gate: out/both ∩ not-stale ∩ shareable,
  // current vault first. Drop the current vault — it is not a "peer".
  const targets = resolveConnectedVaults(target, contextRoot, home).filter(
    (t) => t.current !== true && t.name !== name,
  );

  const vaults = listVaults(home);
  const peers: PeerSummary[] = [];
  for (const t of targets) {
    try {
      const peerRoot = resolveVaultContextRoot(t.name, home);
      const label = t.label ?? t.name;
      // Prefer a registered display name for the label.
      const registered = vaults.find((v) => v.name === t.name);
      peers.push(buildPeerSummary(peerRoot, registered?.name ?? label));
    } catch {
      // Dead/stale peer — skip, keep going (never break the others).
    }
  }

  writePeerSummaryCache(contextRoot, { generatedAt: new Date().toISOString(), peers });
  return peers;
}

/** Write the peer-summary cache with pretty JSON + trailing newline. */
function writePeerSummaryCache(contextRoot: string, cache: PeerSummaryCache): void {
  const path = peerSummaryCachePath(contextRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cache, null, 2) + '\n', 'utf-8');
}
