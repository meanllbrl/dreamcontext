import manifestJson from '../../../generated/cli-manifest.json';

/**
 * Recognising dreamcontext's OWN CLI inside a shell call.
 *
 * The problem (owner report 08-01): the agent does most of its work on this project THROUGH
 * this project — `dreamcontext tasks create …`, `dreamcontext memory recall …` — and every one
 * of those arrived in the transcript as an anonymous `▶ Bash` row wearing whatever sentence the
 * agent happened to write in `description`. The app could not see itself working. A row that
 * created a task looked exactly like a row that ran `ls`, and the one thing a reader wants from
 * it — WHICH task, WHAT changed — sat unparsed in the command line.
 *
 * The rule this module implements is the same one the tool rows already follow: **a row names
 * its object, not its type.** `dreamcontext tasks create "Fix the parser" -p high` is not "a
 * bash call"; it is a TASK, CREATED, named "Fix the parser".
 *
 * ── Why a manifest, and not a list of commands written by hand ──────────────────────────────
 *
 * To read that command line you must know one thing no amount of string-matching can tell you:
 * whether `create` is a SUBCOMMAND of `tasks` or an ARGUMENT to it. That fact lives in
 * `src/cli/program.ts` and nowhere else, so it is derived from there — `buildCliManifest` walks
 * the real commander tree into `dashboard/src/generated/cli-manifest.json`, and
 * `tests/unit/cli-manifest.test.ts` fails the suite when the file and the tree disagree.
 *
 * That is deliberate, and it is the answer to "what happens when someone adds an endpoint":
 * NOTHING has to happen here. A new command is parsed, named, and rendered from its own
 * `.description()` and its own declared arguments the moment the manifest is regenerated. The
 * lexicon below only makes a label read more like English than the generic rule manages; it is
 * an override, never a registry, and a domain missing from it still renders correctly.
 *
 * This repo has already paid for the alternative twice — a hand-mirrored constant in the
 * dashboard drifting two rescales behind the backend while every test stayed green.
 */

// ─── The manifest ──────────────────────────────────────────────────────────────────

export interface CliEndpoint {
  path: string;
  desc: string;
  args: string[];
  group?: true;
  aliases?: string[];
  valueFlags?: string[];
}

const ENDPOINTS: CliEndpoint[] = (manifestJson as { endpoints: CliEndpoint[] }).endpoints;

const BY_PATH = new Map<string, CliEndpoint>(ENDPOINTS.map((e) => [e.path, e]));

/** `"" + alias` → canonical path, so `dreamcontext mk …` resolves to `marketing`. Keyed by the
 *  PARENT path so two different groups may reuse an alias without colliding. */
const BY_ALIAS = new Map<string, string>();
for (const e of ENDPOINTS) {
  if (!e.aliases) continue;
  const cut = e.path.lastIndexOf(' ');
  const parent = cut === -1 ? '' : e.path.slice(0, cut);
  for (const alias of e.aliases) BY_ALIAS.set(parent ? `${parent} ${alias}` : alias, e.path);
}

export function cliEndpoint(path: string): CliEndpoint | undefined {
  return BY_PATH.get(path);
}

// ─── Reading a shell line ──────────────────────────────────────────────────────────

/** Command-position wrappers to skip when looking for the executable — mirrors the set
 *  `looksLikeHeadlessClaude` uses, for the same reason: `npx dreamcontext …` is dreamcontext. */
const COMMAND_WRAPPERS: ReadonlySet<string> = new Set([
  'npx', 'bunx', 'pnpm', 'yarn', 'nohup', 'exec', 'command', 'time', 'env', 'stdbuf', 'caffeinate',
]);

/** Opens a heredoc: `<<EOF`, `<<-EOF`, `<<'EOF'`, `<< "EOF"`. `<<<` (a herestring) does not
 *  match — its next character is `<`, not a word character. */
const HEREDOC_OPEN_RE = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/;

