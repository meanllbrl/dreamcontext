/**
 * Where a Telegram binding lives, and how it is read and written safely.
 *
 *   ~/.dreamcontext/telegram/<scope>/<target>/   0700
 *     bot.json      0600  BotBinding (the token; hub-written; bindingHash)
 *     poll.json     0600  PollState (offset, rings, journal: no message text)
 *     turns.json    0600  TurnsFile (refs that route back: no message text)
 *     forward.json  0600  ForwardFile (routines whose results the member bot sends)
 *   ~/.dreamcontext/telegram/manager/bot.json      the device-level manager (X2)
 *   ~/.dreamcontext/telegram/managed-history.json  adoption rows (AA2)
 *
 * `<scope>` = sha256(realpath contextRoot)[:16] for a project, `global` for a global member.
 * Never in a project or the brain. Every read refuses a symlink anywhere from the telegram
 * folder down to the file, a hardlinked file, and anything whose realpath leaves the folder
 * (lstat + realpath containment). Writes are atomic (exclusive temp + rename) at 0600 in 0700
 * folders. A bot.json whose bindingHash does not match was not written by the hub: the caller
 * disables the binding (`readBinding` → `tamper`). Named residual: a same-user process can read
 * the token, as with every 0600 secret on the machine.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import {
  POLL_RING_SIZE, TELEGRAM_MANAGER_DIR, TELEGRAM_SCOPE_RE, TELEGRAM_TARGET_RE, TELEGRAM_TOKEN_RE,
  type BotBinding, type ForwardFile, type JournalEntry, type ManagedHistoryFile, type ManagedHistoryRow,
  type PollState, type TelegramScope, type TelegramTarget, type TurnsFile,
} from './contract.js';

export type ConfigFile = 'bot.json' | 'poll.json' | 'turns.json' | 'forward.json';

/** `~/.dreamcontext/telegram`. */
export function telegramBase(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'telegram');
}

/** The scope of a project: sha256 of its context root's realpath, first 16 hex. */
export function scopeOfContextRoot(contextRoot: string): TelegramScope {
  let real = contextRoot;
  try { real = realpathSync(contextRoot); } catch { /* not there yet: the literal path */ }
  return createHash('sha256').update(real).digest('hex').slice(0, 16);
}

export function isValidScope(scope: string): boolean {
  return TELEGRAM_SCOPE_RE.test(scope);
}
export function isValidTarget(target: string): boolean {
  return TELEGRAM_TARGET_RE.test(target) && target !== TELEGRAM_MANAGER_DIR;
}
export function isValidToken(token: unknown): token is string {
  return typeof token === 'string' && TELEGRAM_TOKEN_RE.test(token);
}

/** The folder of one binding; throws on a scope or target that could climb or collide. */
export function bindingDir(scope: TelegramScope, target: TelegramTarget, home: string = homedir()): string {
  if (!isValidScope(scope)) throw new Error('invalid telegram scope');
  if (!isValidTarget(target)) throw new Error('invalid telegram target');
  return join(telegramBase(home), scope, target);
}
export function managerDir(home: string = homedir()): string {
  return join(telegramBase(home), TELEGRAM_MANAGER_DIR);
}

// ─── Redaction ──────────────────────────────────────────────────────────────

/** A token anywhere in a string (a `bot<token>/` URL segment included). */
const TOKEN_ANYWHERE = /\d{5,}:[A-Za-z0-9_-]{30,}/g;

/** Removes every token-shaped substring (and the exact `token`, if given). For logs and errors:
 *  a Bot API URL carries the token in its path. */
export function redactToken(text: string, token?: string): string {
  let out = String(text);
  if (token) out = out.split(token).join('<token>');
  return out.replace(TOKEN_ANYWHERE, '<token>');
}

// ─── Safe read / atomic write ───────────────────────────────────────────────

export type ReadRefusal = 'absent' | 'symlink' | 'not_file' | 'hardlink' | 'outside' | 'invalid';

/** Every path component from the telegram base down to `file`, each lstat'ed: none may be a
 *  symlink, every folder a folder. */
function checkChain(base: string, file: string): ReadRefusal | null {
  if (!(file === base || file.startsWith(base + sep))) return 'outside';
  const parts = file.slice(base.length).split(sep).filter(Boolean);
  let cur = base;
  const chain = [base, ...parts.map((p) => (cur = join(cur, p)))];
  for (let i = 0; i < chain.length; i++) {
    let st;
    try { st = lstatSync(chain[i]); } catch { return 'absent'; }
    if (st.isSymbolicLink()) return 'symlink';
    const last = i === chain.length - 1;
    if (!last && !st.isDirectory()) return 'not_file';
    if (last && !st.isFile()) return 'not_file';
    if (last && st.nlink > 1) return 'hardlink';
  }
  try {
    const realBase = realpathSync(base);
    const real = realpathSync(file);
    if (!real.startsWith(realBase + sep)) return 'outside';
  } catch { return 'absent'; }
  return null;
}

