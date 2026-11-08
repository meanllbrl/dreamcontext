import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { listAgentTargets } from './store.js';
import { identityOnly } from './compose.js';
import { nameOf, summaryOf } from './agent-summary.js';
import { foreignOwner } from './owner.js';
import { getAutomation } from '../automations/store.js';
import { approvedTarget, checkApproval, type ApprovalVerdict, type PendingApprovalChange } from '../automations/registry.js';
import { chatSubagents, type ChatSubagents } from '../automations/chat-subagents.js';
import type { AutomationManifest } from '../automations/types.js';
import { wrapUntrusted } from '../assistant/autonomy.js';
import { bm25Search, RECALL_STRONG_SCORE, type RecallHit } from '../recall.js';
import { buildCorpusCached } from '../recall-corpus-cache.js';
import { SUPER_EVENT_PREFIXES, aboutHeads } from '../super/types.js';

/**
 * THE PROJECT'S AI TEAM, AS THE SUPER AGENT AND THE CHATS SEE IT (task super-agent-isi-bolerken-
 * once-ai-team-e-bakar-…, plan r8). The owner made standing specialists (a revenue keeper, a funnel
 * QA, a competitor watcher); a job in one's field is that member's job.
 *
 * - The Super Agent gets ONE route: its own `## Your AI Team` block (spawn) or `<super-team>` block
 *   (an owner message, when the team changed since it last saw one), and `super team ask`. No
 *   `--agents`, no generic roster: a sub-agent would run inside its own context and bypass the
 *   member's thread, card and run approval.
 * - An ordinary Chat tab keeps its `--agents` and gets a routing rule (`chatSpawnRoster`): it
 *   suggests the member and calls it on the owner's yes.
 * - A member's state is ONE reading (`memberCallState`), the very steps `super team ask` takes
 *   through `sayToAgent`, so the list and the verb can never disagree.
 *
 * Pure but for the reads (manifests, the machine-local approval registry, the recall corpus).
 * Every function takes `home?` and hands it to `checkApproval` and to the member listing (global agents).
 */

export type MemberState = 'ready' | 'needs-approval' | 'off';

export interface TeamMember {
  slug: string;
  /** The agent's own name (never a bound automation's). */
  title: string;
  /** The head of its prompt, one line: its field. */
  role: string;
  state: MemberState;
  /** The Lab insight slugs its prompt names (a whole word, or a `prefix-*` wildcard). */
  watches: string[];
}

/** Where `super team ask` stands with one member: what `sayToAgent` judges, in its order. */
export interface MemberCall {
  /** `missing`: no such member; `not_owner`: a colleague's member, read-only here (never listed). */
  state: MemberState | 'missing' | 'not_owner';
  manifest: AutomationManifest | null;
  verdict: ApprovalVerdict | null;
  /** Ready on its last approved text while a newer version waits for the owner's card. */
  pending?: PendingApprovalChange | null;
}

/**
 * The member's call state, judged on the SLOT `super team ask` judges (`getAutomation(slug)`: a
 * same-slug automation wins over the agent, as Tilki's `doctor`), never the composed target:
 * missing, then turned off, then the RUN approval (a foreign owner first). Throws what
 * `getAutomation` throws; `sayToAgent` turns that into its `say_refused`.
 */
export function memberCallState(contextRoot: string, slug: string, home?: string): MemberCall {
  const manifest = getAutomation(contextRoot, slug, home);
  if (!manifest) return { state: 'missing', manifest: null, verdict: null };
  if (!manifest.enabled) return { state: 'off', manifest, verdict: null };
  // The same question every run asks (`approvedTarget`): a change waiting for the owner's card
  // leaves the member ready on its last approved text, which is what `manifest` then is.
  const view = approvedTarget(dirname(contextRoot), manifest, home, 'run');
  const verdict = view.verdict;
  if (!verdict.approved && verdict.reason === 'not_owner') return { state: 'not_owner', manifest, verdict };
  if (!verdict.approved) return { state: 'needs-approval', manifest, verdict };
  return { state: 'ready', manifest: view.manifest, verdict, pending: view.pending };
}

const STATE_RANK: Record<MemberState, number> = { ready: 0, 'needs-approval': 1, off: 2 };

