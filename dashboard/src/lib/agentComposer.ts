/**
 * Support for the thin strip at the bottom of the Agent overlay ({@link AgentComposerBar}):
 * our signature skill triggers, path quoting, and the model/effort config the strip reads
 * from the Claude CLI (never a hardcoded list).
 *
 * ── Model + effort are sourced from the CLI, per agent ────────────────────────────
 * `GET /api/agent/model-config` returns the models the CLI actually offers (its cached
 * option list + aliases), the effort levels from `claude --help`, and the user's own
 * defaults from `~/.claude/settings.json`. A session's CURRENT model comes from its
 * transcript (`GET /api/agent/session-model`). Switching either fires the live `/model`
 * or `/effort` slash command into that agent. Provider-neutral so another backend can
 * later populate the same shapes.
 */

// ── Built-in skill triggers (our signature capabilities) ───────────────────────────
// Clicking one types its trigger into the terminal's OWN input line; the user finishes it.
// Each trigger carries a rich "what it is / how it works" payload so the Skills popover
// can render a live detail card on hover — far clearer than a one-line native tooltip.

export interface SkillTrigger {
  /** The slash trigger typed into the focused terminal's input line. */
  insert: string;
  /** Chip label. */
  label: string;
  /** One-line fallback (native title / aria) — a compressed form of `what`. */
  hint: string;
  /** One sentence: what this capability IS. */
  what: string;
  /** How it works, as an ordered flow (the phases / gates the orchestrator runs). */
  how: string[];
  /** The sub-agents it dispatches, if any (shown as a "Dispatches" row). */
  agents?: string[];
}

export interface SkillGroup {
  id: string;
  label: string;
  triggers: SkillTrigger[];
}

