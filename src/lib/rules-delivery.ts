/**
 * The one entry that decides which learned rules reach an agent (learning loop C6, C7).
 *
 * Measured after W1 (plan "After W1"): no per-message matcher reaches his repeats without firing on
 * most turns, so rules reach agents by POSITION, never by matching his words:
 *   - session start (and again after a compaction): every active rule in short form with its id
 *     ({@link preferencesBlock}, the snapshot's "His preferences");
 *   - each owner turn and finished-work event (P1): the `always`, hot and `report`/`ask` rules as
 *     "Before you answer him:" lines;
 *   - a sub-agent's start and a dispatch prompt: the `always` and hot rules;
 *   - before something that cannot be taken back (D16d): the `act` rules and the matching section
 *     of every `at: act` pattern, opened in full, keyed by a fixed command list ({@link actKind}).
 * `matched[]` stays empty: the shape is kept for a later matcher and the evals.
 *
 * Cheap comes from form, never from a count (D4): every rule rides as its headline. The only size
 * limit is the host's: a block that would cross it folds its lightest lines into one "more" line,
 * and nothing is cut mid-rule ({@link foldLines}).
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { promptOwnerText } from './agents/team-roster.js';
import { SUPER_EVENT_PREFIXES } from './super/types.js';
import { foldAscii } from './fold-ascii.js';
import { loadPatterns, type PatternDoc } from './patterns.js';
import { HOOK_OUTPUT_MAX_CHARS } from './snapshot-budget.js';
import {
  deriveAll, personalRulesVisible, personalStoreRef, projectStoreRef, readStore, RulesStoreError,
  type RuleView,
} from './rules-store.js';

export type DeliverySurface = 'owner' | 'child' | 'dispatch' | 'finished' | 'act' | 'machine';
export type DeliverInput = Record<string, unknown> & { surface: DeliverySurface };

export interface Delivery {
  /** Rules tagged `always` (what he reads), in short form. */
  always: string[];
  /** The moment lines (P1): hot and `report`/`ask` rules; on `act` the opened rules and sections. */
  moment: string[];
  /** Rules and pattern sections matched to the job text (empty: delivery is by position). */
  matched: string[];
  /** Characters of all three arrays as printed. */
  chars: number;
  /** How many rules and pattern cards were considered. */
  considered: number;
}