/** Every insight slug of this project (`lab/insights/<slug>.md`). */
function insightSlugs(contextRoot: string): string[] {
  try {
    return readdirSync(join(contextRoot, 'lab', 'insights'))
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.slice(0, -3));
  } catch { return []; }
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The insights a prompt names: a slug as a whole word, or through `prefix-*` (`mrr-*`). */
export function watchedInsights(prompt: string, slugs: readonly string[]): string[] {
  const prefixes = [...prompt.matchAll(/(?<![A-Za-z0-9_-])([a-z0-9][a-z0-9-]*-)\*/g)].map((m) => m[1]);
  return slugs.filter((slug) =>
    new RegExp(`(?<![A-Za-z0-9_-])${escapeRe(slug)}(?![A-Za-z0-9_-])`).test(prompt)
    || prefixes.some((p) => slug.startsWith(p)));
}

/**
 * The AI Team as the Super Agent can use it: every agent (`listAgentTargets`, the roster's source
 * and order) but the missing and the foreign-owned, ready first, then needs-approval, then off.
 * One unreadable member costs its line, never the list.
 */
export function collectTeam(contextRoot: string, home?: string): TeamMember[] {
  let targets: AutomationManifest[] = [];
  try { targets = listAgentTargets(contextRoot, home); } catch { targets = []; }
  const slugs = insightSlugs(contextRoot);
  const out: TeamMember[] = [];
  for (const m of targets) {
    try {
      const call = memberCallState(contextRoot, m.slug, home);
      if (call.state === 'missing' || call.state === 'not_owner') continue;
      // A colleague's member is never listed, turned off too: `memberCallState` says `off` before
      // it reaches the owner (sayToAgent's order: disabled before not_owner), so ask the slot here.
      if (call.manifest && foreignOwner(call.manifest)) continue;
      const own = identityOnly(m);
      out.push({ slug: m.slug, title: nameOf(m), role: summaryOf(own), state: call.state, watches: watchedInsights(own.prompt, slugs) });
    } catch { /* one unreadable member costs its line */ }
  }
  return out
    .map((member, i) => ({ member, i }))
    .sort((a, b) => STATE_RANK[a.member.state] - STATE_RANK[b.member.state] || a.i - b.i)
    .map(({ member }) => member);
}

/** What the team looks like to the Super: a change to any member's name, field or state is a
 *  new fingerprint (and so a new block for a resumed session). */
export function teamFingerprint(members: readonly TeamMember[]): string {
  const h = createHash('sha256');
  h.update(JSON.stringify(members.map((m) => [m.slug, m.title, m.state, m.role])));
  return h.digest('hex').slice(0, 12);
}

/** The whole block (header, rules and member lines) stays under this; the rest is counted. */
export const TEAM_BLOCK_MAX_CHARS = 2_300;
/** A member's field in the block: shorter than the chat roster's, so more members fit. */
const BLOCK_ROLE_CHARS = 110;

/** The server-written header line of the spawn block; its fingerprint is what a resume reads. */
export const teamBlockHeader = (fp: string): string => `## Your AI Team <!-- fp=${fp} -->`;
const HEADER_RE = /## Your AI Team <!-- fp=([0-9a-f]{12}) -->/;

const STATE_LABEL: Record<MemberState, string> = { ready: 'ready', 'needs-approval': 'needs approval', off: 'off' };

const TEAM_RULES = [
  "The owner's standing specialists. For EVERY job, before you delegate it or answer it yourself: does it fall in one member's",
  'field below? Then a diagnosis, a draft, a send, anything that changes something, or a job across several sources is that',
  "member's job. A small read of ONE source (one chat, one record), changing nothing, is yours when you can reach it.",
  '- ready: `dreamcontext super team ask <slug> "<self-contained ask>" --brief "<line>"`; `--model`/`--effort` for this job',
  '  only; `--light` for a one-source read you cannot reach yourself (read-only tools, cheap model). Never a plain child for',
  '  a member\'s job. Its result comes back as an event (`team=<job> event=done`, with its Answer); `dreamcontext super read',
  '  <team-id>` gives it whole; relay it when the owner waits on it. A follow-up is another `super team ask` to that member.',
  '- needs approval: still `super team ask` it (the owner gets the approval question); tell him in one line; a plain child',
  '  only if he says so.',
  '- off: tell him once, then the plain way.',
  'A job across fields: each member its part. Nothing fits: the plain way. You no longer call agents as sub-agents: any',
  "earlier `## This project's agents` section does not apply to you.",
];

/**
 * The Super Agent's `## Your AI Team` block, '' when there is no member. The header and rules are
 * the server's; the member lines (a shared brain's text) ride inside ONE `wrapUntrusted` fence, so
 * a member's prompt can neither forge the header nor a rule. Members are named until
 * TEAM_BLOCK_MAX_CHARS; the rest are counted.
 */