export const SKILL_GROUPS: SkillGroup[] = [
  {
    id: 'brain',
    label: 'Brain lifecycle',
    triggers: [
      {
        insert: '/initializer ',
        label: 'Initializer',
        hint: 'Bootstrap a missing or sparse brain from your real material.',
        what: 'Bootstraps a missing or sparse brain from your real material — docs, wikis, Obsidian/Notion exports, or just the codebase — into a proper knowledge / feature / task hierarchy.',
        how: [
          'Scout inventories your code + docs into a categorized ingestion manifest',
          'You confirm the proposed knowledge / feature / task hierarchy',
          'Ingestor agents fan out per batch, distilling sources into real files (never templates)',
          'Verifier gates: no placeholders, doctor clean, recall actually returns hits',
        ],
        agents: ['initializer-scout', 'initializer-ingestor', 'initializer-verifier'],
      },
      {
        insert: '/curator ',
        label: 'Curator',
        hint: 'The periodic brain refactor that sleep won\'t do.',
        what: 'The periodic brain REFACTOR that sleep won\'t do — re-orders the whole corpus into the right shape (MOVE / MERGE / SPLIT / RENAME / RE-TYPE / RETIRE) to conform to current conventions.',
        how: [
          'Auditors fan out per domain, reading conventions live from the skill + taxonomy + soul',
          'A reorg PLAN is proposed: source → action → target for every drifted file',
          'You confirm the shape before anything moves',
          'Workers execute via the CLI so frontmatter, wikilinks and indexes stay coherent',
          'Verifier gates: doctor clean, zero duplicate topics, recall not regressed',
        ],
        agents: ['curator-auditor', 'curator-worker', 'curator-verifier'],
      },
      {
        insert: '/dreamcontext-deep-research ',
        label: 'Deep Research',
        hint: 'Heavy cross-corpus synthesis across a large or multi-project brain.',
        what: 'Heavy, iterative synthesis across a large or multi-project brain and connected peer vaults — for when a single explore pass under-serves the question.',
        how: [
          'Searchers fan out over knowledge, features, tasks, memory, changelog + connected peers',
          'Load-bearing claims are adversarially verified, not trusted',
          'Returns a synthesized, CITED report — not a pile of raw hits',
        ],
      },
      {
        insert: '/dream-sync ',
        label: 'Sync',
        hint: 'Resolve the team brain-merge the CLI defers to you.',
        what: 'The agent half of the team brain-merge — resolves the prose conflicts the CLI deliberately hands off.',
        how: [
          'The CLI auto-resolves every deterministic file (JSON, task statuses, changelogs)',
          'It defers only PROSE where two people edited the same section',
          'You read base / ours / theirs and write the true semantic merge',
          'Hand back to the CLI to commit + push',
        ],
      },
    ],
  },
  {
    id: 'build',
    label: 'Build & review',
    triggers: [
      {
        insert: '/goal-skill ',
        label: 'Goal',
        hint: 'Drive a non-trivial goal to done under planned, reviewed, validated orchestration.',
        what: 'Drives a non-trivial goal to done under rigorous orchestration — the orchestrator gates each phase; sub-agents do the work; "done" means validation passes against criteria you agreed to.',
        how: [
          'Planner produces a file-by-file plan grounded in the real codebase',
          'Parallel plan-reviewers critique it from different lenses → SOLID / NEEDS_WORK',
          'The plan is persisted as a dreamcontext task with agreed acceptance criteria',
          'Implementer builds strictly to the criteria; the reviewer gates the diff',
          'Validator runs your chosen tests / checklist → PASS / FAIL, looping until reached',
        ],
        agents: ['goal-planner', 'goal-plan-reviewer', 'goal-implementer', 'reviewer', 'goal-validator'],
      },
      {
        insert: '/multi-review ',
        label: 'Multi-review',
        hint: 'Route the diff to specialist reviewers, then consolidate one report.',
        what: 'Team code review — routes a diff to niche specialists in parallel, then consolidates their findings into one greptile-style report with a verdict.',
        how: [
          'Router classifies the diff by size tier + affected domains',
          'Specialists review in parallel: security · cloud-functions · frontend · edge-cases',
          'Coordinator dedupes, re-ranks and drops false positives → one final verdict',
        ],
        agents: ['review-router', 'review-security', 'review-cloud-functions', 'review-frontend', 'review-edge-cases', 'review-coordinator'],
      },
    ],
  },
  {
    id: 'decide',
    label: 'Decide & draw',
    triggers: [
      {
        insert: '/council ',
        label: 'Council',
        hint: 'Run a structured multi-persona debate, then synthesize a decision.',
        what: 'A structured multi-persona debate for a hard decision, ending in a synthesized decision report that traces every reason back to who raised it.',
        how: [
          '3–10 persona agents debate the question over N rounds',
          'Each argues from its own assigned perspective, with optional web research',
          'A synthesizer reads every report and writes the final decision + minority views',
        ],
        agents: ['council-persona', 'council-synthesizer'],
      },
      {
        insert: '/excalidraw ',
        label: 'Excalidraw',
        hint: 'Generate or extend an Obsidian Excalidraw board from a spec.',
        what: 'Generate or extend an Obsidian Excalidraw board — images, labels, shapes, arrows, lanes, grids — from a small spec.',
        how: [
          'You describe the board (or point at screenshots to embed)',
          'A deterministic script emits valid plugin markup — ~no tokens, always renders',
        ],
      },
    ],
  },
];

// ── Model / effort config (fetched from the CLI via the server) ─────────────────────

export interface ModelOption {
  id: string;
  label: string;
  /** Public API list price in USD per MILLION input tokens, or null when the server can't
   *  price this id. Filled by `GET /api/agent/model-config` from the SAME table the cost
   *  readout prices turns with (`MODEL_PRICING` in agent-terminal.ts) — the model menu must
   *  not carry a second copy that can drift from what the estimate actually charges.
   *  Optional because a server that predates the field simply omits it; the row then prints
   *  its name and insight without a price rather than "$undefined/M". */
  priceIn?: number | null;
}

export interface ModelConfig {
  /** Models the CLI offers (aliases + its own cached extras). */
  models: ModelOption[];
  /** Effort levels from `claude --help` (e.g. low, medium, high, xhigh, max). */
  efforts: string[];
  /** The user's default model alias + effort level from `~/.claude/settings.json`. */
  defaultModel: string;
  defaultEffort: string;
}

/** Used only until the real config arrives (or if the CLI can't be read) — deliberately
 *  minimal, and carries NO synthetic "default" model entry. */
export const FALLBACK_MODEL_CONFIG: ModelConfig = {
  models: [
    { id: 'opus', label: 'Opus' },
    { id: 'sonnet', label: 'Sonnet' },
    { id: 'haiku', label: 'Haiku' },
    { id: 'fable', label: 'Fable' },
  ],
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  defaultModel: 'opus',
  defaultEffort: 'high',
};