export interface DeliveryOpts {
  home?: string;
  now?: Date;
  /** Room for the turn's lines (default {@link TURN_LINES_MAX_CHARS}); the host's limit, never a count. */
  max?: number;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * The text a turn is about: his own words for an owner turn, the Agent prompt for a dispatch, the
 * command line (or the tool's name) for an act; nothing for the rest.
 */
export function jobText(input: DeliverInput): string {
  switch (input.surface) {
    case 'owner':
      return promptOwnerText(str(input.prompt)) ?? '';
    case 'dispatch': {
      const ti = (input.tool_input ?? {}) as Record<string, unknown>;
      return str(ti.prompt);
    }
    case 'act': {
      const ti = (input.tool_input ?? {}) as Record<string, unknown>;
      return str(ti.command) || str(input.tool_name);
    }
    default:
      return '';
  }
}

/**
 * Which surface a prompt-hook turn is: `owner` when it carries his words, `finished` for a task
 * notification or a Super event (ended work being reported), `machine` for anything else.
 */
export function promptSurface(prompt: string): DeliverySurface {
  if (promptOwnerText(prompt) !== null) return 'owner';
  if (prompt.includes('<task-notification>') || SUPER_EVENT_PREFIXES.some((p) => prompt.startsWith(p))) return 'finished';
  return 'machine';
}

// ─── The rules in force ─────────────────────────────────────────────────────

export interface RulesInForce {
  /** Active rules of both stores, heaviest first (personal ones only where they are shown). */
  active: RuleView[];
  /** Rules waiting for his word. */
  proposed: RuleView[];
  /** One line each: a store that does not parse, personal rules not shown here. */
  notes: string[];
}

function readViews(read: () => ReturnType<typeof readStore>, label: string, now: Date, notes: string[]): RuleView[] {
  try {
    return deriveAll(read(), now);
  } catch (e) {
    if (e instanceof RulesStoreError) {
      notes.push(`The ${label} rules store is unreadable (${e.message}); its rules are not shown. \`dreamcontext learn list\` names the file.`);
      return [];
    }
    throw e;
  }
}

/** Both stores' rules as an agent would get them; never throws for a missing or broken store. */
export function rulesInForce(contextRoot: string | null, opts: DeliveryOpts = {}): RulesInForce {
  const home = opts.home ?? homedir();
  const now = opts.now ?? new Date();
  const notes: string[] = [];
  const views: RuleView[] = [];
  const shown = contextRoot ? personalRulesVisible(contextRoot, home) : { visible: true, line: null };
  if (shown.visible) views.push(...readViews(() => readStore(personalStoreRef(home)), 'personal', now, notes));
  else if (shown.line) notes.push(shown.line);
  if (contextRoot) views.push(...readViews(() => readStore(projectStoreRef(contextRoot, home)), 'project', now, notes));
  const heaviest = (a: RuleView, b: RuleView): number => weightOrder(a, b);
  return {
    active: views.filter((v) => v.status === 'active').sort(heaviest),
    proposed: views.filter((v) => v.status === 'proposed').sort(heaviest),
    notes,
  };
}

/** Hot first, then repeats, then the most recent saying (the store's byWeight, across both stores). */
function weightOrder(a: RuleView, b: RuleView): number {
  if (a.hot !== b.hot) return a.hot ? -1 : 1;
  if (a.repeats !== b.repeats) return b.repeats - a.repeats;
  const la = a.sayings.at(-1)?.at ?? a.created.at;
  const lb = b.sayings.at(-1)?.at ?? b.created.at;
  return la < lb ? 1 : la > lb ? -1 : 0;
}

// ─── Short form and the host limit ──────────────────────────────────────────

/** One line per rule: its headline and id; a hot rule (said again lately) also carries its text. */
export function shortForm(v: RuleView): string {
  const where = v.scope === 'me' ? '' : ', this project';
  if (v.hot && v.text && v.text !== v.headline) return `- ${v.headline} [${v.id}, said again${where}]: ${v.text}`;
  return `- ${v.headline} [${v.id}${where}]`;
}

/** The full text of a rule, for the `act` opening. */
function fullForm(v: RuleView): string {
  return v.text && v.text !== v.headline ? `- ${v.headline} [${v.id}]: ${v.text}` : `- ${v.headline} [${v.id}]`;
}

/**
 * Keep whole lines, heaviest first (the order given), inside `max` characters; the lines that do
 * not fit fold into one "more" line naming how many and where they are. Never cuts a line.
 */
export function foldLines(lines: readonly string[], max: number, more: (n: number) => string): string[] {
  const out: string[] = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const rest = lines.length - i - 1;
    const tail = rest > 0 ? more(rest).length + 1 : 0;
    if (used + line.length + 1 + tail > max) {
      out.push(more(lines.length - i));
      return out;
    }
    out.push(line);
    used += line.length + 1;
  }
  return out;
}

const MORE_LINE = (n: number): string => `- … ${n} more: \`dreamcontext learn list\``;

// ─── Session start ──────────────────────────────────────────────────────────

/** Room the session-start block may take: well inside one session-start part (9,800 chars). */
export const PREFERENCES_BLOCK_MAX_CHARS = 6_000;

/**
 * The snapshot's "His preferences" block: every active rule in short form with its id, heaviest
 * first, then the ids still waiting for his word. Null when there is nothing to say.
 */
export function preferencesBlock(contextRoot: string, opts: DeliveryOpts & { max?: number } = {}): string | null {
  const r = rulesInForce(contextRoot, opts);
  if (r.active.length === 0 && r.proposed.length === 0 && r.notes.length === 0) return null;
  const L: string[] = ['### His preferences (learned rules, `dreamcontext learn`)', ''];
  if (r.active.length > 0) {
    L.push('Every rule below is in force. Follow each one; edit one by its id (`learn --same|--replaces <id>`), never add a twin.');
    L.push(...foldLines(r.active.map(shortForm), opts.max ?? PREFERENCES_BLOCK_MAX_CHARS, MORE_LINE));
  }
  if (r.proposed.length > 0) {
    const ids = r.proposed.map((v) => v.id).join(', ');
    L.push(`Waiting for his word (proposed, not in force): ${ids}. In the app's chat show each as its card (\`{"type":"learned","id":"<id>"}\` in a dream-view block); elsewhere name them and say \`dreamcontext learn keep <id>\` keeps one.`);
  }
  L.push(...r.notes);
  return L.join('\n');
}

// ─── Turn delivery ──────────────────────────────────────────────────────────

/**
 * Room the per-turn lines may take inside the one prompt hook addition: the rules are its must-print
 * part, so they get all of it but the room the other must lines take; memory takes what they leave.
 */
export const TURN_LINES_MAX_CHARS = HOOK_OUTPUT_MAX_CHARS - 1_800;

function empty(considered = 0): Delivery {
  return { always: [], moment: [], matched: [], chars: 0, considered };
}

function sized(d: Omit<Delivery, 'chars'>): Delivery {
  const chars = [...d.always, ...d.moment, ...d.matched].reduce((n, l) => n + l.length + 1, 0);
  return { ...d, chars };
}

/**
 * What rules ride with this turn, by position (see the file head). Never throws: a broken store is
 * a note in the session-start block, and here it delivers nothing.
 */
export function deliverForTurn(root: string, input: DeliverInput, opts: DeliveryOpts = {}): Delivery {
  if (input.surface === 'machine') return empty();
  let r: RulesInForce;
  try { r = rulesInForce(root, opts); } catch { return empty(); }
  if (input.surface === 'act') return actDelivery(root, input, r.active);
  const always = r.active.filter((v) => v.at_tag === 'always');
  const rest = r.active.filter((v) => v.at_tag !== 'always' && (v.hot
    || ((input.surface === 'owner' || input.surface === 'finished') && (v.at_tag === 'report' || v.at_tag === 'ask'))));
  const lines = foldLines([...always, ...rest].map(shortForm), opts.max ?? TURN_LINES_MAX_CHARS, MORE_LINE);
  return sized({
    always: lines.slice(0, Math.min(always.length, lines.length)),
    moment: lines.slice(Math.min(always.length, lines.length)),
    matched: [],
    considered: r.active.length,
  });
}

/** The P1 text for an owner turn or a finished-work event; null when no rule rides. */
export function momentLines(d: Delivery): string | null {
  const lines = [...d.always, ...d.moment];
  if (lines.length === 0) return null;
  return ['Before you answer him (his rules in force, `dreamcontext learn`):', ...lines].join('\n');
}

/** The block a sub-agent gets at its start and inside its dispatch prompt; null when none rides. */
export function helperLines(d: Delivery): string | null {
  const lines = [...d.always, ...d.moment];
  if (lines.length === 0) return null;
  return ['His rules for every agent (the owner\'s, `dreamcontext learn`):', ...lines,
    'The rest: `dreamcontext learn list --me`.'].join('\n');
}

/** The delimiters a dispatch prompt's appended rules sit between. */
export const DISPATCH_RULES_OPEN = '<dreamcontext-owner-rules>';
export const DISPATCH_RULES_CLOSE = '</dreamcontext-owner-rules>';

/** The dispatch prompt with the rules appended between the delimiters; null when nothing changes. */
export function appendToDispatch(prompt: string, d: Delivery): string | null {
  const block = helperLines(d);
  if (!block || prompt.includes(DISPATCH_RULES_OPEN)) return null;
  return `${prompt}\n\n${DISPATCH_RULES_OPEN}\n${block}\n${DISPATCH_RULES_CLOSE}`;
}

// ─── Before something that cannot be taken back (D16d) ──────────────────────

export type ActKind = 'npm publish' | 'git push' | 'git tag' | 'gh release' | 'gh pr merge' | 'send';

/** The words a rule or a pattern section about each act names (folded, lower case). */
const ACT_WORDS: Record<ActKind, readonly string[]> = {
  'npm publish': ['publish', 'npm', 'yayin', 'release', 'surum'],
  'git push': ['push'],
  'git tag': ['tag', 'etiket'],
  'gh release': ['release', 'surum', 'yayin'],
  'gh pr merge': ['merge', 'birlestir'],
  send: ['send', 'post', 'publish', 'gonder', 'paylas', 'yayin', 'mesaj', 'message'],
};
const ALL_ACT_WORDS = [...new Set(Object.values(ACT_WORDS).flat())];

const fold = (s: string): string => foldAscii(s).toLowerCase();

/**
 * Words of each simple command (split on ; & | newlines and parentheses). Quoted text is one
 * opaque word first, so a commit message or a heredoc line that says "push" or "publish" is
 * never read as the command itself.
 */
function simpleCommands(command: string): string[][] {
  const unquoted = command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, ' __q__ ');
  return unquoted.split(/[;&|\n()]+/).map((seg) => seg.trim().split(/\s+/).filter(Boolean)).filter((t) => t.length > 0);
}