export function renderSuperTeamBlock(members: readonly TeamMember[], vault: string): string {
  if (members.length === 0) return '';
  const head = [teamBlockHeader(teamFingerprint(members)), ...TEAM_RULES].join('\n');
  const lineOf = (m: TeamMember): string => {
    const role = m.role.length > BLOCK_ROLE_CHARS ? `${m.role.slice(0, BLOCK_ROLE_CHARS - 1).trimEnd()}…` : m.role;
    return `- \`${m.slug}\` ${m.title} · ${STATE_LABEL[m.state]}: ${role}`;
  };
  const more = (n: number): string => `+${n} more: \`dreamcontext super state\` lists all`;
  const lines: string[] = [];
  const render = (ls: string[]): string => `${head}\n${wrapUntrusted(vault, ls.join('\n'))}`;
  for (let i = 0; i < members.length; i++) {
    const next = [...lines, lineOf(members[i])];
    const rest = members.length - i - 1;
    const candidate = rest > 0 ? [...next, more(rest)] : next;
    if (render(candidate).length > TEAM_BLOCK_MAX_CHARS) {
      // The member does not fit: name the rest by count (at least the first line always rides).
      if (lines.length === 0) { lines.push(lineOf(members[i]).slice(0, 200)); continue; }
      lines.push(more(members.length - i));
      return render(lines);
    }
    lines.push(lineOf(members[i]));
  }
  return render(lines);
}

/** The fingerprint a block's own header carries, or null (a team-less spawn, or no block). */
export function teamBlockFingerprint(block: string): string | null {
  const m = HEADER_RE.exec(block.split('\n', 1)[0] ?? '');
  return m ? m[1] : null;
}

/** The Super's spawn block for this project ('' with no team). A failed read is ''. */
export function superSpawnTeamBlock(contextRoot: string, vault: string, home?: string): string {
  try { return renderSuperTeamBlock(collectTeam(contextRoot, home), vault); } catch { return ''; }
}

/**
 * An ordinary Chat tab's `--agents` and roster (`routing: true`: the routing rule), or today's
 * sub-agent wording byte for byte (`routing: false`: a Super child, an agent's own tab).
 */
export function chatSpawnRoster(contextRoot: string, opts: { exclude?: string; home?: string; routing: boolean }): ChatSubagents | null {
  return chatSubagents(contextRoot, { exclude: opts.exclude, home: opts.home, routing: opts.routing });
}

// ─── A resumed or compacted Super: the block on an owner message ──────────────────────

/** The message block's opening tag; a resume reads only a user text block that starts with it. */
export const SUPER_TEAM_TAG_RE = /^<super-team fp=([0-9a-f]{12})>/;
export const EMPTY_TEAM_TEXT = 'Your AI Team is now empty: no member takes jobs any more; do every job the plain way.';

/**
 * The owner message's extra blocks for the Super Agent: `briefText` (SUPER_BRIEF_TEXT, when the
 * caller found it due: lib never imports server code), then `<super-team fp=…>` when the team the
 * Super holds (`teamDelivered`) is not the current one (`fingerprint`). A team that became empty
 * after a non-empty one gets one short line; a team-less Super that never held one gets nothing.
 * A `/` command carries none. `delivered` is what the Super holds once these blocks are written.
 */
export function superOwnerTurnBlocks(i: {
  text: string; briefText: string | null; teamBlock: string; fingerprint: string; teamDelivered: string | null;
}): { blocks: Array<{ type: 'text'; text: string }>; delivered: string | null } {
  if (i.text.startsWith('/')) return { blocks: [], delivered: i.teamDelivered };
  const blocks: Array<{ type: 'text'; text: string }> = [];
  if (i.briefText) blocks.push({ type: 'text', text: i.briefText });
  let delivered = i.teamDelivered;
  if (i.teamBlock && i.fingerprint !== i.teamDelivered) {
    blocks.push({ type: 'text', text: `<super-team fp=${i.fingerprint}>\n${i.teamBlock}\n</super-team>` });
    delivered = i.fingerprint;
  } else if (!i.teamBlock && i.teamDelivered !== null && i.teamDelivered !== i.fingerprint) {
    blocks.push({ type: 'text', text: `<super-team fp=${i.fingerprint}>\n${EMPTY_TEAM_TEXT}\n</super-team>` });
    delivered = i.fingerprint;
  }
  return { blocks, delivered };
}