/** The model families this app knows how to talk about. Ordered longest-lived first only by
 *  accident — nothing depends on the order, `modelFamily` takes the first substring hit. */
const MODEL_FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'] as const;
export type ModelFamily = typeof MODEL_FAMILIES[number];

/**
 * The family a model id belongs to, or null for one this app has no opinion about.
 *
 * Mirrors the server's `modelAlias` (agent-terminal.ts). Extracted rather than inlined
 * because THREE readers need the same answer — the picker's label, the menu's insight copy,
 * and the primary/other split — and three copies of the same substring list is exactly how
 * a new family ends up labelled but not described (or the reverse).
 */
export function modelFamily(id: string): ModelFamily | null {
  const s = (id ?? '').toLowerCase();
  return MODEL_FAMILIES.find((f) => s.includes(f)) ?? null;
}

/**
 * What to print on a model picker for `model`, which reaches us in three different shapes
 * and must never degrade to a bare "—":
 *   • a picker alias  (`opus`)                        → the option's own label,
 *   • a full CLI id   (`claude-opus-4-5-20251101`)    → the same label, matched by family
 *     (this is what `system:init` reports for a chat session, and it is NOT in `models`),
 *   • empty           (before the first init frame)   → the user's default model's label.
 * A genuinely unknown id is returned verbatim — better a raw id the user can read than a
 * dash that says nothing.
 */
export function modelLabelFor(config: ModelConfig, model: string): string {
  const resolve = (id: string): string | undefined => {
    if (!id) return undefined;
    const exact = config.models.find((m) => m.id === id);
    if (exact) return exact.label;
    const family = modelFamily(id);
    return family ? config.models.find((m) => m.id === family)?.label ?? family : undefined;
  };
  // The default stands in ONLY for "not reported yet". An id we simply don't recognize must
  // print as itself: relabelling it as the default would claim a model is running that
  // isn't.
  if (!model) return resolve(config.defaultModel) ?? config.defaultModel;
  return resolve(model) ?? model;
}

// ── Model menu presentation (what a row SAYS, beyond its name) ──────────────────────
//
// The redesigned model menu gives each row a one-line "what is this for" and, where the
// server priced it, an input rate. The rate comes from the SERVER (`ModelOption.priceIn`,
// one table) because it is a fact that must match the cost estimate; the sentence lives
// HERE because it is product copy, not data — a server that starts shipping marketing
// strings is a server that has to be redeployed to fix a typo.
//
// A family with no entry renders its name alone. That is the honest degradation: a model
// this build has never heard of gets no invented description.

export interface ModelNote {
  /** One line: what this model is FOR. Shown under the row's name. */
  insight: string;
  /** Optional chip beside the name (e.g. "Recommended"). */
  badge?: string;
}

export const MODEL_INSIGHTS: Record<ModelFamily, ModelNote> = {
  fable: { insight: 'Strongest overall. Best reasoning, writing, and tool use.' },
  opus: { insight: 'Deep reasoning. Best for hard refactors and long plans.', badge: 'Recommended' },
  sonnet: { insight: 'Balanced. Fast enough for everyday agent loops.' },
  haiku: { insight: 'Cheapest and quickest. Good for lookups and small edits.' },
};

/**
 * The note for a model id in any of the shapes the picker sees — a picker alias (`opus`),
 * the full id `system:init` reports (`claude-opus-4-5-20251101`), or an id from a newer CLI
 * this build has never seen. The last case returns null, and the row prints its name alone.
 */
export function modelNoteFor(id: string): ModelNote | null {
  const family = modelFamily(id);
  return family ? MODEL_INSIGHTS[family] : null;
}

/** How many models the menu shows before the "Other models" disclosure. */
export const MODEL_PRIMARY_COUNT = 2;

/**
 * Split the CLI's model list into the rows shown up front and the rows behind the
 * disclosure.
 *
 * The one rule that isn't "take the first N": THE CURRENT MODEL IS ALWAYS PRIMARY. A menu
 * that hides the running model behind a closed disclosure asks the user to go looking for
 * the thing they came to read — and the checkmark they're hunting for is the one row not on
 * screen. A promoted model joins the END of the primary list, so the first N keep the
 * positions the CLI gave them and the promoted row reads as the addition it is.
 *
 * `current` is matched by exact id first, then by family — `system:init` reports the full id
 * (`claude-sonnet-4-5-20250929`), which is never one of the picker's alias ids.
 */