/** Options that take the next word as their value, per binary (`git -C dir`, `npm -w pkg`). */
const VALUE_OPTIONS: Record<string, readonly string[]> = {
  git: ['-C', '-c', '--git-dir', '--work-tree', '--namespace'],
  npm: ['-w', '--workspace', '--prefix', '--registry', '--tag', '--otp'],
  pnpm: ['-C', '--dir', '-F', '--filter', '--registry', '--tag', '--otp'],
  yarn: ['--cwd'],
  gh: ['-R', '--repo'],
};

/**
 * The positional words after `bin` in one simple command: options and their values skipped, so
 * `git -C dir push` gives `push`. The binary is the command word itself (a path ending in `/git`
 * counts); an env assignment or `sudo`/`command`/`exec` before it is skipped. Null: not this binary.
 */
function positionals(t: readonly string[], bin: string): string[] | null {
  let i = 0;
  while (i < t.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t[i]!) || t[i] === 'sudo' || t[i] === 'command' || t[i] === 'exec')) i += 1;
  const head = t[i];
  if (!head || (head !== bin && !head.endsWith(`/${bin}`))) return null;
  const takesValue = VALUE_OPTIONS[bin] ?? [];
  const out: string[] = [];
  for (let j = i + 1; j < t.length; j += 1) {
    const w = t[j]!;
    if (w.startsWith('-')) {
      if (!w.includes('=') && takesValue.includes(w)) j += 1;
      continue;
    }
    out.push(w);
  }
  return out;
}

