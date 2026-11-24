/**
 * The owner's own written word as consent (owner 2026-11-15: "Neden izini buradan veremedim").
 *
 * A permission that is his (a child's or a member's prompt, a refused call) passes on his tap, and
 * the Super can never say "he said yes" for him. His own MESSAGE is as real as a tap when the
 * SERVER can prove he wrote it: this module keeps, in memory only, what the server classified as
 * his words in a Super chat, by the ref his `<owner-msg>` carries. Only frames the server built
 * itself prove him: his linked Telegram (the hub's honoured ref) and his phone (its device
 * session). A Mac composer frame proves nothing a local process could not send (any agent can open
 * a loopback socket and set the composer's mark; `owner-key.ts`: every header is a claim), so a
 * line typed on the Mac is kept only to say so: there, the card is in front of him.
 *
 * `super queue allow <item> --owner-ref <ref>` is checked against it: the ref is a proven message
 * of his in THIS Super's chat, written after the card was born, used once, its WHOLE text a plain
 * yes (or no); the card was among his waiting permissions when he wrote, and the only one, or the
 * one his message names. A call that goes out (push, publish, PR, merge, deploy, upload, a cloud
 * CLI, any MCP or web tool) never passes this way: it still needs his tap.
 *
 * Nothing here reads the disk itself: a restart forgets the words, and he taps the card.
 */
import { outwardAction } from './owed.js';
import { MEMBER_SUPER_PREFIX, MSG_REF_RE, type OwnerAnswer, type OwnerAnswerRequest, type OwnerAnswerResult, type SuperId, type SuperQueueItem } from './types.js';

export type OwnerWordsVia = 'composer' | 'phone' | 'telegram';

/** One of his permissions waiting when he wrote (its member, to tell two apart by name). */
export interface WaitingCard { id: string; member?: string }

export interface OwnerWords {
  ref: string;
  /** The part refs of a message with several About/Reply heads (each is his message too). */
  parts: string[];
  at: number;
  /** His words as the server classified them (no chip block, quote or path). */
  text: string;
  via: OwnerWordsVia;
  /** His permissions waiting when he wrote, read from the record right then (null: not read). */
  waiting: Promise<WaitingCard[] | null>;
  used?: true;
}

/** Words older than this are no consent to anything still waiting (a day). */
export const OWNER_WORDS_TTL_MS = 24 * 60 * 60 * 1000;
/** A memory bound per Super session, never reached by a person typing within a day. */
const MAX_WORDS_PER_SESSION = 500;
/** The longest words kept (a consent is a line, not a document). */
const MAX_WORDS_TEXT = 2000;

const words = new Map<string, OwnerWords[]>();

/** Record one message the server classified as his words in a Super chat (agent-chat.ts), with the
 *  read of his waiting permissions started at that moment. */
export function noteOwnerWords(
  session: string,
  w: { ref: string; parts?: readonly string[]; text: string; via: OwnerWordsVia; at?: number; waiting?: Promise<WaitingCard[] | null> },
): void {
  if (!session || !MSG_REF_RE.test(w.ref) || typeof w.text !== 'string') return;
  const at = w.at ?? Date.now();
  const list = (words.get(session) ?? []).filter((x) => at - x.at < OWNER_WORDS_TTL_MS);
  list.push({
    ref: w.ref, parts: (w.parts ?? []).filter((p) => MSG_REF_RE.test(p)), at, text: w.text.slice(0, MAX_WORDS_TEXT), via: w.via,
    waiting: (w.waiting ?? Promise.resolve(null)).catch(() => null),
  });
  words.set(session, list.slice(-MAX_WORDS_PER_SESSION));
}

/** The newest unused message of his in this Super session with this ref (or part ref), or null. */
export function findOwnerWords(session: string, ref: string, now = Date.now()): OwnerWords | null {
  if (!MSG_REF_RE.test(ref)) return null;
  const list = words.get(session) ?? [];
  for (let i = list.length - 1; i >= 0; i--) {
    const w = list[i];
    if (now - w.at >= OWNER_WORDS_TTL_MS) break;
    if ((w.ref === ref || w.parts.includes(ref)) && !w.used) return w;
  }
  return null;
}

/** Is there a USED message of his with this ref (so a second use is told so, not "unknown")? */
export function ownerWordsUsed(session: string, ref: string): boolean {
  return (words.get(session) ?? []).some((w) => (w.ref === ref || w.parts.includes(ref)) && w.used === true);
}

/** Tests only. */
export function _resetOwnerWords(): void { words.clear(); }

// ─── What his words say ───────────────────────────────────────────────────────

