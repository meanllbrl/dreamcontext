import {
  MAX_OWED_CLOSED, MAX_OWED_MSG_GIST, MAX_OWED_OPEN, MAX_OWED_RESULT_GIST, MAX_SENT, MSG_REF_RE, OWED_NUDGES, OWED_PARK_MS, SENT_RE,
  msgRef, partRefs,
  type SuperOwed, type SuperState,
} from './types.js';

/**
 * What the Super owes the owner (task super-hicbir-konuyu-kacirmaz): the ledger's pure rules.
 *
 * A debt is OPENED by the server from facts only (his message written into the Super; an item he
 * waits on, or a child's outward action, reaching the Super) and CLOSED only by evidence: a
 * line-start `<!-- re:<ref> -->` section in a Super text, one section per debt, oldest first; his
 * drop on the agenda; his take-back. The Super can never close one by command. A natural turn end
 * with open debts sends one `[super owed]` turn (inbox.ts); after OWED_NUDGES of those, or a Stop
 * or a limit left it open for OWED_PARK_MS, it shows on his agenda ("Cevaplanmadı").
 *
 * Nothing here reads the registry or the disk: every function works on a record draft.
 */

// ─── Outward actions (a child's frames) ─────────────────────────────────────────

/** Shell segments that send something out of this machine, each with its fixed label. */
const SHELL_OUTWARD: ReadonlyArray<[RegExp, string]> = [
  [/^git\b(?:\s+-[Cc]\s+\S+)*\s+push\b/, 'git push'],
  [/^(?:npm|pnpm|yarn)\b(?:\s+--?\S+)*\s+publish\b/, 'npm publish'],
  [/^gh\s+pr\s+create\b/, 'PR create'],
  [/^gh\s+pr\s+merge\b/, 'PR merge'],
  [/^gh\s+release\s+create\b/, 'release create'],
  [/^firebase\b.*\sdeploy\b/, 'firebase deploy'],
  [/^vercel\b.*\s--prod\b/, 'vercel deploy --prod'],
];
/** An MCP tool's own name: these verbs send, these only look. */
const MCP_SENDS = new Set(['send', 'post', 'reply', 'publish', 'message', 'email', 'sms', 'whatsapp', 'slack']);
const MCP_LOOKS = new Set(['list', 'get', 'read', 'search', 'fetch', 'draft']);
/** An MCP tool name's words (`send_targeted_email` → send, targeted, email; `postMessage` → post, message). */
const toolWords = (tool: string): string[] => tool.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** One shell segment with its wrappers taken off (`VAR=x`, `sudo`, `npx`, `command`, `time`). */
function bareSegment(seg: string): string {
  let s = seg.trim().replace(/^\(+/, '').trim();
  for (let i = 0; i < 8; i++) {
    const next = s.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+|sudo\s+|npx\s+(?:-y\s+|--yes\s+)?|command\s+|time\s+|exec\s+)/, '');
    if (next === s) break;
    s = next;
  }
  return s;
}

/** The one argument of `<any path>/(ba|z)sh -c|-lc <word>`, decoded (quotes joined, `\"` and the
 *  like unescaped), or null when the command is not that shape (or the argument is two words). */