/** Reads a JSON file under the telegram folder, refusing symlinks, hardlinks and escapes. The
 *  file is opened O_NOFOLLOW and its fstat must be the file checked. */
export function readTelegramJson(file: string, home: string = homedir()): { ok: true; value: unknown } | { ok: false; reason: ReadRefusal } {
  const base = telegramBase(home);
  const refused = checkChain(base, file);
  if (refused) return { ok: false, reason: refused };
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return { ok: false, reason: 'symlink' }; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink > 1) return { ok: false, reason: 'hardlink' };
    const raw = readFileSync(fd, 'utf-8');
    try { return { ok: true, value: JSON.parse(raw) }; } catch { return { ok: false, reason: 'invalid' }; }
  } finally {
    closeSync(fd);
  }
}

/** Creates (or tightens) every folder from the base down to `dir` at 0700, refusing a symlink. */
function ensureDir(dir: string, home: string): void {
  const base = telegramBase(home);
  const dreamcontext = join(home, '.dreamcontext');
  mkdirSync(dreamcontext, { recursive: true });
  if (!(dir === base || dir.startsWith(base + sep))) throw new Error('telegram path outside its folder');
  let cur = base;
  const parts = dir.slice(base.length).split(sep).filter(Boolean);
  for (const p of [null, ...parts]) {
    if (p) cur = join(cur, p);
    try {
      const st = lstatSync(cur);
      if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('telegram folder is not a plain folder');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      mkdirSync(cur, { mode: 0o700 });
    }
    chmodSync(cur, 0o700);
  }
}

/** Writes JSON atomically at 0600: an exclusive temp file beside it, then rename (a symlink at
 *  the destination is replaced, never followed). */
export function writeTelegramJson(file: string, value: unknown, home: string = homedir()): void {
  const dir = file.slice(0, file.lastIndexOf(sep));
  ensureDir(dir, home);
  const tmp = join(dir, `.${randomBytes(6).toString('hex')}.tmp`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, file);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* gone */ }
    throw err;
  }
}

// ─── bot.json ───────────────────────────────────────────────────────────────