/** Turkish casing first (İ → i, I → ı), then every Turkish letter read as its plain one ("IZIN"
 *  typed without the dot is izin, "gecir" typed without the cedilla is geçir). */
const TR_PLAIN: Record<string, string> = { ı: 'i', ç: 'c', ş: 's', ğ: 'g', ü: 'u', ö: 'o' };
const fold = (s: string): string => s.toLocaleLowerCase('tr').replace(/[ıçşğüö]/g, (c) => TR_PLAIN[c]);

/** Words that say yes, said alone or with the fillers below. */
const YES = new Set([
  'ver', 'veriyorum', 'verdim', 'verin', 'versin', 'verebilirsin', 'evet', 'tamam', 'tamamdir', 'onay', 'onayla', 'onayliyorum',
  'onayladim', 'onaylandi', 'gecir', 'gecsin', 'olur', 'olsun', 'tabii', 'tabi', 'allow', 'allowed', 'yes', 'ok', 'okay',
  'approve', 'approved', 'go', 'ahead', 'sure',
]);
/** Words that say no. */
const NO = new Set([
  'hayir', 'verme', 'vermiyorum', 'vermeyin', 'vermem', 'reddet', 'reddediyorum', 'red', 'olmaz', 'istemiyorum', 'onaylama',
  'onaylamiyorum', 'gecirme', 'iptal', 'durdur', 'no', 'nope', 'deny', 'denied', 'reject', 'dont',
]);
/** Words that only carry the yes or no ("Conor'a izin veriyorum", "evet, buna izin ver"). */
const FILLER = new Set([
  'izin', 'izni', 'iznini', 'buna', 'bunu', 'ona', 'suna', 'sunu', 'ben', 'de', 'da', 'lutfen', 'it', 'this', 'please', 'i', 'that',
  // D14 (iyilesme-360): how he says it ("onay verdim saysın", "hadi evet"); "hadi" alone is no yes.
  'say', 'saysin', 'sayin', 'sayilsin', 'artik', 'hadi',
]);
/** A Turkish case ending after a name's apostrophe ("Conor'a", "Atlas'ın"). */
const SUFFIX = new Set(['a', 'e', 'ya', 'ye', 'na', 'ne', 'in', 'un', 'nin', 'nun', 'i', 'u', 'yi', 'yu', 'ni', 'nu']);

/**
 * What his message says about a waiting permission: allow, deny, or nothing clear (null). The
 * WHOLE message must be a plain yes or no: every word one of yes, no, a filler, or a name in
 * `names` (the waiting cards' members); a word of anything else ("izin vermeden önce sor", "ok,
 * sonra bakarım", "do not allow it") is no consent. Yes and no together: null.
 */