export function splitModels(
  config: ModelConfig,
  current: string,
  primaryCount: number = MODEL_PRIMARY_COUNT,
): { primary: ModelOption[]; other: ModelOption[] } {
  const count = Math.max(0, Math.min(config.models.length, Math.floor(primaryCount)));
  const primary = config.models.slice(0, count);
  const other = config.models.slice(count);
  if (!current) return { primary, other };

  const family = modelFamily(current);
  const at = other.findIndex((m) => m.id === current || (!!family && m.id === family));
  if (at === -1) return { primary, other };
  return {
    primary: [...primary, other[at]],
    other: [...other.slice(0, at), ...other.slice(at + 1)],
  };
}

/** Context-window usage at/above which a readout goes caution-coloured (and, in the chat
 *  composer, offers `/compact`). Shared by BOTH composers so the terminal strip and the
 *  chat card can never disagree about when a session is running out of room. */
export const CONTEXT_TIGHT_PCT = 90;

// ── Slash-command autocomplete ──────────────────────────────────────────────────────

/**
 * The `/command` token currently being typed at `caret`, WITHOUT its slash — or null when
 * the caret isn't in one. Returns `''` for a bare `/`, which is a real state (offer every
 * command), so callers must test for `null`, not falsiness.
 *
 * Anchored at a TOKEN boundary — start of the message, or any whitespace/newline — so the
 * menu also opens on the second line of a multi-line prompt and mid-sentence ("also run
 * /verify after"). A `/` glued to the previous character is a path or a conjunction, never a
 * command, so `src/lib` and `and/or` stay silent. Once the user types a space the command
 * name is settled and the menu closes — arguments are the command's business, not the
 * picker's.
 *
 * Only a LEADING slash is executed by the CLI itself (that's the form `/compact`, `/effort`
 * need). Named mid-sentence, a command reaches the model as text — which is how skills get
 * invoked — so offering the picker there completes a real name instead of a guessed one.
 */
export function slashQueryAt(text: string, caret: number): string | null {
  const before = text.slice(0, Math.max(0, caret));
  const m = /(?:^|\s)\/([^\s]*)$/.exec(before);
  return m ? m[1] : null;
}

/**
 * `commands` filtered by `query`, prefix matches first (what the user is most likely
 * reaching for) then the rest of the substring matches, each group keeping the CLI's own
 * ordering. Case-insensitive; an empty query returns everything.
 */
export function filterSlashCommands(commands: string[], query: string): string[] {
  const q = query.toLowerCase();
  if (!q) return [...commands];
  const prefix: string[] = [];
  const contains: string[] = [];
  for (const c of commands) {
    const lc = c.toLowerCase();
    if (lc.startsWith(q)) prefix.push(c);
    else if (lc.includes(q)) contains.push(c);
  }
  return [...prefix, ...contains];
}

/**
 * Replace the `/…` token at the caret with `/<command> `, and report the new caret.
 * Only that token is rewritten — whatever the user typed BEFORE it survives, which is what
 * makes a mid-sentence pick usable. With no token at the caret the command is inserted there
 * rather than swallowing the line.
 */
export function applySlashCommand(text: string, caret: number, command: string): { text: string; caret: number } {
  const at = Math.max(0, Math.min(caret, text.length));
  const query = slashQueryAt(text, at);
  // The token's `/` sits exactly one char before its query, which ends at the caret.
  const start = query === null ? at : at - query.length - 1;
  const head = `${text.slice(0, start)}/${command} `;
  return { text: head + text.slice(at), caret: head.length };
}

/**
 * Whether a composed chat message is the sign-in command. The chat engine is
 * `claude -p --input-format stream-json`, which answers `/login` with "/login isn't available
 * in this environment." (verified on CLI 2.1.220) — the OAuth flow exists only in the
 * interactive TUI — so the chat composer intercepts it and opens a terminal session instead of
 * spending a turn to tell the user nothing.
 *
 * Deliberately narrow: the WHOLE message must be the command, optionally with arguments —
 * that leading form is the only one the CLI executes itself. "how do I /login?" is a question
 * about it and must still reach the model.
 */
export function isSignInCommand(message: string): boolean {
  return /^\/login(\s|$)/.test(message.trim());
}