/**
 * The act a tool call is, from a short fixed list, or null. The act is the binary's own
 * subcommand (`git push`, `cd x && npm publish`, `git -C dir push`), never a word inside quotes or
 * a later argument (`git commit -m "fix push token"`, `git stash push`); an MCP tool counts when
 * its own name says it sends, posts or publishes. Pure and cheap: a call that is not on the list
 * reads no store.
 */
export function actKind(toolName: string, toolInput: Record<string, unknown>): ActKind | null {
  if (toolName === 'Bash') {
    const command = str(toolInput.command);
    if (!command) return null;
    for (const t of simpleCommands(command)) {
      for (const bin of ['npm', 'pnpm', 'yarn']) {
        if (positionals(t, bin)?.[0] === 'publish') return 'npm publish';
      }
      const git = positionals(t, 'git');
      if (git?.[0] === 'push') return 'git push';
      if (git?.[0] === 'tag') {
        const i = t.indexOf('tag');
        const args = t.slice(i + 1);
        if (args.length > 0 && !args.some((a) => a === '-l' || a === '--list' || a === '-v' || a === '--verify' || a === '-n')) return 'git tag';
      }
      const gh = positionals(t, 'gh');
      if (gh?.[0] === 'release' && ['create', 'upload', 'edit', 'delete'].includes(gh[1] ?? '')) return 'gh release';
      if (gh?.[0] === 'pr' && gh[1] === 'merge') return 'gh pr merge';
    }
    return null;
  }
  if (toolName.startsWith('mcp__')) {
    const own = toolName.split('__').slice(2).join('__') || toolName;
    if (/(^|[_\-.])(send|post|publish|reply|broadcast)/i.test(own) || /(send|post|publish)(_|$)/i.test(own)) return 'send';
  }
  return null;
}