/**
 * Drop the BODY of every heredoc, keeping the line that opened it.
 *
 * Without this, a file written through a heredoc would be reported as work performed:
 *
 *     cat <<'EOF' > notes.md
 *     dreamcontext tasks create "Something"
 *     EOF
 *
 * …would render a "Task created" row for a task that was never created. That is precisely the
 * quiet wrongness this whole feature exists to remove, so the text inside a heredoc is treated
 * as what it is — data, not commands. The opening line is KEPT, because it can carry a real
 * invocation of its own (`dreamcontext tasks insert t notes "$(cat)" <<EOF`).
 */
function stripHeredocBodies(command: string): string {
  if (!command.includes('<<')) return command;
  const kept: string[] = [];
  let terminator: string | null = null;
  for (const line of command.split('\n')) {
    if (terminator !== null) {
      // The terminator line goes too — it is the heredoc's punctuation, not a command.
      if (line.trim() === terminator) terminator = null;
      continue;
    }
    kept.push(line);
    const open = HEREDOC_OPEN_RE.exec(line);
    if (open) terminator = open[2];
  }
  return kept.join('\n');
}

/**
 * Split a command line on shell separators WITHOUT splitting inside quotes.
 *
 * The quote-awareness is the whole point and is why this doesn't reuse the naive splitter in
 * `chatEntities.ts`: `dreamcontext tasks insert t Notes "a; b"` is one command, and a splitter
 * that cuts at that semicolon reports a second, garbage invocation.
 */