// ─── `@peer` mentions ──────────────────────────────────────────────────────────
//
// The same three primitives as the `/` menu above, for addressing a CONNECTED
// PROJECT. Kept deliberately parallel — same token-boundary anchoring, same
// prefix-then-substring ranking, same "replace only the token at the caret"
// rewrite — because the two menus sit in the same textarea and a user who has
// learned one has learned the other.

/** One addressable peer, as the `@` menu shows it. */
export interface PeerMention {
  /** Registered vault name — what gets written into the message. */
  vault: string;
  /** Generated envoy subagent name (`peer-tilki`), for the hint line. */
  agent: string;
  /** One-line "what it is" from the peer-summary cache. May be ''. */
  whatItIs: string;
  /** Whether the peer vault ships a logo (`assets/logo.*` in ITS tree) — the client
   *  builds the image URL itself via `peerLogoUrl`. Optional: older servers omit it. */
  logo?: boolean;
}

/**
 * The peer behind a dispatched sub-agent, if the run IS a peer envoy. Matched on the
 * generated agent name (`peer-<slug>`), which is exactly what the Agent tool reports as
 * `subagent_type` — this is what lets a peer run wear the peer's face instead of the
 * generic agent avatar.
 */
export function peerForAgent(
  subagentType: string | null | undefined,
  peers: PeerMention[],
): PeerMention | null {
  if (!subagentType) return null;
  const lc = subagentType.toLowerCase();
  return peers.find((p) => p.agent.toLowerCase() === lc) ?? null;
}

/** One run of {@link mentionSegments} output: a slice of the draft, flagged when it is a
 *  known peer's `@` mention. */
export interface MentionSegment {
  text: string;
  mention: boolean;
}

/**
 * The draft, split into plain slices and `@<peer>` mentions — for the composer's
 * highlight layer, which paints ONLY the mentions and leaves the rest to the textarea.
 *
 * A token counts only when it names a KNOWN peer (vault or envoy-agent name,
 * case-insensitive) at a token boundary — the same boundary rule as
 * {@link mentionQueryAt}, so an email address's `@` never lights up.
 */
export function mentionSegments(text: string, peers: PeerMention[]): MentionSegment[] {
  if (!peers.length || !text.includes('@')) return [{ text, mention: false }];
  const names = new Set(
    peers.flatMap((p) => [p.vault.toLowerCase(), p.agent.toLowerCase()]),
  );
  const out: MentionSegment[] = [];
  const re = /(^|\s)@([^\s]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const start = m.index + m[1].length;
    if (!names.has(m[2].toLowerCase())) continue;
    if (start > last) out.push({ text: text.slice(last, start), mention: false });
    out.push({ text: `@${m[2]}`, mention: true });
    last = start + m[2].length + 1;
  }
  if (last < text.length) out.push({ text: text.slice(last), mention: false });
  return out.length ? out : [{ text, mention: false }];
}

/**
 * The `@…` token at the caret, or `null` when the caret isn't in one. Returns
 * `''` for a bare `@` (offer every peer), so callers must test for `null`.
 *
 * Anchored at a token boundary exactly like {@link slashQueryAt}, which is what
 * keeps an email address silent: the `@` in `mehmet@nativeminds.ai` is glued to
 * the previous character, so it never opens the menu.
 */
export function mentionQueryAt(text: string, caret: number): string | null {
  const before = text.slice(0, Math.max(0, caret));
  const m = /(?:^|\s)@([^\s]*)$/.exec(before);
  return m ? m[1] : null;
}

/** `peers` filtered by `query`, prefix matches first. Case-insensitive. */
export function filterPeerMentions(peers: PeerMention[], query: string): PeerMention[] {
  const q = query.toLowerCase();
  if (!q) return [...peers];
  const prefix: PeerMention[] = [];
  const contains: PeerMention[] = [];
  for (const p of peers) {
    const lc = p.vault.toLowerCase();
    if (lc.startsWith(q)) prefix.push(p);
    else if (lc.includes(q) || p.agent.toLowerCase().includes(q)) contains.push(p);
  }
  return [...prefix, ...contains];
}

/**
 * Replace the `@…` token at the caret with `@<vault> `, and report the new caret.
 * Only that token is rewritten, so a mid-sentence pick keeps everything the user
 * already typed.
 */