/**
 * Which team a resumed Super session holds, read from its transcript the way `superBriefState`
 * reads the brief revision: `inPrompt` = the fingerprint in its system-prompt snapshot's header;
 * `delivered` = the last `<super-team fp=…>` an owner message carried since the last compaction,
 * else `inPrompt`. A compaction summary is never delivery, and a tool result quoting a tag is not
 * an owner text block.
 */
export function superTeamState(jsonl: string): { inPrompt: string | null; delivered: string | null } {
  let inPrompt: string | null = null;
  let viaMessage: string | null = null;
  for (const line of jsonl.split('\n')) {
    if (!line.includes('Your AI Team') && !line.includes('super-team') && !line.includes('compact_boundary')) continue;
    let o: { type?: string; subtype?: string; isCompactSummary?: boolean; attachment?: { type?: string }; message?: { content?: unknown } };
    try { o = JSON.parse(line); } catch { continue; }
    if (o.isCompactSummary) continue;
    if (o.type === 'system' && o.subtype === 'compact_boundary') { viaMessage = null; continue; }
    if (o.attachment?.type === 'prompt_snapshot') {
      const m = HEADER_RE.exec(line);
      inPrompt = m ? m[1] : null;
      continue;
    }
    const content = Array.isArray(o.message?.content) ? o.message.content as Array<{ type?: unknown; text?: unknown }> : [];
    if (o.type !== 'user') continue;
    for (const b of content) {
      const m = b?.type === 'text' && typeof b.text === 'string' ? SUPER_TEAM_TAG_RE.exec(b.text) : null;
      if (m) viaMessage = m[1];
    }
  }
  return { inPrompt, delivered: viaMessage ?? inPrompt };
}

/** Recall's own input never matches on the Super's roster: its `<super-team>` blocks are cut. */
export function stripSuperTeamBlocks(prompt: string): string {
  return prompt.includes('<super-team') ? prompt.replace(/<super-team fp=[0-9a-f]{12}>[\s\S]*?<\/super-team>\n?/g, '') : prompt;
}

// ─── Does a job fall in a member's field? ─────────────────────────────────────────────

/**
 * The raw BM25 score the top `agent` hit must reach for a job to count as a member's, calibrated
 * on the eval fixture (Orbit + Ledger, Probe, Lookout, Atlas; tests/unit/team-roster.test.ts holds
 * the cases): "Run the signup funnel test end to end" probe 10.2, "What are competitors running in
 * ads this week?" lookout 9.3, "What's this month's revenue?" ledger 2.6 hint; "Fix the typo in
 * the onboarding title" probe 1.2, "Write the release notes for the onboarding polish" atlas 2.4,
 * a dark-mode toggle (no agent hit) do not. Above the recall block's own gate (2.0).
 */
export const TEAM_FIT_MIN_SCORE = 2.5;
/** A query's share of a long prompt. */
const FIT_QUERY_CHARS = 2_000;

/** The top `agent` hit for `text` over the project's full local corpus (no federation: an
 *  agent-only corpus of four docs flattens IDF), when it is strong enough. */
function topAgentHit(contextRoot: string, text: string): RecallHit | null {
  const hits = bm25Search(text.slice(0, FIT_QUERY_CHARS), buildCorpusCached(contextRoot), 10);
  const hit = hits.find((h) => h.doc.type === 'agent');
  return hit && hit.score >= TEAM_FIT_MIN_SCORE ? hit : null;
}

/**
 * The READY member whose field a job falls in, or null (`super delegate` warns with it, and still
 * starts the child). `text` is the brief and the head of the prompt.
 */
export function teamFit(contextRoot: string, text: string, home?: string): { slug: string; title: string; role: string } | null {
  try {
    const hit = topAgentHit(contextRoot, text);
    if (!hit) return null;
    const member = collectTeam(contextRoot, home).find((m) => m.slug === hit.doc.slug);
    return member && member.state === 'ready' ? { slug: member.slug, title: member.title, role: member.role } : null;
  } catch { return null; }
}

// ─── The prompt hook's AI TEAM MEMBER line ────────────────────────────────────────────

export type TeamRoute = 'super' | 'offer';

/** `DREAMCONTEXT_TEAM_ROUTE` as the hook reads it: '' and absent (terminals, runs) are off. */
export function teamRouteOf(raw: string | undefined): TeamRoute | null {
  return raw === 'super' || raw === 'offer' ? raw : null;
}