export function splitShellSegments(command: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  const source = stripHeredocBodies(command);
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    if (quote) {
      cur += c;
      if (c === '\\' && quote === '"' && i + 1 < command.length) { cur += command[i + 1]; i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '\n' || c === ';' || c === '|' || c === '&') {
      // `&&`/`||` are two characters; a lone `&` (background) ends the command just the same.
      if ((c === '|' || c === '&') && command[i + 1] === c) i += 1;
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * Split one segment into argv, honouring quotes and backslash escapes.
 *
 * An empty quoted string survives as an empty token (`--why ""` is a real thing an agent
 * writes), which is why the flush is gated on `quoted` as well as on content.
 */
export function tokenizeShell(segment: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let quoted = false;
  const flush = () => { if (cur || quoted) out.push(cur); cur = ''; quoted = false; };
  for (let i = 0; i < segment.length; i += 1) {
    const c = segment[i];
    if (quote) {
      if (c === '\\' && quote === '"' && i + 1 < segment.length) { cur += segment[i + 1]; i += 1; continue; }
      if (c === quote) { quote = null; continue; }
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; quoted = true; continue; }
    if (c === '\\' && i + 1 < segment.length) { cur += segment[i + 1]; i += 1; continue; }
    if (/\s/.test(c)) { flush(); continue; }
    cur += c;
  }
  flush();
  return out;
}

/** One recognised `dreamcontext …` invocation. */
export interface DreamAction {
  /** Canonical manifest path (`tasks create`), or the raw tokens when unrecognised. */
  path: string;
  /** First path segment — the entity family (`tasks`, `memory`). */
  domain: string;
  /** Second path segment, when the domain is a group. Absent for `snapshot`, `doctor`. */
  action?: string;
  /** Positional arguments, in order, unquoted. */
  args: string[];
  /** Flags as written: `--priority` → `high`, `--json` → `true`. */
  flags: Record<string, string | true>;
  /** Did the manifest recognise this path? A `false` still renders — see `describeDreamAction`
   *  — it just can't promise the domain/action split is right. */
  known: boolean;
  /** The endpoint's own `.description()`, when known. */
  desc?: string;
  /** The segment as typed, for the title attribute. */
  raw: string;
}

/** Is `token` the dreamcontext executable? Accepts a path-qualified or version-pinned form
 *  (`~/.local/bin/dreamcontext`, `dreamcontext@latest`), and nothing else. */
function isDreamcontextExe(token: string): boolean {
  const base = token.replace(/^[({'"]+/, '').replace(/['"]+$/, '').replace(/^.*\//, '');
  return base === 'dreamcontext' || base.startsWith('dreamcontext@');
}

/** Resolve as deep into the command tree as the tokens actually go, following aliases.
 *  Returns the canonical path and how many tokens it consumed. */
function resolvePath(tokens: string[]): { path: string; used: number; endpoint?: CliEndpoint } {
  let path = '';
  let used = 0;
  let endpoint: CliEndpoint | undefined;
  while (used < tokens.length) {
    const token = tokens[used];
    if (token.startsWith('-')) break;
    const candidate = path ? `${path} ${token}` : token;
    const resolved = BY_PATH.has(candidate) ? candidate : BY_ALIAS.get(candidate);
    if (!resolved) break;
    path = resolved;
    used += 1;
    endpoint = BY_PATH.get(path);
    // A leaf's next token is an ARGUMENT, not a subcommand — stop descending.
    if (!endpoint?.group) break;
  }
  return { path, used, endpoint };
}

/**
 * Pull the positional arguments out, skipping flags and the values they consume.
 *
 * `valueFlags` comes from the manifest, so `tasks create -p high "Fix it"` is titled "Fix it"
 * and not "high". For an UNRECOGNISED endpoint there is no such list, and the fallback is the
 * only reading that is right more often than not on this CLI: a flag followed by a non-flag
 * token is assumed to consume it.
 */
function readArgs(tokens: string[], endpoint?: CliEndpoint): { args: string[]; flags: Record<string, string | true> } {
  const valueFlags = new Set(endpoint?.valueFlags ?? []);
  const args: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === '--') { args.push(...tokens.slice(i + 1)); break; }
    if (token.length > 1 && token.startsWith('-')) {
      const eq = token.indexOf('=');
      if (eq > 0) { flags[token.slice(0, eq)] = token.slice(eq + 1); continue; }
      const next = tokens[i + 1];
      const takesValue = endpoint
        ? valueFlags.has(token)
        : next !== undefined && !next.startsWith('-');
      if (takesValue && next !== undefined) { flags[token] = next; i += 1; continue; }
      flags[token] = true;
      continue;
    }
    args.push(token);
  }
  return { args, flags };
}

/** Cheap prefilter — `parseDreamActions` is a real parse, and most Bash rows are not ours. */
export function mentionsDreamcontext(command: string | undefined): boolean {
  return !!command && command.includes('dreamcontext');
}

/**
 * Every dreamcontext invocation in a shell command, in order.
 *
 * A list, not a single value, because one `Bash` call routinely carries several: the agent
 * chains `tasks create && tasks insert && tasks insert` in one line, and a card that reported
 * only the first would be quietly wrong about what the row did.
 */
export function parseDreamActions(command: string | undefined): DreamAction[] {
  if (!mentionsDreamcontext(command)) return [];
  const out: DreamAction[] = [];
  for (const segment of splitShellSegments(command as string)) {
    const tokens = tokenizeShell(segment);
    let i = 0;
    // Skip `FOO=bar`, wrappers, and their flags to reach the executable.
    while (i < tokens.length) {
      const t = tokens[i];
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t) || t.startsWith('-') || COMMAND_WRAPPERS.has(t)) { i += 1; continue; }
      break;
    }
    const exe = tokens[i];
    if (!exe || !isDreamcontextExe(exe)) continue;
    const rest = tokens.slice(i + 1);
    const { path, used, endpoint } = resolvePath(rest);
    const { args, flags } = readArgs(rest.slice(used), endpoint);
    if (path) {
      const [domain, action] = path.split(' ');
      out.push({ path, domain, action, args, flags, known: true, desc: endpoint?.desc, raw: segment });
      continue;
    }
    // Unrecognised: a command this build's manifest doesn't carry (a newer CLI, a typo). Name
    // it from the tokens rather than dropping the row — the mark and the words are still more
    // than "Bash" was, and `known:false` keeps anything downstream from over-claiming.
    const words = rest.filter((t) => !t.startsWith('-'));
    if (!words.length) continue;
    out.push({
      path: words.slice(0, 2).join(' '),
      domain: words[0],
      action: words[1],
      args: words.slice(2),
      flags,
      known: false,
      raw: segment,
    });
  }
  return out;
}

/** Does this shell command run dreamcontext at all? The predicate the transcript uses to give
 *  the call its own row instead of folding it into a generic tool run. */
export function isDreamcontextCommand(command: string | undefined): boolean {
  return parseDreamActions(command).length > 0;
}

// ─── Saying what it did ────────────────────────────────────────────────────────────

/** What the call DOES to the brain — the row's colour, and the only thing a reader scanning a
 *  long turn actually needs: did this change something, or just look something up? */
export type DreamTone = 'read' | 'write' | 'destructive';

interface VerbLabel {
  /** Reads after the noun: `Task` + `created`. */
  text: string;
  tone: DreamTone;
  /** Keep the domain word plural (`Tasks list`, not `Task list`). */
  plural?: true;
}

/**
 * Verbs that read better than their bare token, and the tone each one carries.
 *
 * NOT a registry of commands — an unknown verb falls through to itself, which is why a brand
 * new endpoint still renders as `Thesis promote` without anyone touching this file. Entries
 * exist only where English wanted a different word, or where the tone is not guessable.
 */
const VERBS: Record<string, VerbLabel> = {
  create: { text: 'created', tone: 'write' },
  add: { text: 'added', tone: 'write' },
  insert: { text: 'inserted', tone: 'write' },
  update: { text: 'updated', tone: 'write' },
  set: { text: 'set', tone: 'write' },
  log: { text: 'logged', tone: 'write' },
  complete: { text: 'completed', tone: 'write' },
  remember: { text: 'remembered', tone: 'write' },
  touch: { text: 'touched', tone: 'write' },
  move: { text: 'moved', tone: 'write' },
  merge: { text: 'merged', tone: 'write' },
  rename: { text: 'renamed', tone: 'write' },
  index: { text: 'indexed', tone: 'write' },
  sync: { text: 'synced', tone: 'write' },
  start: { text: 'started', tone: 'write' },
  record: { text: 'recorded', tone: 'write' },
  dedup: { text: 'deduped', tone: 'write' },
  delete: { text: 'deleted', tone: 'destructive' },
  remove: { text: 'removed', tone: 'destructive' },
  rm: { text: 'removed', tone: 'destructive' },
  retire: { text: 'retired', tone: 'destructive' },
  clear: { text: 'cleared', tone: 'destructive' },
  list: { text: 'list', tone: 'read', plural: true },
  ls: { text: 'list', tone: 'read', plural: true },
  recall: { text: 'recall', tone: 'read' },
  search: { text: 'search', tone: 'read' },
  show: { text: 'show', tone: 'read' },
  get: { text: 'get', tone: 'read' },
  tags: { text: 'tags', tone: 'read', plural: true },
  vocab: { text: 'vocabulary', tone: 'read' },
  audit: { text: 'audit', tone: 'read' },
  doctor: { text: 'check', tone: 'read' },
};

/**
 * Verbs that are a QUESTION with no argument and an ORDER with one — `sleep status` reports,
 * `tasks status <slug> in_progress` changes. Resolved by arity rather than by listing every
 * command that uses the word, because the ambiguity is in the English, not in the endpoint.
 */
const ARITY_SENSITIVE: ReadonlySet<string> = new Set(['status', 'tag', 'version', 'field', 'due', 'objectives', 'feature', 'config']);

/**
 * Domains the generic rule gets wrong — an `s` that is part of the stem (`theses`), an
 * irregular plural (`people`), or a command name that isn't the noun anyone says for it
 * (`roadmap` manages OBJECTIVES; `lab` holds INSIGHTS). Everything else is derived.
 */
const NOUNS: Record<string, { one: string; many: string }> = {
  theses: { one: 'Thesis', many: 'Theses' },
  people: { one: 'Person', many: 'People' },
  roadmap: { one: 'Objective', many: 'Objectives' },
  lab: { one: 'Insight', many: 'Insights' },
  memory: { one: 'Memory', many: 'Memory' },
  link: { one: 'Linked repo', many: 'Linked repos' },
  links: { one: 'Linked repo', many: 'Linked repos' },
};

function capitalize(word: string): string {
  return word ? word[0].toUpperCase() + word.slice(1) : word;
}

/** `tasks` → `Task`, `connections` → `Connection`. Words whose `s` is part of the stem
 *  (`status`, `theses`) are the exceptions, and they live in {@link NOUNS}. */
export function domainNoun(domain: string, plural = false): string {
  const override = NOUNS[domain];
  if (override) return plural ? override.many : override.one;
  const word = domain.replace(/-/g, ' ');
  if (plural) return capitalize(word);
  const singular = /(ss|us|is)$/.test(word) ? word : word.replace(/s$/, '');
  return capitalize(singular);
}

export interface DreamActionView {
  /** The row's name: `Task created`, `Memory recall`, `Snapshot`. */
  label: string;
  tone: DreamTone;
  /** The thing acted on — a task's title, a recall query, a knowledge slug. */
  subject?: string;
  /** Trailing positionals, joined: `tasks status <slug> in_progress` → `in_progress`. */
  detail?: string;
  /** The endpoint's own description, for the tooltip. */
  desc?: string;
}

/**
 * The row's words, derived — noun from the domain, verb from the action, subject from the
 * first positional argument, everything after it as the detail.
 *
 * Generic on purpose. `dreamcontext theses promote my-thesis` has never been seen by this
 * file and still renders as `Thesis promote · my-thesis`.
 */
export function describeDreamAction(action: DreamAction): DreamActionView {
  const verbKey = action.action ?? '';
  const arity = ARITY_SENSITIVE.has(verbKey) ? action.args.length : 0;
  const known = VERBS[verbKey];
  const tone: DreamTone = ARITY_SENSITIVE.has(verbKey)
    ? (arity >= 2 ? 'write' : 'read')
    : known?.tone ?? (action.action ? 'write' : 'read');
  const noun = domainNoun(action.domain, known?.plural ?? false);
  const verbText = known?.text ?? verbKey;
  return {
    label: verbText ? `${noun} ${verbText}` : noun,
    tone,
    subject: action.args[0],
    // Joined on a separator, not a space: `tasks insert <task> <section> <content>` would
    // otherwise run the section name straight into the content as one unreadable sentence.
    detail: action.args.length > 1 ? action.args.slice(1).join(' · ') : undefined,
    desc: action.desc,
  };
}

// ─── Saying what came back ─────────────────────────────────────────────────────────

export interface DreamOutcome {
  tone: 'ok' | 'error' | 'warn';
  /** The CLI's own sentence, glyph stripped: `Task created: fix-the-parser.md`. */
  text: string;
  /** A project-relative path the outcome PROVES exists, when one can be recovered. */
  path?: string;
}

const OUTCOME_GLYPHS: Record<string, DreamOutcome['tone']> = { '✓': 'ok', '✗': 'error', '⚠': 'warn' };

/**
 * What the CLI said about its own result — read off the output, not guessed from the exit.
 *
 * This is the second half of the auto-detection promise, and the reason it works for all ~300
 * endpoints without a line of per-command code: every one of them reports through
 * `src/lib/format.ts`'s `success()`/`error()`/`warn()`, which prefix `✓`/`✗`/`⚠`. A new command
 * that uses those helpers gets its outcome rendered on the row for free.
 *
 * The LAST such line wins: a command that warns and then succeeds ended in success, and the
 * row should say so.
 */
export function dreamOutcome(result: string | undefined, domain?: string): DreamOutcome | null {
  if (!result) return null;
  let found: DreamOutcome | null = null;
  for (const line of result.split('\n')) {
    const trimmed = line.trim();
    const tone = OUTCOME_GLYPHS[trimmed[0]];
    if (!tone) continue;
    found = { tone, text: trimmed.slice(1).trim() };
  }
  if (!found) return null;

  // A path is only ever taken from text the CLI actually printed — never assembled from an
  // argument the agent passed. A chip that opens nothing is worse than a chip that only names
  // (the same rule `SubjectChip` exists for), and the slug the CLI reports is the slugified
  // one, which the raw argument is not.
  const explicit = found.text.match(/_dream_context\/[\w./-]+/);
  if (explicit) return { ...found, path: explicit[0] };
  if (found.tone === 'ok' && domain === 'tasks') {
    // Tasks are flat in `state/` — `classifyReference`'s own task pattern asserts exactly that
    // shape — so a reported `<slug>.md` locates the file with no guessing.
    const slug = found.text.match(/\b([a-z0-9][a-z0-9-]*)\.md\b/);
    if (slug) return { ...found, path: `_dream_context/state/${slug[1]}.md` };
  }
  return found;
}