export function applyPeerMention(
  text: string,
  caret: number,
  vault: string,
): { text: string; caret: number } {
  const at = Math.max(0, Math.min(caret, text.length));
  const query = mentionQueryAt(text, at);
  const start = query === null ? at : at - query.length - 1;
  const head = `${text.slice(0, start)}@${vault} `;
  return { text: head + text.slice(at), caret: head.length };
}

/**
 * The peer a message is ADDRESSED to: a leading `@<vault>`, matched against the
 * known peers. Returns the peer and the message with the mention stripped.
 *
 * Leading only, and that is the whole rule. "@Tilki nasıl yapıyor bunu" is a
 * message FOR Tilki; "bunu @Tilki gibi yapalım" mentions it while talking to the
 * local agent, and routing that to another project would be a surprise the user
 * cannot undo. Same shape as {@link isSignInCommand}'s leading-form test, for
 * the same reason.
 */
export function addressedPeer(
  message: string,
  peers: PeerMention[],
): { peer: PeerMention; body: string } | null {
  const m = /^@([^\s]+)\s*([\s\S]*)$/.exec(message.trim());
  if (!m) return null;
  const name = m[1].toLowerCase();
  const peer = peers.find((p) => p.vault.toLowerCase() === name || p.agent.toLowerCase() === name);
  return peer ? { peer, body: m[2].trim() } : null;
}

/** Title-case an effort level for display ("high" → "High"). */
export function effortLabel(level: string): string {
  return level ? level.charAt(0).toUpperCase() + level.slice(1) : level;
}

// ── Effort as a SLIDER position ─────────────────────────────────────────────────────
//
// The redesigned model menu drives effort with an `<input type="range">` over the CLI's own
// levels, so the two directions of that binding need a total function each. Neither may ever
// hand the input an out-of-range value: a `range` whose `value` sits outside [min,max] is
// silently clamped BY THE BROWSER, which then reports the clamped number back through
// `onChange` — i.e. a bad index doesn't look wrong, it quietly rewrites the user's setting.

/**
 * Where `level` sits on the slider. Never -1.
 *
 * An unrecognised level (an older/newer CLI's own value) parks the THUMB at 0 — but the
 * trigger and the menu head print `effortLabel(level)`, the real string, so the reading
 * stays truthful even while the thumb is a best guess. This is deliberately the same
 * discipline as `modelLabelFor`: show what is actually running, never a substituted default.
 */
export function effortIndex(efforts: string[], level: string): number {
  const at = efforts.indexOf(level);
  return at === -1 ? 0 : at;
}

/** The level at slider position `index`, clamped into range. `''` only when there are no
 *  levels at all (in which case the caller has no slider to render). */
export function effortAt(efforts: string[], index: number): string {
  if (efforts.length === 0) return '';
  const n = Number.isFinite(index) ? Math.round(index) : 0;
  return efforts[Math.min(efforts.length - 1, Math.max(0, n))];
}

// ── Per-session context-window + cost readout ───────────────────────────────────────

/** The focused agent's live token footprint + API-rate cost estimate (from its transcript,
 *  `GET /api/agent/session-stats`). All null until the first turn writes usage. */
export interface SessionStats {
  /** How full the context window currently is (last turn's total token footprint). */
  contextTokens: number | null;
  /** The running model's context window — see `contextLimitFor`. */
  contextLimit: number | null;
  /** Cumulative spend priced at public API rates — a what-if for flat-rate plans. */
  costUsd: number | null;
}

/**
 * The context reading the composer's gauge draws — {@link SessionStats} (or the live result
 * frame) resolved against {@link contextLimitFor} and turned into a percentage.
 *
 * Declared HERE rather than in the component that renders it: the gauge, the usage popover
 * and `usageLimits` below all speak this shape, and the component that used to own it
 * (`chat/ContextReadout.tsx`) is replaced by the redesigned ring. A type whose home is a
 * deleted file is a type that gets re-declared three times.
 */
export type ContextUsage = { used: number; limit: number; pct: number };

/** Model ids whose context window is 200K rather than 1M: the whole Haiku line, and the
 *  Opus/Sonnet generations before 4.6. Everything the CLI can run today — Opus 4.6+, Opus 5,
 *  Sonnet 4.6+, Sonnet 5, Fable, Mythos — ships a 1M window. */
const SMALL_WINDOW_MODEL = /haiku|3-opus|3-[57]-sonnet|opus-4-[01]\b|opus-4-5\b|sonnet-4-[05]\b|-4-\d{8}/;