/**
 * The owner's own words in a prompt: the first text block with every reference header
 * (`aboutHeads`: a ↩ reply's quote, an agenda line) cut out, up to the first server-written block
 * (a line opening `<super-`, `<owner-` or `[super `). Null for a server-written Super turn
 * (`[super events]` …, the rotation's `Handoff:` turn): a team result naming a member must never
 * ask that member again.
 */
/** The fixed opening of the server's handoff turn after a rotation's `/clear`
 *  (context-watch.ts `handoffContinuePrompt`): server-written, never the owner's words. */
export const HANDOFF_TURN_PREFIX = 'Handoff: ';

export function ownerWords(prompt: string): string | null {
  if (SUPER_EVENT_PREFIXES.some((p) => prompt.startsWith(p)) || prompt.startsWith(HANDOFF_TURN_PREFIX)) return null;
  let text = prompt;
  const cut = /(^|\n)(<super-|<owner-|\[super )/.exec(text);
  if (cut) text = text.slice(0, cut.index);
  else {
    // Blocks joined without a newline: the owner-message block always rides the Super's message.
    const at = text.indexOf('<owner-msg');
    if (at >= 0) text = text.slice(0, at);
  }
  const heads = aboutHeads(text);
  for (const h of [...heads].reverse()) text = text.slice(0, h.at) + text.slice(h.end);
  return text.trim();
}

/** A title in a directive line: one line, no control characters, at most 60 characters. */
function safeTitle(t: string): string {
  const flat = t.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat;
}

/**
 * The prompt hook's lines (an app chat only, never a nested hook: the caller checks both): an
 * `agent` hit on the owner's words whose member is callable on this route — `super`: ready by
 * `memberCallState`; `offer`: the roster's identity approval, the door that chat has — and an
 * insight hit such a member watches. Never the chat's own agent (`exclude`). [] for anything else.
 */
export function teamPromptDirectives(i: { prompt: string; contextRoot: string; route: TeamRoute; exclude?: string; home?: string }): string[] {
  const words = ownerWords(i.prompt);
  if (!words || words.length < 3) return [];
  const hits = bm25Search(words.slice(0, FIT_QUERY_CHARS), buildCorpusCached(i.contextRoot), 10);
  const agentHit = hits.find((h) => h.doc.type === 'agent' && h.score >= TEAM_FIT_MIN_SCORE && h.doc.slug !== i.exclude);
  const insightHits = hits.filter((h) => h.doc.type === 'insight' && h.score >= RECALL_STRONG_SCORE);
  if (!agentHit && insightHits.length === 0) return [];
  const callable = callableMembers(i.contextRoot, i.route, i.exclude, i.home);
  const lines: string[] = [];
  const member = agentHit ? callable.find((m) => m.slug === agentHit.doc.slug) : undefined;
  if (member) {
    const how = i.route === 'super'
      ? `a small read of one source changing nothing is yours (or \`--light\`); a diagnosis, draft, send or several sources: \`dreamcontext super team ask ${member.slug} "<the job>"\`, not a child.`
      : 'offer the owner to ask it before you do its job yourself.';
    lines.push(`→ AI TEAM MEMBER \`${member.slug}\` (${safeTitle(member.title)}): this is its field: ${how}`);
  }
  for (const h of insightHits) {
    const w = callable.find((m) => m.watches.includes(h.doc.slug));
    if (w) lines.push(`→ ${safeTitle(w.title)} (AI Team) watches this metric (\`${h.doc.slug}\`).`);
  }
  return lines;
}

/** The members a chat on this route can really reach. */
function callableMembers(contextRoot: string, route: TeamRoute, exclude: string | undefined, home?: string): TeamMember[] {
  if (route === 'super') return collectTeam(contextRoot, home).filter((m) => m.state === 'ready' && m.slug !== exclude);
  const slugs = insightSlugs(contextRoot);
  let targets: AutomationManifest[] = [];
  try { targets = listAgentTargets(contextRoot, home); } catch { targets = []; }
  const out: TeamMember[] = [];
  for (const m of targets) {
    if (m.slug === exclude) continue;
    try {
      const view = approvedTarget(dirname(contextRoot), m, home, 'identity');
      if (!view.verdict.approved) continue;
      const own = identityOnly(view.manifest);
      out.push({ slug: m.slug, title: nameOf(m), role: summaryOf(own), state: 'ready', watches: watchedInsights(own.prompt, slugs) });
    } catch { /* unreadable: not callable */ }
  }
  return out;
}