export function consentOf(text: string, names: readonly string[] = []): 'allow' | 'deny' | null {
  let s = fold(text ?? '');
  for (const n of names) {
    const name = fold(n).trim();
    if (name.length < 2) continue;
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    s = s.replace(new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?:['’]\\p{L}+)?(?![\\p{L}\\p{N}])`, 'gu'), ' ');
  }
  const tokens = s.replace(/['’]/g, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!tokens.length || tokens.length > 12) return null;
  let yes = false;
  let no = false;
  for (const t of tokens) {
    if (YES.has(t)) yes = true;
    else if (NO.has(t)) no = true;
    else if (!FILLER.has(t) && !SUFFIX.has(t)) return null;
  }
  if (yes === no) return null;
  return yes ? 'allow' : 'deny';
}

// ─── Which calls his words may pass ──────────────────────────────────────────

/** Tools whose permission is about this machine's files only: the only ones besides Bash. */
const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'LS']);
/** A word that sends something out, anywhere in a command (`git --no-pager push`, `fly deploy`). */
const OUT_WORD_RE = /(?<![\w-])(?:push|publish|deploy|release|upload|submit|merge|rebase|unpublish|deprecate|login|adduser)(?![\w-])|--prod\b|--force(?:-with-lease)?\b|reset\s+--hard/;
/** A program whose whole job is reaching another machine or a cloud account. */
const OUT_TOOL_RE = /(?<![\w./-])(?:gh|scp|rsync|ssh|sftp|ftp|nc|ncat|telnet|aws|gcloud|gsutil|az|kubectl|helm|terraform|pulumi|heroku|fly|flyctl|wrangler|netlify|vercel|firebase|eas|twine|sendmail|mail)(?![\w-])/;
/** curl or wget that sends data (a POST, a form, a file). */
const SEND_DATA_RE = /(?<![\w-])(?:curl|wget)(?![\w-])[^\n]*?(?:\s-X\s*(?:POST|PUT|PATCH|DELETE)\b|\s--request\s+(?:POST|PUT|PATCH|DELETE)\b|\s-d\b|\s--data|\s-F\b|\s--form|\s-T\b|\s--upload-file|\s--post-)/i;

/** A program that runs code the card does not show (a script file, a package script, a target,
 *  an inline program, a scheduler): the Super writes the brief AND the summary he reads, so on his
 *  written word a push wrapped in `bash go.sh`, `npm run ship` or `python -c` must not pass. */
const INDIRECT = new Set([
  'bash', 'sh', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'source', '.', 'eval', 'exec', 'xargs', 'python', 'python3', 'node', 'ruby',
  'perl', 'php', 'lua', 'java', 'expect', 'awk', 'gawk', 'deno', 'bun', 'tsx', 'ts-node', 'vite-node', 'npx', 'pnpx', 'bunx', 'npm', 'pnpm',
  'yarn', 'make', 'just', 'task', 'osascript', 'open', 'arch', 'crontab', 'at', 'batch', 'launchctl', 'swift', 'go', 'cargo', 'gradle', 'mvn',
  'rake', 'invoke', 'tox', 'nox', 'pipx', 'uv', 'poetry', 'pip', 'pip3', 'brew', 'docker', 'podman', 'script', 'watch', 'parallel',
]);
/** The git subcommands his written word may pass: they read, and neither switch the tree (no
 *  post-checkout hook) nor commit (no commit hooks). */
const LOCAL_GIT = new Set(['status', 'diff', 'log', 'show', 'add', 'restore', 'mv', 'rm', 'branch', 'stash']);
/** Wrappers in front of the real program (with their flags). */
const WRAPPER = new Set(['sudo', 'env', 'command', 'builtin', 'time', 'nice', 'nohup', 'caffeinate', 'timeout', 'stdbuf', 'ionice']);

/** Why one shell segment runs hidden code, or null. */
function indirection(segment: string): string | null {
  const words = segment.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  // Assignments and bare wrappers, then the program itself. A wrapper with options (`sudo -u x`,
  // `env -i`, `nice -n 5`) hides where its program starts: refused.
  while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || WRAPPER.has(words[i].replace(/["'\\]/g, '')))) {
    const wrapper = !/=/.test(words[i]);
    i++;
    if (wrapper && i < words.length && (/^-/.test(words[i]) || /^\d/.test(words[i]))) return 'it runs a program through a wrapper with options';
  }
  const raw = words[i] ?? '';
  if (!raw) return null;
  // A program named through a variable, quotes or a backslash is not the word it seems.
  if (/[$"'\\{}*?[\]~]/.test(raw)) return 'its program is named through a variable, quotes or an escape';
  const prog = raw.split('/').pop() ?? '';
  if (raw.includes('/')) return `it runs a file (${prog}) whose contents the card does not show`;
  if (INDIRECT.has(prog)) return `it runs code the card does not show (${prog})`;
  const rest = words.slice(i + 1);
  if (prog === 'find' && rest.some((w) => /^-(?:exec|execdir|ok|okdir|delete)$/.test(w))) return 'find runs a command on what it finds';
  if (prog === 'git') {
    if (rest.some((w) => w === '-c' || w.startsWith('--config') || w.startsWith('--exec-path') || w.startsWith('--git-dir') || w.startsWith('--work-tree'))) return 'it changes git\'s configuration for the call';
    const sub = rest.find((w) => !w.startsWith('-') && !/^[^-].*=/.test(w));
    if (!sub || !LOCAL_GIT.has(sub)) return `git ${sub ?? ''} is not a local, hook-free git step`.replace('  ', ' ');
  }
  return null;
}

/** A file whose writing makes later commands run code (git hooks and config, schedulers, shell
 *  start-up, package scripts): on his written word, never. */
const RUNS_LATER_RE = /(?:^|\/)(?:\.git|\.husky|LaunchAgents|LaunchDaemons|cron[^/]*)(?:\/|$)|(?:^|\/)(?:\.gitconfig|\.zshrc|\.zprofile|\.zshenv|\.bashrc|\.bash_profile|\.profile|package\.json|Makefile|justfile|\.npmrc)$/;

/** Why a call never passes on his written words (only his tap), or null. A cut call never does:
 *  what he did not see can hide anything. */
export function writtenConsentRefusal(call: { tool: string; input: string; whole: boolean }): string | null {
  if (!call.whole) return 'its command was cut, so it is not shown whole';
  const shell = call.tool === 'Bash' || call.tool === 'shell' || call.tool === 'exec_command';
  if (!shell) {
    if (!FILE_TOOLS.has(call.tool)) return `${call.tool} is a tool that can reach outside this machine`;
    return RUNS_LATER_RE.test(call.input.trim()) ? 'it writes a file that makes later commands run code (git, a scheduler, a shell or package start-up)' : null;
  }
  const label = outwardAction(call.tool, { command: call.input });
  if (label) return `it is an outward step (${label})`;
  if (OUT_WORD_RE.test(call.input)) return 'it pushes, publishes, deploys, uploads, merges or forces something';
  if (OUT_TOOL_RE.test(call.input)) return 'it runs a tool that reaches another machine or a cloud account';
  if (SEND_DATA_RE.test(call.input)) return 'it sends data out (curl or wget with a body)';
  // A substitution or a here-document runs or feeds code no segment shows.
  if (/\$\(|`|<<|<\(|>\(/.test(call.input)) return 'it runs a command inside the command ($(…), backticks, a here-document)';
  for (const seg of call.input.split(/&&|\|\||[;|&\n()]/)) {
    const why = indirection(seg);
    if (why) return why;
  }
  return null;
}

/** Is this item a permission only the owner decides (a prompt not handed to the Super, a refused
 *  call, or a member's mirror of either)? */
export function ownerPermissionItem(q: SuperQueueItem): boolean {
  // Allowed already (its call waits to run): nothing of his waits on it.
  if (q.state === 'done' || q.allowed !== undefined) return false;
  if (q.kind === 'permission') return !q.toSuper;
  if (q.kind === 'owner') return q.wait?.kind === 'refusal';
  if (q.kind === 'member') return q.of === 'permission' || (q.of === 'owner' && q.wait?.kind === 'refusal');
  return false;
}

/** His waiting permissions in a queue, as `noteOwnerWords` keeps them. */
export function waitingCards(queue: readonly SuperQueueItem[]): WaitingCard[] {
  return queue.filter(ownerPermissionItem).map((q) => ({ id: q.id, ...(q.kind === 'member' && q.member ? { member: q.member } : {}) }));
}

// ─── The check, in one place ─────────────────────────────────────────────────

export type WrittenConsentError =
  | 'unknown_item' | 'not_owner_permission' | 'not_owner_message' | 'mac_words' | 'ref_used' | 'before_card'
  | 'not_consent' | 'several_pending' | 'outward' | 'stale_request';

export type WrittenConsentResult =
  | { ok: true; answer: OwnerAnswerResult; behavior: 'allow' | 'deny' }
  | { ok: false; error: WrittenConsentError; message: string; pending?: string[] };

export interface WrittenConsentDeps {
  /** The member item behind an open mirror (answer.ts `memberMirrorTarget`). */
  mirror: (root: string, mirrorId: string) => Promise<{ item: SuperQueueItem } | null>;
  /** The call an item would let run, read where it is decided (answer.ts `ownerItemCall`). */
  call: (item: SuperQueueItem) => { tool: string; input: string; whole: boolean } | null;
  /** The owner's answer, as every surface gives it (answer.ts `answerOwnerItem`). */
  answer: (root: string, req: OwnerAnswerRequest) => Promise<OwnerAnswerResult>;
  /** A member's name as he writes it ("Conor"), for telling two waiting cards apart. */
  memberName: (slug: string) => string | null;
}

const TAP = 'he passes it with one tap on its card (Telegram or the Mac)';

/** A name as a whole word of his message. */
function mentions(text: string, name: string): boolean {
  const n = fold(name).trim();
  if (n.length < 2) return false;
  const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?:['’]\\p{L}+)?(?![\\p{L}\\p{N}])`, 'u').test(fold(text));
}

/**
 * Pass (or deny) one of the owner's permissions on a message he wrote (`super queue allow`). The
 * Super names the item and his message's ref; the server decides, from what IT recorded, never
 * from the Super's word:
 *  - the ref is his proven words (Telegram, his phone) in THIS Super session, unused, within a day;
 *  - it was written after the card was born, and the card was among his waiting permissions then;
 *  - its whole text is a plain yes (or, for `deny`, a plain no);
 *  - the card was the only permission of his waiting when he wrote, or his message names its
 *    member (several waiting and none named: refused, the Super asks him which);
 *  - the call is shown whole and does not go out (push, publish, deploy, upload, cloud, MCP, web).
 * The words are spent before any wait, and given back only when nothing was answered.
 */
export async function allowByOwnerWords(
  root: string,
  record: { superId: SuperId; session: string; queue: readonly SuperQueueItem[] },
  args: { item: string; ref: string; deny: boolean; now?: number },
  deps: WrittenConsentDeps,
): Promise<WrittenConsentResult> {
  const fail = (error: WrittenConsentError, message: string, pending?: string[]): WrittenConsentResult => ({ ok: false, error, message, ...(pending ? { pending } : {}) });
  const now = args.now ?? Date.now();
  const item = record.queue.find((q) => q.id === args.item);
  if (!item) return fail('unknown_item', 'no such item in your queue (`dreamcontext super queue list`)');
  if (!ownerPermissionItem(item)) return fail('not_owner_permission', 'that item is no permission of the owner\'s waiting: a Bypass child\'s permission is yours (`super allow`), a question is answered with `super answer`');
  const w = findOwnerWords(record.session, args.ref, now);
  if (!w) {
    return ownerWordsUsed(record.session, args.ref)
      ? fail('ref_used', 'that message of his already passed one permission: one message, one permission. Ask him, or ' + TAP)
      : fail('not_owner_message', `the server has no message of his with ref ${args.ref} in your chat (a server turn, a run report, a schedule, a child's or a page's words, or a guess are not his; nor is one older than a day). Name the ref of HIS message, or ${TAP}`);
  }
  if (w.via === 'composer') return fail('mac_words', 'he typed it on the Mac, where the server cannot prove a message is his: the card is in front of him there, tell him in one line to tap it');
  if (w.at <= item.createdAt) return fail('before_card', `his message came before this card was born, so it cannot be about it: ask him, or ${TAP}`);
  // His waiting permissions WHEN HE WROTE (read then), so closing one since cannot narrow his words.
  const snap = await w.waiting;
  const waiting: WaitingCard[] = snap ?? waitingCards(record.queue.filter((q) => q.createdAt < w.at));
  if (snap && !snap.some((c) => c.id === item.id)) return fail('before_card', `this card was not waiting on him when he wrote: ask him, or ${TAP}`);
  const nameOf = (c: WaitingCard): string[] => (c.member ? [c.member, deps.memberName(c.member) ?? ''].filter(Boolean) : []);
  const said = consentOf(w.text, waiting.flatMap(nameOf));
  const want = args.deny ? 'deny' : 'allow';
  if (said !== want) {
    return fail('not_consent', said === null
      ? `his message is not a plain ${want === 'allow' ? 'yes' : 'no'} on its own (a question, a condition or any other words are no consent): ask him, or ${TAP}`
      : `his message says ${said === 'allow' ? 'yes' : 'no'}, not ${want === 'allow' ? 'yes' : 'no'}`);
  }
  if (waiting.length > 1) {
    const named = waiting.filter((c) => nameOf(c).some((n) => mentions(w.text, n)));
    if (!(named.length === 1 && named[0].id === item.id)) {
      return fail('several_pending', `${waiting.length} of his permissions were waiting when he wrote and his message does not name which: ask him which one (by its member's name), or ${TAP}`, waiting.map((c) => c.id));
    }
  }
  // Spent NOW, before any further wait (two calls at once on one message: the second finds it
  // used); given back only when nothing was answered.
  if (w.used) return fail('ref_used', 'that message of his already passed one permission: one message, one permission. Ask him, or ' + TAP);
  w.used = true;
  let answered = false;
  try {
    // What it would run, read live: a mirror is checked on its member's own item.
    const target = item.kind === 'member' ? (await deps.mirror(root, item.id))?.item ?? null : item;
    const call = target ? deps.call(target) : null;
    if (!target || !call) return fail('stale_request', 'that permission is no longer asked');
    if (!args.deny) {
      const why = writtenConsentRefusal(call);
      if (why) return fail('outward', `never on his written word: ${why}. Tell him in one plain line, in his language, that a step that leaves this machine needs his tap, not a typed yes; ${TAP}`);
    }
    const answer: OwnerAnswer = target.kind === 'owner'
      ? { kind: 'refusal', action: args.deny ? 'not_needed' : 'allow', size: 'once' }
      : { kind: 'permission', behavior: args.deny ? 'deny' : 'allow', size: 'once' };
    const r = await deps.answer(root, {
      record: record.superId === 'main' ? 'main' : record.superId.slice(MEMBER_SUPER_PREFIX.length),
      // His words were written to the Super chat (from his phone or its Telegram): answered as the chat answers.
      item: item.id, via: 'chat', answer, shown: { tool: call.tool, input: call.input },
    });
    answered = r.ok;
    return { ok: true, answer: r, behavior: want };
  } finally {
    if (!answered) delete w.used;
  }
}