export const CONTEXT_WINDOW_SMALL = 200_000;
export const CONTEXT_WINDOW_LARGE = 1_000_000;

/**
 * The running model's context window, in tokens.
 *
 * 1M is the DEFAULT and 200K the exception — the inverse of what this used to be. That
 * inversion is the whole point: every model Claude Code offers today (Opus 4.6+, Opus 5,
 * Sonnet 4.6+, Sonnet 5, Fable, Mythos) has a 1M window, so assuming 200K made the gauge
 * read five times fuller than the session actually was. An id we don't recognise is far
 * more likely to be a NEW model than a retired one, so unknown resolves to 1M too.
 *
 * Two signals refine the guess:
 *   • the `[1m]` marker Claude Code puts on its explicit 1M picker values
 *     (`claude-fable-5[1m]`) — present in `~/.claude.json`'s model cache and in the
 *     spawn-time alias, though NEVER in a transcript's `message.model`, which is exactly
 *     why keying off it alone left every session reading 200K;
 *   • the observed footprint — a session cannot be at 130% of its window, so exceeding
 *     200K IS the evidence of the larger one. This can only ever promote.
 */
export function contextLimitFor(usedTokens: number, modelId: string | undefined): number {
  if (usedTokens > CONTEXT_WINDOW_SMALL) return CONTEXT_WINDOW_LARGE;
  const id = (modelId ?? '').toLowerCase();
  if (id.includes('1m')) return CONTEXT_WINDOW_LARGE;
  return SMALL_WINDOW_MODEL.test(id) ? CONTEXT_WINDOW_SMALL : CONTEXT_WINDOW_LARGE;
}

/** Compact token count: 850 · 48.2k · 1.2M. */
export function fmtTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) { const k = n / 1000; return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`; }
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Cost in USD, kept readable at small magnitudes: <$1 shows cents-precision, else 2dp. */
export function fmtCost(usd: number): string {
  if (usd <= 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd)}`;
}

// ── Account usage limits (the usage popover's nested bars) ──────────────────────────
//
// Three readings stack in the usage popover: how full THIS conversation's context window is
// (local arithmetic), and how much of the account's 5-hour and weekly caps are spent — which
// Claude Code itself caches in `~/.claude.json` under `cachedUsageUtilization` and the server
// re-serves via `GET /api/agent/usage-limits`.
//
// THE RULE THAT GOVERNS ALL OF IT: show what's found, hide what isn't. A cap with no readable
// source renders NOTHING — not an empty ring, not a zero, not "unknown". An empty bar reads as
// "you've used none of it", which is a claim we have no basis for; absence reads as absence.
// So every degradation below removes a bar rather than drawing a hollow one.

/**
 * One cap as the server reports it.
 *
 * MIRRORED in `src/lib/claude-usage.ts` (`UsageLimitWire`) — the server builds this shape
 * field-by-field from `cachedUsageUtilization` and never spreads the source object, because
 * that file also holds `oauthAccount`, `machineID`, `accountUuid` and spend history. Change
 * one side, change the other; `tests/unit/claude-usage.test.ts` asserts the pair at runtime.
 *
 * PERCENT-based, not token-based: the source reports utilization as 0-100 with a reset time,
 * and there is no used/limit token pair behind it to reconstruct. The interface models what
 * the source actually provides.
 */
export interface UsageLimitWire {
  key: 'session' | 'weekly';
  /** 0-100. */
  percent: number;
  /** Epoch ms at which this window resets. */
  resetsAt: number;
  /** Set only when a per-model cap is the binding one, e.g. "Fable". */
  scope?: string;
}

/** The body of `GET /api/agent/usage-limits`. MIRRORED in `src/lib/claude-usage.ts`.
 *  `fetchedAtMs` is when CLAUDE CODE last refreshed its cache, not when we read it — it is
 *  the only thing that can tell a live reading from a day-old one. */
export interface UsageLimitsResponse {
  limits: UsageLimitWire[];
  fetchedAtMs: number | null;
}

/** One rendered bar. `context` is computed locally and has no reset; the account caps come
 *  off the wire and always do. */
