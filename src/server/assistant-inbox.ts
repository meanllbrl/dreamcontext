import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { listVaults } from '../lib/vaults.js';
import { listAutomations, resolveAutomationPhoto } from '../lib/automations/store.js';
import { buildFeed } from '../lib/automations/feed.js';
import { plainPostText } from '../lib/automations/threads.js';
import { readMutedAutomations } from '../lib/assistant/notch-inbox.js';
import { agentActivities } from './automation-job.js';
import { listInboxRows } from '../lib/owner-inbox.js';
import { taskHeadOfRow } from '../lib/agents/task-starter.js';

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

/** Longer than the notch's 4 s inbox poll on purpose (task: the desktop app stays light on an
 *  8GB MacBook Air): a TTL equal to the poll missed on nearly every tick, so every poll walked
 *  every project's run locks. A run starting or ending shows within one TTL; a seen / mute
 *  write still drops the cache at once. Exported for its test. */
export const RUNNING_TTL_MS = 9_000;
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
        // Who is working: the teammate's name, the one the AI Team page lists it under.
        vault: p.vault, slug, title: m.agentTitle || m.title, since: a.since, runId: a.runId,
        hasPhoto: resolveAutomationPhoto(p.contextRoot, m.photo) !== null,
      });
    }
  }
  out.sort((a, b) => b.since - a.since);
  runningCache = { at: now, value: out };
  return out;
}

/** Who said it, as the AI Team page names it: the teammate, then the routine when one spoke
 *  for it ("Doctor · Daily check"); the agent's own turns are just the teammate. */
export function speakerTitle(agentTitle: string | null | undefined, title: string): string {
  const who = (agentTitle ?? '').trim();
  if (!who || who === title) return title;
  return `${who} · ${title}`;
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
        vault: p.vault, slug: m.slug, title: speakerTitle(m.agentTitle, m.title), hasPhoto: m.hasPhoto, runId: m.runId,
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

/** A task job's owner-inbox row (M1), as the notch lists it: it opens its task. */
export interface OwnerTaskRow {
  /** `<vault>::<row id>`. */
  key: string;
  vault: string;
  /** The task's slug. */
  task: string;
  agent: string | null;
  kind: string;
  title: string;
  detail: string;
  at: string;
}

/**
 * Every registered project's task-job rows waiting on the owner (AI Team v2 C2): "I did it", a
 * plan to approve, a stuck or stalled task. They are machine-local (M1) and need no Super
 * session; the notch lists them so the owner sees them from any app. Newest first.
 */
export function ownerTaskRows(): OwnerTaskRow[] {
  const out: OwnerTaskRow[] = [];
  for (const v of listVaults()) {
    let rows: ReturnType<typeof listInboxRows> = [];
    try { rows = listInboxRows(v.path); } catch { continue; }
    for (const r of rows) {
      if (!r.kind.startsWith('task-')) continue;
      // The task's slug now (found by id): a rename since the row was raised still opens it.
      let task = r.ref;
      try { task = taskHeadOfRow(join(v.path, '_dream_context'), r)?.slug ?? r.ref; } catch { /* the raised slug */ }
      out.push({ key: `${v.name}::${r.id}`, vault: v.name, task, agent: r.agent, kind: r.kind, title: clip(r.title), detail: clip(r.detail ?? ''), at: r.createdAt });
    }
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, POSTS_CAP);
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