function shellWordArg(cmd: string): string | null {
  const m = cmd.trim().match(/^(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+([\s\S]+)$/);
  if (!m) return null;
  let out = '';
  for (const seg of m[1].match(/'[^']*'|"(?:[^"\\]|\\.)*"|[^\s'"]+|\s+/g) ?? []) {
    if (/^\s+$/.test(seg)) return null;
    out += seg[0] === "'" ? seg.slice(1, -1) : seg[0] === '"' ? seg.slice(1, -1).replace(/\\(["\\$`])/g, '$1') : seg;
  }
  return out;
}

/** A shell command with what is only DATA taken out: heredoc bodies and quoted strings (a brief
 *  written to a file, an `echo "git push"`, a prompt that mentions a push are no push). */
function commandText(cmd: string): string {
  // Codex runs every command as `<shell> -lc <one shell word>` (t3-bridge headless-envelope.ts):
  // judge the command inside. That word may be built of joined pieces, `"…"'$X'"…"` (Codex's
  // form for a command holding both `'` and `$`), so it is decoded piece by piece.
  const inner = shellWordArg(cmd);
  if (inner !== null) cmd = inner;
  return cmd
    .replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, '')
    .replace(/'[^']*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

/**
 * Is this tool call an action that goes OUT (owner decision D3, 2026-11-06): a push, a publish, a
 * PR opened or merged, a release, a deploy, an MCP tool that sends? Its fixed label, or null for
 * anything else (unknown = null). Bash's command is read segment by segment (`&&`, `;`, `||`,
 * `|`, newlines), so `echo "git push"` is not a push.
 */
export function outwardAction(name: unknown, input: unknown): string | null {
  if (typeof name !== 'string' || !name) return null;
  const inp = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  if (name === 'Bash' || name === 'shell' || name === 'exec_command') {
    const cmd = typeof inp.command === 'string' ? inp.command : Array.isArray(inp.command) ? inp.command.filter((x) => typeof x === 'string').join(' ') : '';
    if (!cmd) return null;
    for (const raw of commandText(cmd).split(/&&|\|\||[;|\n]/)) {
      const seg = bareSegment(raw);
      for (const [re, label] of SHELL_OUTWARD) if (re.test(seg)) return label;
    }
    return null;
  }
  if (name.startsWith('mcp__')) {
    const words = toolWords((name.split('__').pop() ?? '').split(/[./]/).pop() ?? '');
    if (!words.some((w) => MCP_SENDS.has(w)) || words.some((w) => MCP_LOOKS.has(w))) return null;
    const label = `mcp ${name.slice(5).replace(/__/g, '/').replace(/[^A-Za-z0-9_./-]/g, '')}`.slice(0, 80);
    return SENT_RE.test(label) ? label : 'mcp send';
  }
  return null;
}

// ─── Marks (a Super text) ───────────────────────────────────────────────────────

/** A line that opens with a reply mark; its body is the refs. */
const MARK_AT_LINE = /^[ \t]*<!--\s*re:([^\n>]*?)-->/;
const FENCE = /^[ \t]*(```|~~~)/;

/**
 * Every well-formed ref a Super text marks at a LINE START, outside code fences, in order and
 * with repeats (two sections under one ref count twice). The server twin of the window's
 * REPLY_MARK_LINE_RE reading; a mark inside a fence is quoted text, never a section.
 */
export function replyMarkRefs(text: unknown): string[] {
  if (typeof text !== 'string' || !text.includes('re:')) return [];
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of text.split('\n')) {
    const f = FENCE.exec(line);
    if (f) { fence = fence === null ? f[1] : fence === f[1] ? null : fence; continue; }
    if (fence !== null) continue;
    const m = MARK_AT_LINE.exec(line);
    if (!m) continue;
    for (const r of m[1].split(/[\s,]+/)) {
      const ref = r.trim().toLowerCase();
      if (MSG_REF_RE.test(ref)) out.push(ref);
    }
  }
  return out;
}

// ─── The ledger ─────────────────────────────────────────────────────────────────

/** A result's synthetic ref when no owner message is its origin: stable for its queue item. */
export function owedRef(itemId: string): string {
  return msgRef(`item:${itemId}`);
}

export const isOpen = (d: SuperOwed): boolean => d.closed === undefined;

/** The open debts, oldest first. */
export function openDebts(s: Pick<SuperState, 'owed'>): SuperOwed[] {
  return (s.owed ?? []).filter(isOpen).sort((a, b) => a.seq - b.seq);
}

/** His own message under `ref` (a `msg` debt, open or among the kept closed ones, by its ref or a
 *  part ref): its gist, his words server-cut. Null when the record holds no message of his by
 *  that ref (a ref a child, a page or a guess named). */
export function ownerMessageGist(s: Pick<SuperState, 'owed'>, ref: string): string | null {
  const d = (s.owed ?? []).find((x) => x.kind === 'msg' && (x.ref === ref || x.parts?.includes(ref)));
  return d ? d.gist : null;
}

/** Cut a gist to `max` characters, one line, no control characters. */
export function cutGist(raw: string, max: number): string {
  const flat = (raw ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** The record's start of debts: stamped once, by a write (never a read). Mutates `s`. */
export function stampOwedSince(s: SuperState, now: number): void {
  if (s.owedSince === undefined) s.owedSince = now;
}

/** Open one debt. Mutates `s`; returns it. Over MAX_OWED_OPEN the oldest open one is closed
 *  quietly by the owner's hand (a hidden ceiling, never reached by real use). */
export function openDebt(s: SuperState, d: Omit<SuperOwed, 'id' | 'seq' | 'nudges'>, now = Date.now()): SuperOwed {
  stampOwedSince(s, now);
  const seq = (s.owedSeq ?? 0) + 1;
  s.owedSeq = seq;
  const debt: SuperOwed = { ...d, id: `o${seq}`, seq, nudges: 0 };
  s.owed = [...(s.owed ?? []), debt];
  const open = openDebts(s);
  for (const old of open.slice(0, Math.max(0, open.length - MAX_OWED_OPEN))) old.closed = { at: now, by: 'owner' };
  trimClosed(s);
  return debt;
}

/** Keep every open debt and the newest MAX_OWED_CLOSED closed ones. Mutates `s`. */
export function trimClosed(s: SuperState): void {
  const all = s.owed ?? [];
  const closed = all.filter((d) => !isOpen(d)).sort((a, b) => (b.closed?.at ?? 0) - (a.closed?.at ?? 0) || b.seq - a.seq);
  const keep = new Set(closed.slice(0, MAX_OWED_CLOSED).map((d) => d.id));
  const next = all.filter((d) => isOpen(d) || keep.has(d.id));
  if (next.length !== all.length) s.owed = next;
  if (!s.owed?.length) delete s.owed;
}

/** His message to the Super (not a slash command): one `msg` debt. Mutates `s`. */
export function openMessageDebt(s: SuperState, text: string, now = Date.now(), ref?: string): SuperOwed {
  // A Telegram message carries the ref the hub drew (ownerMsgBlock writes that one, and the Super
  // answers under it): the debt MUST use it too, or the same message is owed a second time
  // under its words' hash.
  const own = ref && MSG_REF_RE.test(ref) ? ref : undefined;
  const parts = partRefs(text, own);
  return openDebt(s, { kind: 'msg', ref: own ?? msgRef(text), ...(parts.length ? { parts } : {}), at: now, gist: cutGist(text, MAX_OWED_MSG_GIST) }, now);
}

/** A result (or a send) that reached the Super: one `result` debt. Mutates `s`. */
export function openResultDebt(s: SuperState, r: { ref: string; item?: string; child?: string; team?: string; gist: string; sent?: readonly string[] }, now = Date.now()): SuperOwed {
  const sent = (r.sent ?? []).filter((x) => SENT_RE.test(x)).slice(0, MAX_SENT);
  return openDebt(s, {
    kind: 'result', ref: r.ref, at: now, ...(r.item ? { item: r.item } : {}), gist: cutGist(r.gist, MAX_OWED_RESULT_GIST),
    ...(r.child ? { child: r.child } : {}), ...(r.team ? { team: r.team } : {}), ...(sent.length ? { sent } : {}),
  }, now);
}

/** Does a section under `ref` answer this debt? */
const answers = (d: SuperOwed, ref: string): boolean => d.ref === ref || (d.parts?.includes(ref) ?? false);

/**
 * A Super text's sections close debts: per ref, as many open debts as it has sections, those
 * with `seq <= ceiling`, oldest first. Returns how many closed. Mutates `s`.
 */
export function closeByMarks(s: SuperState, refs: readonly string[], ceiling: number, now = Date.now()): number {
  if (!refs.length || !s.owed?.length) return 0;
  let closed = 0;
  for (const ref of refs) {
    const d = openDebts(s).find((x) => x.seq <= ceiling && answers(x, ref));
    if (!d) continue;
    d.closed = { at: now, by: 'mark' };
    delete d.parked; delete d.parkedAt;
    closed += 1;
  }
  if (closed) trimClosed(s);
  return closed;
}

/** His drop ("Gerek yok") of one open debt. Mutates `s`; false when it is not open. */
export function dropDebt(s: SuperState, id: string, now = Date.now()): boolean {
  const d = (s.owed ?? []).find((x) => x.id === id && isOpen(x));
  if (!d) return false;
  d.closed = { at: now, by: 'owner' };
  trimClosed(s);
  return true;
}

/** His take-back: he is in the chat himself, every open debt closes. Mutates `s`. */
export function closeAllForTakeback(s: SuperState, now = Date.now()): number {
  let n = 0;
  for (const d of s.owed ?? []) if (isOpen(d)) { d.closed = { at: now, by: 'takeback' }; n += 1; }
  if (n) trimClosed(s);
  return n;
}

/** Shown on his agenda: nudged OWED_NUDGES times, or parked by his Stop or a limit for OWED_PARK_MS. */
export function owedVisible(d: Pick<SuperOwed, 'nudges' | 'parked' | 'parkedAt' | 'closed'>, now = Date.now()): boolean {
  if (d.closed !== undefined) return false;
  if (d.nudges >= OWED_NUDGES) return true;
  return !!d.parked && d.parkedAt !== undefined && now - d.parkedAt >= OWED_PARK_MS;
}

/** The earliest moment a parked debt becomes visible, after `now` (one timer on an open page). */
export function nextOwedReveal(owed: readonly Pick<SuperOwed, 'nudges' | 'parked' | 'parkedAt' | 'closed'>[] | undefined, now = Date.now()): number | null {
  let at: number | null = null;
  for (const d of owed ?? []) {
    if (d.closed !== undefined || d.nudges >= OWED_NUDGES || !d.parked || d.parkedAt === undefined) continue;
    const t = d.parkedAt + OWED_PARK_MS;
    if (t > now && (at === null || t < at)) at = t;
  }
  return at;
}

/** A turn end the decision reads (inbox.ts): its ceiling and why it may not decide. */
export interface OwedEnd { ceiling: number; stopped: boolean; exited: boolean; limited: boolean }

/**
 * Decide at the turn ends of one pump pass (a draft). Each end is judged: a Stop or a limit
 * parks the open debts at or under its ceiling; an exit decides nothing. The NEWEST natural end's
 * ceiling decides: its open debts with `nudges < OWED_NUDGES`, not waiting to be told again
 * (`itemPending`), become one `owed` queue item, unless one is already pending or delivered.
 * A natural end clears `parked`. Returns the debt ids to queue (empty: none). Mutates `s`.
 */
export function decideOwed(s: SuperState, ends: readonly OwedEnd[], itemPending: (itemId: string) => boolean, now = Date.now()): string[] {
  if (!ends.length || !s.owed?.length) return [];
  for (const e of ends) {
    if (e.exited || !(e.stopped || e.limited)) continue;
    for (const d of openDebts(s)) {
      if (d.seq <= e.ceiling && !d.parked) { d.parked = e.stopped ? 'stop' : 'limit'; d.parkedAt = now; }
    }
  }
  const natural = ends.filter((e) => !e.exited && !e.stopped && !e.limited);
  if (!natural.length) return [];
  const ceiling = natural[natural.length - 1].ceiling;
  for (const d of openDebts(s)) { delete d.parked; delete d.parkedAt; }
  if (s.queue.some((q) => q.kind === 'owed' && (q.state === 'pending' || q.state === 'delivered'))) return [];
  return openDebts(s).filter((d) => d.seq <= ceiling && d.nudges < OWED_NUDGES && !(d.item && itemPending(d.item))).map((d) => d.id);
}

/** The debts an `owed` item still names that are open: what its turn says (re-decided at delivery). */
export function owedStillOpen(s: Pick<SuperState, 'owed'>, ids: readonly string[] | undefined): SuperOwed[] {
  const want = new Set(ids ?? []);
  return openDebts(s).filter((d) => want.has(d.id));
}

/**
 * Open debts the owner's next message carries (`<super-owed>`): not yet his to see, not this
 * message, and never a result whose item waits to be delivered again (it is told then, once).
 * A debt he wrote ABOUT (`[About agenda line owed=<id> …]`, his "write about this" on a
 * Cevaplanmadı row) is always carried, whatever its nudges: its ref is how the Super closes it.
 */
export function owedForMessage(s: Pick<SuperState, 'owed' | 'queue'>, exceptRef: string | null, about: readonly string[] = []): SuperOwed[] {
  const pending = (item?: string) => !!item && s.queue.some((q) => q.id === item && q.state === 'pending');
  return openDebts(s).filter((d) => d.ref !== exceptRef && (about.includes(d.id) || (d.nudges < OWED_NUDGES && !(d.kind === 'result' && pending(d.item)))));
}

/** hh:mm of a debt, local time (the Super reads it in his day). */
export function owedClock(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Put a child's sends back (a failed delivery's inverse): merged with any recorded since. */
export function mergeSent(have: readonly string[] | undefined, back: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const x of [...(back ?? []), ...(have ?? [])]) if (SENT_RE.test(x) && !out.includes(x)) out.push(x);
  return out.slice(-MAX_SENT);
}