export interface UsageLimit {
  key: 'context' | 'session' | 'weekly';
  title: string;
  /** 0-100. */
  percent: number;
  resetsAt: number | null;
  /** Context only — the raw reading behind the percent, for the row's `used / limit` line. */
  detail?: { used: number; limit: number };
  /** Weekly only, when a per-model cap is the binding one. */
  scope?: string;
}

/** Past this the cache is old enough to be worth LABELLING ("as of 14:20") — the number is
 *  still probably right, but the user should know it isn't live. */
export const USAGE_STALE_MS = 30 * 60_000;
/** Past this it isn't worth showing at all. Six hours is longer than the 5-hour window it
 *  would be describing, so the bar could be a full window out of date — and a confidently
 *  wrong "20% used" is worse than no bar. */
export const USAGE_MAX_AGE_MS = 6 * 60 * 60_000;

const USAGE_TITLES: Record<UsageLimitWire['key'], string> = {
  session: '5-hour session',
  weekly: 'Weekly',
};
/** Render order, independent of whatever order the wire happened to use. */
const USAGE_ORDER: Record<UsageLimitWire['key'], number> = { session: 0, weekly: 1 };

function isPercent(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100;
}

/**
 * The bars to draw, in order, plus when to admit the account readings are stale.
 *
 * `now` is injected rather than read from `Date.now()` so this stays pure and the staleness
 * rules are testable without faking the clock.
 *
 * Four things drop a bar, and all four are "we don't actually know", not "it's zero":
 *   • no response, or a response with no `fetchedAtMs` — the server found no source;
 *   • a cache older than {@link USAGE_MAX_AGE_MS};
 *   • a `resetsAt` already in the past — that window has rolled over, so its percent
 *     describes a window that no longer exists. This is the subtle one: the data isn't
 *     stale in the "old file" sense, it is stale in the "wrong window" sense, and only the
 *     reset time can reveal it;
 *   • a percent outside 0-100. The server drops these too; this is the second layer, because
 *     a clamped-into-range lie renders identically to the truth.
 *
 * `staleAsOf` is non-null only when at least one account bar SURVIVED — an "as of 09:00"
 * caption under a popover showing nothing but the context bar labels the wrong thing.
 */
export function usageLimits(
  ctx: ContextUsage | null,
  res: UsageLimitsResponse | null,
  now: number,
): { limits: UsageLimit[]; staleAsOf: number | null } {
  const limits: UsageLimit[] = [];
  if (ctx) {
    limits.push({
      key: 'context',
      title: 'Context window',
      percent: Math.min(100, Math.max(0, ctx.pct)),
      resetsAt: null,
      detail: { used: ctx.used, limit: ctx.limit },
    });
  }

  const fetchedAtMs = res?.fetchedAtMs ?? null;
  if (fetchedAtMs === null) return { limits, staleAsOf: null };
  // A cache stamped in the future is clock skew, not freshness — clamp the age at 0 rather
  // than letting a negative number pass every threshold below.
  const age = Math.max(0, now - fetchedAtMs);
  if (age > USAGE_MAX_AGE_MS) return { limits, staleAsOf: null };

  const account = (res?.limits ?? [])
    .filter((l) => isPercent(l.percent) && Number.isFinite(l.resetsAt) && l.resetsAt > now)
    .sort((a, b) => (USAGE_ORDER[a.key] ?? 99) - (USAGE_ORDER[b.key] ?? 99))
    .map((l): UsageLimit => ({
      key: l.key,
      title: l.scope ? `${USAGE_TITLES[l.key]} · ${l.scope}` : USAGE_TITLES[l.key],
      percent: l.percent,
      resetsAt: l.resetsAt,
      ...(l.scope ? { scope: l.scope } : {}),
    }));

  limits.push(...account);
  return { limits, staleAsOf: account.length > 0 && age > USAGE_STALE_MS ? fetchedAtMs : null };
}

/**
 * POSIX-safe rendering of a file path for injection into the terminal input: strip control
 * chars (a newline would submit early), leave a simple path bare, single-quote-escape one
 * with spaces/special chars. Mirrors the drag-drop path quoting in AgentSurface.
 */
export function quotePath(p: string): string {
  const clean = [...p].filter((ch) => { const c = ch.codePointAt(0) ?? 0; return c >= 0x20 && c !== 0x7f; }).join('');
  if (/^[\w@%+=:,./-]+$/.test(clean)) return clean;
  return `'${clean.replace(/'/g, "'\\''")}'`;
}