const HASH_DOMAIN = 'dreamcontext-telegram-binding-v1\n';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).filter((k) => (value as Record<string, unknown>)[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The hash the hub writes into bot.json: over every field except the hash itself. */
export function bindingHashOf(binding: Omit<BotBinding, 'bindingHash'> | BotBinding): string {
  const { bindingHash: _drop, ...rest } = binding as BotBinding;
  return createHash('sha256').update(HASH_DOMAIN + canonical(rest)).digest('hex');
}

function isBinding(v: unknown): v is BotBinding {
  if (!v || typeof v !== 'object') return false;
  const b = v as Record<string, unknown>;
  return b.v === 1 && isValidToken(b.token)
    && Number.isSafeInteger(b.botId) && Number.isSafeInteger(b.chatId) && Number.isSafeInteger(b.userId)
    && typeof b.botUsername === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(b.botUsername)
    && typeof b.boundAt === 'string' && typeof b.bindingHash === 'string'
    && (b.managed === undefined || typeof b.managed === 'boolean')
    && (b.managerBotId === undefined || Number.isSafeInteger(b.managerBotId));
}

export type BindingRead =
  | { ok: true; binding: BotBinding }
  | { ok: false; reason: ReadRefusal | 'tamper' };

function readBindingFile(file: string, home: string): BindingRead {
  const r = readTelegramJson(file, home);
  if (!r.ok) return r;
  if (!isBinding(r.value)) return { ok: false, reason: 'invalid' };
  if (bindingHashOf(r.value) !== r.value.bindingHash) return { ok: false, reason: 'tamper' };
  return { ok: true, binding: r.value };
}

/** The shared binding reader: hub, tick and runner all go through it (W6). `tamper` = the file
 *  was not written by the hub; the caller disables the binding and never sends with it. */
export function readBinding(scope: TelegramScope, target: TelegramTarget, home: string = homedir()): BindingRead {
  return readBindingFile(join(bindingDir(scope, target, home), 'bot.json'), home);
}
export function readManagerBinding(home: string = homedir()): BindingRead {
  return readBindingFile(join(managerDir(home), 'bot.json'), home);
}

/** Stamps the hash and writes bot.json (hub only). Returns what was written: the hub keeps
 *  `bindingHash` in memory and compares it on every read (a rewrite with a fresh valid hash by
 *  another process is caught there). */
export function writeBinding(scope: TelegramScope, target: TelegramTarget, fields: Omit<BotBinding, 'bindingHash' | 'v'>, home: string = homedir()): BotBinding {
  if (!isValidToken(fields.token)) throw new Error('invalid telegram token');
  const unhashed = { v: 1 as const, ...fields };
  const binding: BotBinding = { ...unhashed, bindingHash: bindingHashOf(unhashed) };
  writeTelegramJson(join(bindingDir(scope, target, home), 'bot.json'), binding, home);
  return binding;
}
export function writeManagerBinding(fields: Omit<BotBinding, 'bindingHash' | 'v'>, home: string = homedir()): BotBinding {
  if (!isValidToken(fields.token)) throw new Error('invalid telegram token');
  const unhashed = { v: 1 as const, ...fields };
  const binding: BotBinding = { ...unhashed, bindingHash: bindingHashOf(unhashed) };
  writeTelegramJson(join(managerDir(home), 'bot.json'), binding, home);
  return binding;
}

/** Removes one binding's whole folder (bot, poll, turns, forward). A symlinked folder is
 *  unlinked as a link, never followed. */
export function removeBindingDir(scope: TelegramScope, target: TelegramTarget, home: string = homedir()): void {
  const dir = bindingDir(scope, target, home);
  try {
    const st = lstatSync(dir);
    if (st.isSymbolicLink()) { unlinkSync(dir); return; }
  } catch { return; }
  rmSync(dir, { recursive: true, force: true });
}
export function removeManager(home: string = homedir()): void {
  const dir = managerDir(home);
  try {
    if (lstatSync(dir).isSymbolicLink()) { unlinkSync(dir); return; }
  } catch { return; }
  rmSync(dir, { recursive: true, force: true });
  try { unlinkSync(managedHistoryPath(home)); } catch { /* none */ }
}

/** Every binding folder on this Mac (Settings list, the duplicate-bot check). Unreadable or
 *  tampered ones are listed with their refusal so the caller can show them disabled. */
export function listBindings(home: string = homedir()): { scope: TelegramScope; target: TelegramTarget; read: BindingRead }[] {
  const base = telegramBase(home);
  const out: { scope: TelegramScope; target: TelegramTarget; read: BindingRead }[] = [];
  let scopes: string[] = [];
  try {
    if (lstatSync(base).isSymbolicLink()) return out;
    scopes = readdirSync(base);
  } catch { return out; }
  for (const scope of scopes) {
    if (!isValidScope(scope)) continue;
    let targets: string[] = [];
    try {
      if (!lstatSync(join(base, scope)).isDirectory()) continue;
      targets = readdirSync(join(base, scope));
    } catch { continue; }
    for (const target of targets) {
      if (!isValidTarget(target)) continue;
      out.push({ scope, target, read: readBinding(scope, target, home) });
    }
  }
  return out;
}

// ─── poll.json, turns.json, forward.json ────────────────────────────────────

const ring = (v: unknown): number[] => (Array.isArray(v) ? v.filter((n) => Number.isSafeInteger(n)).slice(-POLL_RING_SIZE) : []);

function journalOf(v: unknown): JournalEntry[] {
  if (!Array.isArray(v)) return [];
  const kinds = new Set(['text', 'media', 'callback', 'command']);
  const out: JournalEntry[] = [];
  for (const e of v) {
    if (!e || typeof e !== 'object') continue;
    const j = e as Record<string, unknown>;
    if (!Number.isSafeInteger(j.updateId) || !kinds.has(j.kind as string) || typeof j.at !== 'number') continue;
    out.push({
      updateId: j.updateId as number,
      kind: j.kind as JournalEntry['kind'],
      written: j.written === true,
      at: j.at as number,
      ...(typeof j.ref === 'string' && /^[0-9a-z]{6}$/.test(j.ref) ? { ref: j.ref } : {}),
      ...(typeof j.chatRegistryId === 'string' && j.chatRegistryId.length <= 200 ? { chatRegistryId: j.chatRegistryId } : {}),
    });
  }
  return out.slice(-POLL_RING_SIZE);
}

export const EMPTY_POLL: PollState = { v: 1, offset: 0, seenIds: [], notifiedIds: [], pending: [] };

/** poll.json, normalised: anything malformed is dropped, never trusted (only notices can follow). */
export function readPollState(dir: string, home: string = homedir()): PollState {
  const r = readTelegramJson(join(dir, 'poll.json'), home);
  if (!r.ok || !r.value || typeof r.value !== 'object') return { ...EMPTY_POLL, seenIds: [], notifiedIds: [], pending: [] };
  const p = r.value as Record<string, unknown>;
  return {
    v: 1,
    offset: Number.isSafeInteger(p.offset) && (p.offset as number) >= 0 ? (p.offset as number) : 0,
    seenIds: ring(p.seenIds),
    notifiedIds: ring(p.notifiedIds),
    pending: journalOf(p.pending),
  };
}
export function writePollState(dir: string, state: PollState, home: string = homedir()): void {
  writeTelegramJson(join(dir, 'poll.json'), {
    v: 1,
    offset: state.offset,
    seenIds: state.seenIds.slice(-POLL_RING_SIZE),
    notifiedIds: state.notifiedIds.slice(-POLL_RING_SIZE),
    pending: journalOf(state.pending),
  }, home);
}

export function readTurns(dir: string, home: string = homedir()): TurnsFile {
  const r = readTelegramJson(join(dir, 'turns.json'), home);
  const list = r.ok && r.value && typeof r.value === 'object' ? (r.value as { turns?: unknown }).turns : null;
  if (!Array.isArray(list)) return { v: 1, turns: [] };
  const turns = list.filter((t): t is TurnsFile['turns'][number] => !!t && typeof t === 'object'
    && typeof (t as { ref?: unknown }).ref === 'string' && /^[0-9a-z]{6}$/.test((t as { ref: string }).ref)
    && Number.isSafeInteger((t as { updateId?: unknown }).updateId)
    && Number.isSafeInteger((t as { chatId?: unknown }).chatId)
    && typeof (t as { sessionId?: unknown }).sessionId === 'string'
    && typeof (t as { firstAt?: unknown }).firstAt === 'number');
  return { v: 1, turns };
}
export function writeTurns(dir: string, file: TurnsFile, home: string = homedir()): void {
  writeTelegramJson(join(dir, 'turns.json'), { v: 1, turns: file.turns }, home);
}

export function readForward(dir: string, home: string = homedir()): ForwardFile {
  const r = readTelegramJson(join(dir, 'forward.json'), home);
  const list = r.ok && r.value && typeof r.value === 'object' ? (r.value as { routines?: unknown }).routines : null;
  if (!Array.isArray(list)) return { v: 1, routines: [] };
  return {
    v: 1,
    routines: list.filter((e): e is ForwardFile['routines'][number] => !!e && typeof e === 'object'
      && typeof (e as { projectKey?: unknown }).projectKey === 'string'
      && typeof (e as { slug?: unknown }).slug === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test((e as { slug: string }).slug)
      && typeof (e as { approvalHash?: unknown }).approvalHash === 'string'),
  };
}

// ─── managed-history.json (AA2, AB) ─────────────────────────────────────────

export function managedHistoryPath(home: string = homedir()): string {
  return join(telegramBase(home), 'managed-history.json');
}

function isHistoryRow(v: unknown): v is ManagedHistoryRow {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r.target === 'string' && isValidTarget(r.target) && typeof r.projectKey === 'string'
    && Number.isSafeInteger(r.botId) && Number.isSafeInteger(r.creatorId) && Number.isSafeInteger(r.managerBotId)
    && typeof r.botUsername === 'string' && typeof r.adoptedAt === 'string';
}

/** The adoption record: 0600, symlink refused (via `readTelegramJson`); malformed rows dropped. */
export function readManagedHistory(home: string = homedir()): ManagedHistoryFile {
  const r = readTelegramJson(managedHistoryPath(home), home);
  const rows = r.ok && r.value && typeof r.value === 'object' ? (r.value as { rows?: unknown }).rows : null;
  return { v: 1, rows: Array.isArray(rows) ? rows.filter(isHistoryRow) : [] };
}

/** Appends one owner-checked adoption (hub only). Rows for the same target and project with a
 *  DIFFERENT bot are dropped first (AB: re-binding a target to another bot). */
export function appendManagedHistory(row: ManagedHistoryRow, home: string = homedir()): void {
  const cur = readManagedHistory(home);
  const rows = cur.rows.filter((r) => !(r.target === row.target && r.projectKey === row.projectKey && r.botId !== row.botId));
  rows.push(row);
  writeTelegramJson(managedHistoryPath(home), { v: 1, rows }, home);
}
