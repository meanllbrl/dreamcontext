import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { listVaults } from '../lib/vaults.js';
import { listAutomations, resolveAutomationPhoto } from '../lib/automations/store.js';
import { buildFeed } from '../lib/automations/feed.js';
import { plainPostText } from '../lib/automations/threads.js';
import { readMutedAutomations } from '../lib/assistant/notch-inbox.js';
import { agentActivities } from './automation-job.js';

/**
 * The automation half of the notch inbox: every registered project's agents, joined at read
 * time from what each project already keeps on disk.
 *
 *   running — every agent holding its run lock right now (`agentActivities`, the same truth
 *             the project's own channel draws "working" from), with its photo.
 *   posts   — every UNREAD message in each project's `#agents` feed that says something: an
 *             agent's post, a failed run's reason, or a run waiting on the owner. Unread is the
 *             project's own read watermark, so marking one seen here clears the channel's badge
 *             too, and an old unread post is still listed (owner: "even though it is from past").
 *             A muted agent (`notch-inbox.ts`) is left out.
 *
 * Cached per kind (RUNNING_TTL_MS, POSTS_TTL_MS): the notch polls every few seconds and a feed
 * read opens two weeks of thread files per agent. A seen / mute write drops the cache so the
 * row disappears on the next poll, not fifteen seconds later.
 *
 * Text here is PROJECT-AUTHORED; the route wraps it before it leaves the server.
 */

const RUNNING_TTL_MS = 4_000;
const POSTS_TTL_MS = 15_000;
/** How many of each project's newest feed messages are looked at for unread ones. */
const FEED_LIMIT = 40;
/** At most this many posts across every project (newest kept). */
const POSTS_CAP = 60;
const TEXT_CAP = 400;

export interface RunningAutomation {
  vault: string;
  slug: string;
  title: string;
  hasPhoto: boolean;
  /** When the turn holding the lock began, epoch ms. */
  since: number;
  runId: string | null;
}

export interface AutomationPost {
  /** `<vault>::<slug>::<runId>` — stable across polls. */
  key: string;
  vault: string;
  slug: string;
  title: string;
  hasPhoto: boolean;
  runId: string;
  at: string;
  status: string;
  textFrom: string;
  text: string;
  needsYou: boolean;
  /** What "seen" advances the watermark to. */
  newestId: string;
}

interface Cached<T> { at: number; value: T }
let runningCache: Cached<RunningAutomation[]> | null = null;
let postsCache: Cached<AutomationPost[]> | null = null;

/** Every registered project that has agents: name, project root, context root. */
function projectsWithAgents(): Array<{ vault: string; projectRoot: string; contextRoot: string }> {
  const out: Array<{ vault: string; projectRoot: string; contextRoot: string }> = [];
  for (const v of listVaults()) {
    const contextRoot = join(v.path, '_dream_context');
    if (!existsSync(join(contextRoot, 'automations'))) continue;
    out.push({ vault: v.name, projectRoot: v.path, contextRoot });
  }
  return out;
}

const clip = (s: string) => (s.length > TEXT_CAP ? `${s.slice(0, TEXT_CAP - 1).trimEnd()}…` : s);

export function runningAutomations(now = Date.now()): RunningAutomation[] {
  if (runningCache && now - runningCache.at < RUNNING_TTL_MS) return runningCache.value;
  const out: RunningAutomation[] = [];
  for (const p of projectsWithAgents()) {
    let manifests: ReturnType<typeof listAutomations> = [];
    try { manifests = listAutomations(p.contextRoot); } catch { continue; }
    if (!manifests.length) continue;
    let acts: ReturnType<typeof agentActivities> = {};
    try { acts = agentActivities(p.contextRoot, now); } catch { continue; }
    for (const [slug, a] of Object.entries(acts)) {
      const m = manifests.find((x) => x.slug === slug);
      if (!m) continue;
      out.push({
        vault: p.vault, slug, title: m.title, since: a.since, runId: a.runId,
        hasPhoto: resolveAutomationPhoto(p.contextRoot, m.photo) !== null,
      });
    }
  }
  out.sort((a, b) => b.since - a.since);
  runningCache = { at: now, value: out };
  return out;
}

export function unreadAutomationPosts(now = Date.now()): AutomationPost[] {
  if (postsCache && now - postsCache.at < POSTS_TTL_MS) return postsCache.value;
  const muted = readMutedAutomations();
  const out: AutomationPost[] = [];
  for (const p of projectsWithAgents()) {
    let feed: ReturnType<typeof buildFeed>;
    try { feed = buildFeed(p.contextRoot, { limit: FEED_LIMIT }); } catch { continue; }
    const mutedHere = new Set(muted[p.projectRoot] ?? muted[dirname(p.contextRoot)] ?? []);
    for (const m of feed.messages) {
      if (!m.unread || !m.newestId || mutedHere.has(m.slug)) continue;
      if (!(m.textFrom === 'post' || m.textFrom === 'error' || m.needsYou)) continue;
      out.push({
        key: `${p.vault}::${m.slug}::${m.runId}`,
        vault: p.vault, slug: m.slug, title: m.title, hasPhoto: m.hasPhoto, runId: m.runId,
        at: m.at, status: m.status, textFrom: m.textFrom,
        text: clip(m.question?.text ? plainPostText(m.question.text) : plainPostText(m.text)),
        needsYou: m.needsYou, newestId: m.newestId,
      });
    }
  }
  // Newest first, by the entry ids (they survive two machines' clocks; `at` may not).
  out.sort((a, b) => (a.newestId < b.newestId ? 1 : a.newestId > b.newestId ? -1 : 0));
  const value = out.slice(0, POSTS_CAP);
  postsCache = { at: now, value };
  return value;
}

/** A seen or mute write changed what the next read must say. */
export function invalidateAutomationInbox(): void {
  runningCache = null;
  postsCache = null;
}

/** The registered project `vault` that has agents, or null. */
export function automationProject(vault: string): { projectRoot: string; contextRoot: string } | null {
  const v = listVaults().find((x) => x.name === vault);
  if (!v) return null;
  return { projectRoot: v.path, contextRoot: join(v.path, '_dream_context') };
}