function mentions(text: string, words: readonly string[]): number {
  const t = fold(text);
  let n = 0;
  for (const w of words) if (t.includes(w)) n += 1;
  return n;
}

/** An `act` rule applies to this act when it names it, or when it names no act at all. */
function actRuleApplies(v: RuleView, kind: ActKind): boolean {
  const text = [v.headline, v.text, ...v.says].join(' ');
  return mentions(text, ACT_WORDS[kind]) > 0 || mentions(text, ALL_ACT_WORDS) === 0;
}

interface Section { title: string; body: string }

function sectionsOf(file: string): { lead: Section; sections: Section[] } {
  let raw = '';
  try { raw = readFileSync(file, 'utf-8'); } catch { return { lead: { title: '', body: '' }, sections: [] }; }
  const text = raw.replace(/^---\n[\s\S]*?\n---\n?/, '');
  const parts = text.split(/^(?=## )/m);
  const leadText = parts[0]?.startsWith('## ') ? '' : (parts.shift() ?? '');
  return {
    lead: { title: '', body: leadText.trim() },
    sections: parts.map((p) => ({ title: p.split('\n', 1)[0]!.replace(/^##\s*/, '').trim(), body: p.trim() })),
  };
}

/** Room the opened text may take inside the refusal's reason. */
export const ACT_TEXT_MAX_CHARS = 8_000;

function actDelivery(root: string, input: DeliverInput, active: RuleView[]): Delivery {
  const ti = (input.tool_input ?? {}) as Record<string, unknown>;
  const kind = actKind(str(input.tool_name), ti);
  if (!kind) return empty();
  const rules = active.filter((v) => v.at_tag === 'act' && actRuleApplies(v, kind)).map(fullForm);
  let patterns: PatternDoc[] = [];
  try { patterns = loadPatterns(root).filter((p) => p.act && !p.generated); } catch { patterns = []; }
  const opened: string[] = [];
  const words = ACT_WORDS[kind];
  for (const p of patterns) {
    const { lead, sections } = sectionsOf(p.file);
    const hits = sections.map((s) => ({ s, n: mentions(s.body, words) })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
    if (hits.length === 0 && mentions(`${p.name} ${p.description} ${lead.body}`, words) === 0) continue;
    const bodies = hits.length > 0 ? hits.map((h) => h.s.body) : [lead.body || sections[0]?.body || ''];
    opened.push(`From the pattern ${p.relPath}:`, ...bodies.filter(Boolean));
  }
  const all = [...rules, ...opened];
  if (all.length === 0) return empty(active.length + patterns.length);
  const lines = foldLines(all, ACT_TEXT_MAX_CHARS, (n) => `- … ${n} more: \`dreamcontext learn list\` and the patterns named above`);
  return sized({ always: [], moment: lines, matched: [], considered: active.length + patterns.length });
}

/** The refusal's reason before an act: the opened text, then "run it again once this holds". */
export function actRefusal(kind: ActKind, d: Delivery): string | null {
  if (d.moment.length === 0) return null;
  return [
    `Not run yet: this is \`${kind}\`, which cannot be taken back, and his rules for it say:`,
    ...d.moment,
    'Do what they say first, then run the same call again once this holds (it is not stopped twice in this session).',
  ].join('\n');
}
