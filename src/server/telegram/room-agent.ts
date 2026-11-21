/**
 * A permitted Telegram group's room agent (tg-grup C3, C5, D5-D10).
 *
 * The OWNER's own addressed message (his bound Telegram id) never meets the room agent: it is a turn
 * of his bot's own Super, as in his private chat (owner 2026-11-21: "zaten ben vermişim sana, niye
 * benden onayı istiyorsun"): the same session, permission mode, tools and MCP servers, no card; the
 * result reaches the group through `super room say`. Every other addressed message becomes a turn
 * of THAT room's agent: one `claude -p` in the room envelope ({@link roomAgentArgs}), started in the room's EMPTY
 * 0700 folder (`rooms/<chatId>/cwd/`), reading only the brain's shared pages through the allow
 * rules (quick-readable.ts) and `memory recall` scoped to them. It never changes anything: a change
 * someone asks for becomes a request the owner approves in his PRIVATE chat; his Onayla writes one
 * turn into the bot's own Super, which reports back to the group only through `super room say`.
 *
 * Never reached by anything but the hub's group branch (G1): a group message never reaches the
 * Super's session, a run's stdin, a capture slot or presence. Its only way out to a group is the
 * hub's `sendRoom` (G4). Pacing by what qualifies (D9): one turn at a time per room, messages that
 * arrive meanwhile fold into the next one; one open request per room, a later one held.
 */
import { randomBytes } from 'node:crypto';
import { lstatSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, extname, join, relative, resolve, sep } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { executeClaudeDetached, type ClaudeExecution, type ClaudeExecOptions } from '../../lib/automations/runner.js';
import { accountEnvFor, resolveConfigDir } from '../../lib/claude-accounts.js';
import { ensureSandbox } from '../../lib/claude-account-sandbox.js';
import { chatSpawnAccount } from '../../lib/automations/account.js';
import { claudeAwarePath } from '../../lib/claude-path.js';
import { cliAwarePath } from '../../lib/automations/cli-path.js';
import { killPortable } from '../../lib/proc.js';
import { AGENT_CHAT_ENV } from '../../lib/automations/types.js';
import { QUICK_RECALL_SCOPE, QUICK_RECALL_SCOPE_ENV, quickBrainRoot, quickBrainToolArgs, quickCliShimDir } from '../../lib/whiteboards/quick-memory.js';
import { MEDIA_FILE, readOutbound } from '../../lib/telegram/files.js';
import { markdownImages } from '../../lib/telegram/format.js';
import { superMediaRoots } from './media-roots.js';
import { quickReadable } from '../../lib/whiteboards/quick-readable.js';
import { resultLine } from '../../lib/whiteboards/quick-edit.js';
import { readRoom, removeRoom, roomDirs, writeRoom, type RoomFile, type RoomRequest } from '../../lib/telegram/config.js';
import { escapeHtml, redactSecrets } from '../../lib/telegram/format.js';
import type { UploadFile } from '../../lib/telegram/transport.js';
import { voiceAnswer } from '../../lib/telegram/voice-block.js';
import { voiceCaptionHtml } from '../../lib/telegram/system-lines.js';
import { speakSummary, type SpeakSummaryResult } from '../voice-speak.js';
import { VOICE_DEADLINE_MS } from './voice-reply.js';
import { ROOM_SCHEMA, readRoomAnswer, roomSystemPrompt, roomUserMessage, type RoomAnswer } from '../../lib/telegram/room-prompt.js';
import {
  ROOM_LINES, approvedTurnText, asShown, authorLabel, batchWords, consentable, foldBatch, redactPaths, requestIdFrom, roomCard, stripHidden, type RoomLine,
} from '../../lib/telegram/rooms.js';
import { TG_UPLOAD_MAX_BYTES, type ButtonRecord } from '../../lib/telegram/contract.js';
import { identityFor } from './identity.js';
import { appChatRefusal } from '../../lib/apps/chat-store.js';
import type { ActiveBinding, TelegramHub } from './hub.js';
import type { SuperId } from '../../lib/super/types.js';

type Obj = Record<string, unknown>;

/** The room agent's model: Claude always (a Codex or Antigravity run cannot deny a read by path),
 *  passed explicitly (project rule: every `claude -p` names its model). */
export const ROOM_MODEL = 'opus';
export const ROOM_EFFORT = 'medium';
/** How long one room turn may take. */
export const ROOM_TIMEOUT_MS = 120_000;
/** How long the room's recall block may take before the turn goes on without it. */
export const ROOM_RECALL_DEADLINE_MS = 2_500;
/** Telegram's typing indicator lasts ~5 s. */
const TYPING_EVERY_MS = 4_000;
/** A card's quote is split over messages past this (Telegram's 4096, minus the card's frame). */
/** A group voice note is heard only up to this long / this big. */
const VOICE_MAX_S = 300;
const VOICE_MAX_BYTES = 5 * 1024 * 1024;

/**
 * THE argv of a room turn (G5): read-only search of the brain's shared pages, no settings, no
 * MCP, no slash commands, its answer in the schema; `--resume` the room's own conversation.
 * Never `--no-session-persistence` (the room resumes), never a permission-prompt tool, never any
 * other allowed tool, never `dreamcontext super`.
 */
export function roomAgentArgs(o: { system: string; user: string; brainReal: string; resume: string | null; model?: string; home?: string }): string[] {
  return [
    '-p', o.user,
    '--model', o.model || ROOM_MODEL,
    '--effort', ROOM_EFFORT,
    '--output-format', 'json',
    ...quickBrainToolArgs(o.brainReal, o.home),
    '--setting-sources', '',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--system-prompt', o.system,
    '--json-schema', JSON.stringify(ROOM_SCHEMA),
    // An app's conversation opens only in Chat (apps-resume-drift): such an id starts fresh here.
    ...(o.resume && !appChatRefusal(o.resume, o.home) ? ['--resume', o.resume] : []),
  ];
}

/** The room's recall block: this vault, quick-readable pages only, each named by its ABSOLUTE
 *  path (the agent works in an empty folder). Bounded by time; '' on anything else. */
export async function roomRecallBlock(root: string, text: string, brainReal: string, deadlineMs = ROOM_RECALL_DEADLINE_MS): Promise<string> {
  const words = text.trim();
  if (!words) return '';
  const work = (async (): Promise<string> => {
    const [{ resolveRecallMode }, { recallGatePasses, renderRecallBlock, selectPromptRecall }] = await Promise.all([
      import('../../cli/commands/sleep.js'),
      import('../../cli/commands/hook.js'),
    ]);
    const mode = resolveRecallMode(root);
    if (mode === 'off') return '';
    const r = await selectPromptRecall(words, root, mode === 'haiku' ? 'raw' : mode, { env: {}, viaDashboard: null });
    // The filter FIRST, on the relative path; only then the absolute path for the agent to read.
    const hits = r.hits.filter((h) => quickReadable(h.doc.relPath));
    if (!recallGatePasses(hits, r.haiku, words)) return '';
    const abs = hits.map((h) => ({ ...h, doc: { ...h.doc, relPath: join(brainReal, h.doc.relPath) } }));
    return renderRecallBlock(abs as typeof hits, r.label).join('\n').trim();
  })().catch(() => '');
  let timer: NodeJS.Timeout | null = null;
  const late = new Promise<string>((resolve) => { timer = setTimeout(() => resolve(''), deadlineMs); timer.unref?.(); });
  try { return await Promise.race([work, late]); } finally { if (timer) clearTimeout(timer); }
}

/** The run's stdout → its answer and its session id; null answer when it has no schema shape. */
export function parseRoomOutput(stdout: string): { answer: RoomAnswer | null; sessionId: string | null; noSession: boolean } {
  let doc: Obj | null = null;
  try { const p = JSON.parse(resultLine(stdout)) as unknown; if (p && typeof p === 'object' && !Array.isArray(p)) doc = p as Obj; } catch { /* not an envelope */ }
  if (!doc) return { answer: null, sessionId: null, noSession: false };
  const sessionId = typeof doc.session_id === 'string' && /^[0-9a-f-]{36}$/i.test(doc.session_id) ? doc.session_id : null;
  const noSession = doc.is_error === true && /no conversation found/i.test(String(doc.result ?? ''));
  if (doc.is_error === true) return { answer: null, sessionId, noSession };
  const candidates: unknown[] = [];
  if (doc.structured_output !== undefined) candidates.push(doc.structured_output);
  if (typeof doc.result === 'string') {
    const t = doc.result.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
    try { candidates.push(JSON.parse(t)); } catch { /* not JSON */ }
  }
  for (const c of candidates) { const a = readRoomAnswer(c); if (a) return { answer: a, sessionId, noSession }; }
  return { answer: null, sessionId, noSession };
}

export interface RoomDeps {
  exec?: (args: string[], opts: ClaudeExecOptions) => Promise<ClaudeExecution>;
  /** The brain's real path (default `quickBrainRoot`); null refuses the turn. */
  brain?: (root: string) => string | null;
  memory?: (root: string, text: string, brainReal: string) => Promise<string>;
  /** The run's account env (default: the chat's account sandbox). */
  env?: () => Record<string, string | undefined>;
  timeoutMs?: number;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** The CLI the room's shim runs (tests: a fake path). */
  cli?: { execPath: string; entry: string | undefined };
  /** The media-only folders outside the project a `room say` picture may come from: the same ones
   *  as his private chat (default `superMediaRoots`: linked repos, worktrees, the temp folders). */
  fileRoots?: (root: string) => string[] | Promise<string[]>;
  /** The git-ignore probe of the file rule (tests: a folder that is no git repo). */
  isGitIgnored?: (root: string, rel: string) => boolean;
  /** A result's spoken summary → OGG (default: the hub's, else the Mac's voice). */
  speak?: (text: string) => Promise<SpeakSummaryResult>;
}

type VoiceNote = { file_id?: string; file_size?: number; duration?: number };
/** A member's request still waiting on the owner's card (open or held). His own never waits. */
const waitsOnOwner = (q: RoomRequest): boolean => (q.status === 'open' || q.status === 'held') && !q.own;
/** A waiting message: its text, or a voice note heard in the drain, in arrival order. */
type Pending = RoomLine | { authorId: number; author: string; voice: VoiceNote };

interface RoomState {
  pending: Pending[];
  running: boolean;
  child: ChildProcess | null;
  stopped: boolean;
}

/** Owner-facing results of `room say`. `notSent`: the parts Telegram did not take (the rest did);
 *  the request stays open for a say of only those parts. */
export type RoomSayResult = { ok: true; group: string; notSent?: string[] } | { ok: false; status: number; error: string; message: string };

/** Telegram's limit for one message, after the HTML escape. */
const TG_TEXT_MAX = 4096;

/** `text` escaped and split into messages that each fit Telegram's limit (never inside a
 *  character or an entity): every word goes, a long result full of `&`, `<`, `>` included. */
export function splitEscaped(text: string, max = TG_TEXT_MAX): string[] {
  const out: string[] = [];
  let cur = '';
  for (const ch of text) {
    const e = escapeHtml(ch);
    if (cur.length + e.length > max) { out.push(cur); cur = ''; }
    cur += e;
  }
  if (cur) out.push(cur);
  return out;
}

/** The most one `room say` may attach in all (Telegram's 50 MB per request). */
export const ROOM_FILES_MAX_BYTES = TG_UPLOAD_MAX_BYTES;
const PHOTO_EXT: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const CONTENT_EXT: Record<string, string> = { ...PHOTO_EXT, '.gif': 'image/gif', '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm' };

/** A file name that holds keys or credentials, whatever folder it is in. */
const SECRET_NAME_RE = /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pgpass|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*credentials.*|.*secrets?\.json|.*\.(?:pem|key|p12|pfx|keychain))$/i;

/** Where a group file may come from: the project, the media-only folders of his private chat, and
 *  the brain (whose private pages stay closed). */
export interface RoomFileRules {
  projectRoot: string;
  mediaRoots: readonly string[];
  brain?: string | null;
  isGitIgnored?: (root: string, rel: string) => boolean;
}

/**
 * The files a `room say` names, read whole BEFORE anything is sent (a bad one refuses the say, so
 * nothing half-lands). THE rule of his private chat (`files.ts` `readOutbound`, owner 2026-11-21:
 * "atabilmesi gerektiğini düşünüyorum"): inside the project, or a picture, clip or PDF from the
 * folders a Super's screenshots live in (linked repos, worktrees, the temp folders); never a
 * symlink, a hardlink, `.git`, the secret class or a git-ignored project file. Because others read
 * the group, also never a dot file or a key file by name, never empty, and inside the brain only a
 * page the room may read (`quickReadable`: never `people/`, `lab/`, `inbox/`) or a picture, clip or
 * PDF the Super made under `tmp/` or a task's `state/assets/`; together within Telegram's upload size.
 */
export function readRoomFiles(paths: readonly string[], rules: RoomFileRules): { ok: true; files: { file: UploadFile; photo: boolean }[] } | { ok: false; message: string } {
  const real = (a: string) => { try { return realpathSync.native(a); } catch { return null; } };
  const brainReal = rules.brain ? real(rules.brain) : null;
  const under = (p: string, r: string) => p === r || p.startsWith(r.endsWith(sep) ? r : r + sep);
  const out: { file: UploadFile; photo: boolean }[] = [];
  let total = 0;
  for (const raw of paths) {
    const p = resolve(rules.projectRoot, raw);
    const name = basename(p);
    let st;
    try { st = lstatSync(p); } catch { return { ok: false, message: `no such file: ${name}` }; }
    if (st.isSymbolicLink() || !st.isFile()) return { ok: false, message: `not a plain file: ${name}` };
    if (st.size === 0) return { ok: false, message: `${name} is empty` };
    const r = readOutbound(p, {
      roots: [rules.projectRoot], projectRoot: rules.projectRoot, mediaRoots: rules.mediaRoots,
      maxBytes: ROOM_FILES_MAX_BYTES, ...(rules.isGitIgnored ? { isGitIgnored: rules.isGitIgnored } : {}),
    });
    if (!r.ok) return { ok: false, message: `${name} may not go to a group (${r.reason})` };
    const at = real(p) ?? p;
    if (basename(at).startsWith('.') || SECRET_NAME_RE.test(basename(at))) return { ok: false, message: `${name} may not go to a group` };
    if (brainReal && under(at, brainReal)) {
      const rel = relative(brainReal, at).split(sep).join('/');
      const made = MEDIA_FILE.test(rel) && (rel.startsWith('tmp/') || rel.startsWith('state/assets/'));
      if (!made && !quickReadable(rel)) return { ok: false, message: `${name} is a private page of the brain` };
    }
    total += r.file.data.length;
    if (total > ROOM_FILES_MAX_BYTES) return { ok: false, message: 'the files are larger than Telegram takes (50 MB in all)' };
    const ext = extname(name).toLowerCase();
    const type = CONTENT_EXT[ext];
    out.push({ file: { name: r.file.name, data: r.file.data, ...(type ? { contentType: type } : {}) }, photo: !!PHOTO_EXT[ext] });
  }
  return { ok: true, files: out };
}

/** A local picture written into a result (`![name](path)`) as in his private chat: its path goes
 *  with the files, the markup leaves the text. A web picture stays a link. */
export function picturesOfSay(text: string): { text: string; paths: string[] } {
  const local = markdownImages(text).filter((i) => !i.web).map((i) => i.src);
  if (!local.length) return { text, paths: [] };
  const rest = text.replace(/!\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"\n]*")?\s*\)/g, (m: string, src: string) => (/^(?:https?:)?\/\//i.test(src) ? m : ''));
  return { text: rest.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim(), paths: [...new Set(local)] };
}

export class RoomRunner {
  private rooms = new Map<string, RoomState>();
  /** Request ids whose `room say` is being sent now: a second say waits for the first's outcome. */
  private saying = new Set<string>();
  /** Request ids being offered or delivered right now: their card is on its way, or the owner
   *  pressed Onayla and the turn is being delivered. Such a request already has its answer path. */
  private inFlight = new Set<string>();
  /** The owner's own messages of a room, in arrival order (a voice note is heard first). */
  private ownLine = new Map<string, Promise<void>>();
  constructor(private readonly hub: TelegramHub, private readonly deps: RoomDeps = {}) {}

  private keyOf(ab: ActiveBinding, chatId: number): string { return `${ab.key}:${chatId}`; }

  private titleOf(ab: ActiveBinding, chatId: number): string | null {
    return (ab.binding.groups ?? []).find((g) => g.chatId === chatId)?.title ?? null;
  }

  /** The group is still permitted and its binding still the live one. */
  private live(ab: ActiveBinding, chatId: number): boolean {
    return this.hub.active.get(ab.key) === ab && !ab.disabled && !ab.halted && this.titleOf(ab, chatId) !== null;
  }

  /** Is a turn running for this room (tests). */
  busy(ab: ActiveBinding, chatId: number): boolean { return !!this.rooms.get(this.keyOf(ab, chatId))?.running; }

  /** One addressed message (G1 already passed: a permitted group, not a stranger, addressed). */
  onMessage(ab: ActiveBinding, chatId: number, msg: Obj): void {
    const from = msg.from as { id: number; first_name?: string; last_name?: string; username?: string } | undefined;
    const text = typeof msg.text === 'string' ? msg.text : typeof msg.caption === 'string' ? msg.caption : '';
    if (!from) return;
    const voice = msg.voice as VoiceNote | undefined;
    // His own message (his bound Telegram id, never a name): his Super's turn, never the room agent's.
    if (from.id === ab.binding.userId) { this.own(ab, chatId, from, text.trim(), voice); return; }
    // A member's voice note (a reply to the bot) is heard into the turn (D4); never kept anywhere.
    if (!text.trim() && voice?.file_id) { this.queue(ab, chatId, { authorId: from.id, author: authorLabel(from), voice }); return; }
    if (!text.trim()) return;
    this.queue(ab, chatId, { authorId: from.id, author: authorLabel(from), text: text.trim() });
  }

  /**
   * The owner's own addressed message in a bound group = his message in his private chat (owner
   * 2026-11-21): it goes to his bot's own Super at once (the same session, permission mode, tools
   * and MCP servers), no card and no room agent; its words are the job. In arrival order per room.
   */
  private own(ab: ActiveBinding, chatId: number, from: { id: number; first_name?: string; last_name?: string; username?: string }, text: string, voice: VoiceNote | undefined): void {
    if (!this.live(ab, chatId) || (!text && !voice?.file_id)) return;
    const key = this.keyOf(ab, chatId);
    const next = (this.ownLine.get(key) ?? Promise.resolve()).then(async () => {
      let words = text;
      if (!words && voice?.file_id) {
        if ((voice.duration ?? 0) > VOICE_MAX_S || (voice.file_size ?? 0) > VOICE_MAX_BYTES) { await this.line(ab, chatId, ROOM_LINES.voiceTooLong); return; }
        void this.hub.sendRoom(ab, chatId, 'room-typing', '');
        words = (await this.hear(ab, voice)) ?? '';
        if (!words) { await this.line(ab, chatId, ROOM_LINES.cannotAnswer); return; }
      }
      if (!this.live(ab, chatId)) return;
      await this.newRequest(ab, chatId, [{ authorId: from.id, author: authorLabel(from), text: words }], '');
    }).catch(() => this.line(ab, chatId, ROOM_LINES.cannotAnswer).then(() => undefined));
    this.ownLine.set(key, next);
    void next.finally(() => { if (this.ownLine.get(key) === next) this.ownLine.delete(key); });
  }

  /** A group voice note → its words, through a private temp folder removed at once. Null when it
   *  cannot be heard (too long, no transcriber, a failed download): the message is dropped. */
  private async hear(ab: ActiveBinding, voice: VoiceNote): Promise<string | null> {
    const transcribe = this.hub.deps.transcribeVoice;
    if (!transcribe || !voice.file_id || (voice.duration ?? 0) > VOICE_MAX_S || (voice.file_size ?? 0) > VOICE_MAX_BYTES) return null;
    const dir = mkdtempSync(join(tmpdir(), 'dc-room-voice-'));
    try {
      const file = await ab.transport.getFile(voice.file_id);
      const bytes = await ab.transport.download(file, VOICE_MAX_BYTES);
      const path = join(dir, 'note.ogg');
      writeFileSync(path, bytes, { mode: 0o600 });
      const heard = ((await transcribe(path)) ?? '').trim();
      return heard ? `🎙 ${heard}` : null;
    } catch { return null; } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  private queue(ab: ActiveBinding, chatId: number, item: Pending): void {
    if (!this.live(ab, chatId)) return;
    const key = this.keyOf(ab, chatId);
    let st = this.rooms.get(key);
    if (!st) { st = { pending: [], running: false, child: null, stopped: false }; this.rooms.set(key, st); }
    st.pending.push(item);
    if (!st.running) void this.drain(ab, chatId, st);
  }

  /**
   * The waiting messages as lines, in arrival order. Voice notes are heard here, inside the room's
   * one drain: one transcription at a time per room, never more audio per turn than one note may
   * hold (VOICE_MAX_S): a note past that waits, with everything after it, for the next turn; a
   * note too long on its own is refused with a line; one that cannot be heard is dropped.
   */
  private async linesOf(ab: ActiveBinding, chatId: number, items: Pending[], st: RoomState): Promise<{ lines: RoomLine[]; rest: Pending[] }> {
    const lines: RoomLine[] = [];
    let audio = 0;
    for (let i = 0; i < items.length; i++) {
      const p = items[i];
      if (!('voice' in p)) { lines.push(p); continue; }
      if (st.stopped) return { lines, rest: [] };
      // Too long on its own: never heard, and the member is told.
      if ((p.voice.duration ?? 0) > VOICE_MAX_S || (p.voice.file_size ?? 0) > VOICE_MAX_BYTES) { await this.line(ab, chatId, ROOM_LINES.voiceTooLong); continue; }
      const d = p.voice.duration ?? VOICE_MAX_S;
      // Past this turn's audio: it and everything after it wait for the next turn, in order.
      if (audio > 0 && audio + d > VOICE_MAX_S) return { lines, rest: items.slice(i) };
      audio += d;
      const heard = await this.hear(ab, p.voice);
      if (heard) lines.push({ authorId: p.authorId, author: p.author, text: heard });
    }
    return { lines, rest: [] };
  }

  private async drain(ab: ActiveBinding, chatId: number, st: RoomState): Promise<void> {
    st.running = true;
    try {
      while (st.pending.length && !st.stopped && this.live(ab, chatId)) {
        const { lines, rest } = await this.linesOf(ab, chatId, st.pending.splice(0), st);
        if (rest.length) st.pending.unshift(...rest);
        if (!lines.length || st.stopped || !this.live(ab, chatId)) continue;
        const batch = foldBatch(lines);
        await this.turn(ab, chatId, batch, st).catch(() => this.line(ab, chatId, ROOM_LINES.cannotAnswer));
      }
    } finally {
      st.running = false;
      st.child = null;
      if (st.stopped) this.rooms.delete(this.keyOf(ab, chatId));
    }
  }

  private line(ab: ActiveBinding, chatId: number, text: string): Promise<boolean> {
    return this.hub.sendRoom(ab, chatId, 'room-line', escapeHtml(text));
  }

  /** The paths this Mac's text must not leak into a group. */
  private privatePaths(root: string, brainReal: string): string[] {
    return [brainReal, root, dirname(root), dirname(brainReal), this.hub.home];
  }

  private async turn(ab: ActiveBinding, chatId: number, batch: RoomLine[], st: RoomState): Promise<void> {
    const root = this.hub.rootOf(ab);
    const brainReal = root ? (this.deps.brain ?? quickBrainRoot)(root) : null;
    const title = this.titleOf(ab, chatId);
    // No brain a rule can hold: refused, never a wider envelope or a run in the brain.
    if (!root || !brainReal || title === null) { await this.line(ab, chatId, ROOM_LINES.cannotAnswer); return; }
    const typing = setInterval(() => { void this.hub.sendRoom(ab, chatId, 'room-typing', ''); }, TYPING_EVERY_MS);
    typing.unref?.();
    void this.hub.sendRoom(ab, chatId, 'room-typing', '');
    try {
      const said = batch.map((l) => l.text).join('\n');
      const memory = await (this.deps.memory ?? roomRecallBlock)(root, said, brainReal).catch(() => '');
      const ident = identityFor({ scope: ab.scope, target: ab.target, contextRoot: root, projectName: ab.projectName }, this.hub.home);
      const system = roomSystemPrompt({
        botName: ident?.name ?? (ab.target === 'super' ? 'Super' : ab.target),
        roleLine: ab.target === 'super' ? '' : ident?.shortDescription ?? '',
        roomTitle: title,
        brainReal,
      });
      const user = roomUserMessage(batch, memory, randomBytes(6).toString('hex'), ab.binding.userId);
      const dirs = roomDirs(ab.scope, ab.target, chatId, this.hub.home);
      let record = readRoom(ab.scope, ab.target, chatId, this.hub.home);
      let run = await this.spawn(ab, root, brainReal, dirs, system, user, record.sessionId, st);
      // A conversation the account no longer has: once more, fresh.
      if (!run.answer && run.noSession && record.sessionId) run = await this.spawn(ab, root, brainReal, dirs, system, user, null, st);
      if (st.stopped || !this.live(ab, chatId)) return;
      record = readRoom(ab.scope, ab.target, chatId, this.hub.home);
      if (run.sessionId) { record.sessionId = run.sessionId; writeRoom(ab.scope, ab.target, record, this.hub.home); }
      if (!run.answer) { await this.line(ab, chatId, ROOM_LINES.cannotAnswer); return; }
      const paths = this.privatePaths(root, brainReal);
      if (run.answer.request) {
        await this.newRequest(ab, chatId, batch, redactPaths(run.answer.request.summary, paths));
        return;
      }
      const say = redactPaths(run.answer.say, paths).trim();
      if (say) await this.sendLong(ab, chatId, say);
      else await this.line(ab, chatId, ROOM_LINES.cannotAnswer);
    } finally {
      clearInterval(typing);
    }
  }

  private async spawn(
    ab: ActiveBinding, root: string, brainReal: string, dirs: { cwd: string; bin: string }, system: string, user: string, resume: string | null, st: RoomState,
  ): Promise<{ answer: RoomAnswer | null; sessionId: string | null; noSession: boolean }> {
    const args = roomAgentArgs({ system, user, brainReal, resume, home: this.hub.home });
    let env: Record<string, string | undefined>;
    if (this.deps.env) env = this.deps.env();
    else {
      const dir = resolveConfigDir(chatSpawnAccount().id ?? null);
      ensureSandbox(dir);
      env = accountEnvFor(dir);
    }
    // The room's recall runs THIS CLI from the project (a baked absolute path), outside the cwd.
    const shim = quickCliShimDir(dirname(dirs.bin), this.deps.cli?.execPath, this.deps.cli ? this.deps.cli.entry : undefined, dirname(root));
    env = {
      ...env,
      [QUICK_RECALL_SCOPE_ENV]: QUICK_RECALL_SCOPE,
      // No window key and no agent-chat mark: the room is nobody's chat and holds no Super verb.
      DREAMCONTEXT_WINDOW_TOKEN: undefined,
      DREAMCONTEXT_WINDOW_URL: undefined,
      [AGENT_CHAT_ENV]: undefined,
      ...(shim ? { PATH: `${shim}${delimiter}${cliAwarePath(claudeAwarePath())}` } : {}),
    };
    const exec = this.deps.exec ?? executeClaudeDetached;
    const r = await exec(args, {
      cwd: dirs.cwd,
      timeoutMs: this.deps.timeoutMs ?? ROOM_TIMEOUT_MS,
      env,
      onSpawned: (child) => {
        st.child = child;
        if (st.stopped && child.pid) this.killChild(child);
      },
    });
    st.child = null;
    if (!r.spawned || r.timedOut) return { answer: null, sessionId: null, noSession: false };
    return parseRoomOutput(r.stdout);
  }

  private killChild(child: ChildProcess): void {
    const pid = child.pid;
    if (!pid) return;
    const kill = this.deps.kill ?? killPortable;
    try { kill(-pid, 'SIGTERM'); } catch { /* gone */ }
    setTimeout(() => { try { kill(-pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref?.();
  }

  // ── Requests (C5, D6, D7, D9) ──

  private async newRequest(ab: ActiveBinding, chatId: number, batch: RoomLine[], summary: string): Promise<void> {
    const sup = this.hub.superOf(ab);
    if (!sup) { await this.line(ab, chatId, ROOM_LINES.cannotAnswer); return; }
    const owner = await this.hub.ownerNameOf(ab);
    const record = readRoom(ab.scope, ab.target, chatId, this.hub.home);
    // The owner's own words (every line of the batch from his bound Telegram account, by id): his
    // message IS the approval. No card, no "özelden sordum": the turn goes to his Super now, never
    // behind a member's request waiting on him. A member's line in the batch keeps the card.
    const own = batch.every((l) => l.authorId === ab.binding.userId);
    // D9: a member's request waits behind every one not yet answered (open or held), in order.
    const held = !own && record.requests.some(waitsOnOwner);
    const last = batch[batch.length - 1];
    const req: RoomRequest = {
      id: this.mintId(record),
      status: held ? 'held' : 'open',
      superId: sup.id,
      authorId: last.authorId,
      authorLabel: last.author,
      // Stored as the owner's card shows them: the turn Onayla sends is the text he read.
      words: asShown(batchWords(batch)),
      summary: asShown(summary) || '—',
      at: this.hub.now(),
    };
    if (own) req.own = true;
    // An own request left open by a restart mid-delivery has nobody to close it: it goes too.
    record.requests = [...record.requests.filter((q) => q.status !== 'done' && q.status !== 'refused' && !(q.own && q.status === 'open' && !this.inFlight.has(q.id))), req];
    writeRoom(ab.scope, ab.target, record, this.hub.home);
    if (own) {
      // In flight from here: no re-offer sends a card for it while it is delivered.
      this.inFlight.add(req.id);
      ab.chain = ab.chain.then(() => this.deliver(ab, chatId, req.id, this.titleOf(ab, chatId) ?? '', owner))
        .catch(() => { /* one failed link never stops the next */ })
        .finally(() => this.inFlight.delete(req.id));
      return;
    }
    if (held) {
      await this.line(ab, chatId, ROOM_LINES.heldBehind);
      // The one ahead may have lost its card (a restart, a failed send): it is offered again.
      await this.reofferHead(ab, chatId);
      return;
    }
    const r = await this.offer(ab, chatId, req);
    if (r === 'sent') await this.line(ab, chatId, ROOM_LINES.askedOwner(owner));
    else if (r === 'failed') await this.line(ab, chatId, ROOM_LINES.notDelivered);
  }

  /**
   * The ONE way a request reaches the owner: its card, only when what he reads is what the Super
   * would get (`consentable`); otherwise it is refused at once, the group told why, and the next
   * waiting one moves up. A request already offered (a live card, its card being sent, its
   * approval being delivered) is never offered twice: 'already'. 'failed' = the send failed; it
   * stays open and `reofferHead` offers it again with the room's next request.
   */
  private async offer(ab: ActiveBinding, chatId: number, req: RoomRequest): Promise<'sent' | 'already' | 'refused' | 'failed'> {
    if (this.offered(req.id)) return 'already';
    if (!consentable(req, this.titleOf(ab, chatId) ?? '')) {
      const record = readRoom(ab.scope, ab.target, chatId, this.hub.home);
      const q = record.requests.find((x) => x.id === req.id);
      if (q) { q.status = 'refused'; q.words = ''; writeRoom(ab.scope, ab.target, record, this.hub.home); }
      await this.line(ab, chatId, ROOM_LINES.unshowable);
      await this.promoteHeld(ab, chatId);
      return 'refused';
    }
    this.inFlight.add(req.id);
    try { await this.sendCard(ab, chatId, req); return 'sent'; } catch { return 'failed'; } finally { this.inFlight.delete(req.id); }
  }

  /** The request has its answer path now: a live card, a card on its way, or a delivery running. */
  private offered(requestId: string): boolean {
    return this.inFlight.has(requestId) || this.hub.hasRequestCard(requestId);
  }

  /** The open request of a room with no live card (records do not survive a restart) gets one. */
  private async reofferHead(ab: ActiveBinding, chatId: number): Promise<void> {
    if (!this.live(ab, chatId)) return;
    const head = readRoom(ab.scope, ab.target, chatId, this.hub.home).requests.find((q) => q.status === 'open' && !q.own);
    if (head) await this.offer(ab, chatId, head);
  }

  private mintId(record: RoomFile): string {
    for (;;) {
      const id = requestIdFrom(randomBytes(10));
      if (!record.requests.some((q) => q.id === id)) return id;
    }
  }

  /** The owner's private card: every stored word, split over messages when long, the buttons on the last. */
  private async sendCard(ab: ActiveBinding, chatId: number, req: RoomRequest): Promise<void> {
    const { messages } = roomCard(req, this.titleOf(ab, chatId) ?? '');
    for (const m of messages.slice(0, -1)) await this.hub.send(ab, m);
    const recId = await this.hub.sendButtons(ab, messages[messages.length - 1], [['Onayla', 'Reddet']], { kind: 'room-request', requestId: req.id, singleUse: true }, { chatId });
    const mid = this.hub.buttonMessageId(recId);
    const record = readRoom(ab.scope, ab.target, chatId, this.hub.home);
    const q = record.requests.find((x) => x.id === req.id);
    if (q && mid !== null) { q.cardMessageId = mid; writeRoom(ab.scope, ab.target, record, this.hub.home); }
  }

  /** The next held request of a room becomes open and its card goes (D9). */
  private async promoteHeld(ab: ActiveBinding, chatId: number): Promise<void> {
    if (!this.live(ab, chatId)) return;
    const record = readRoom(ab.scope, ab.target, chatId, this.hub.home);
    if (record.requests.some((q) => q.status === 'open' && !q.own)) return;
    const next = record.requests.find((q) => q.status === 'held');
    if (!next) return;
    next.status = 'open';
    writeRoom(ab.scope, ab.target, record, this.hub.home);
    await this.offer(ab, chatId, next);
  }

  /**
   * Onayla / Reddet on a room request's card (G7). Reached only past the hub's presser check (G3):
   * the owner pressed it, in his private chat, on the message the record was bound to. A request
   * that is not open, or whose group is no longer permitted, injects nothing.
   */
  async onButton(ab: ActiveBinding, rec: ButtonRecord & { data?: Obj }, idx: number): Promise<string | null> {
    const chatId = Number(rec.data?.chatId);
    if (!Number.isSafeInteger(chatId) || chatId >= 0 || !rec.requestId) return ROOM_LINES.cardStale;
    if (!this.live(ab, chatId)) return ROOM_LINES.cardStale;
    const id = rec.requestId;
    // The press used the card up: from here until its answer is written (or delivered) it is in
    // flight, so no re-offer can send a second card for it meanwhile.
    if (this.inFlight.has(id)) return ROOM_LINES.cardStale;
    this.inFlight.add(id);
    let delivering = false;
    try {
      const owner = await this.hub.ownerNameOf(ab);
      const record = readRoom(ab.scope, ab.target, chatId, this.hub.home);
      const req = record.requests.find((q) => q.id === id);
      if (!req || req.status !== 'open') return ROOM_LINES.cardStale;
      const title = this.titleOf(ab, chatId) ?? '';
      if (idx === 1) {
        req.status = 'refused';
        req.words = '';
        writeRoom(ab.scope, ab.target, record, this.hub.home);
        this.inFlight.delete(id);
        await this.line(ab, chatId, ROOM_LINES.refused(owner));
        await this.promoteHeld(ab, chatId);
        return '✗ Reddedildi';
      }
      if (idx !== 0) return ROOM_LINES.cardStale;
      // In this binding's order, off the poll loop: the Super may have to be woken first.
      delivering = true;
      ab.chain = ab.chain.then(() => this.deliver(ab, chatId, id, title, owner))
        .catch(() => { /* one failed link never stops the next */ })
        .finally(() => this.inFlight.delete(id));
      return '✓ Onaylandı, iletiliyor';
    } finally {
      if (!delivering) this.inFlight.delete(id);
    }
  }

  private async deliver(ab: ActiveBinding, chatId: number, requestId: string, title: string, owner: string): Promise<void> {
    const record = readRoom(ab.scope, ab.target, chatId, this.hub.home);
    const req = record.requests.find((q) => q.id === requestId);
    if (!req || req.status !== 'open' || !this.live(ab, chatId)) return;
    if (!consentable(req, title)) {
      req.status = 'refused'; req.words = ''; writeRoom(ab.scope, ab.target, record, this.hub.home);
      await this.line(ab, chatId, ROOM_LINES.unshowable);
      this.inFlight.delete(requestId);
      await this.promoteHeld(ab, chatId);
      return;
    }
    const session = await this.hub.sessionOfBound(ab);
    const text = approvedTurnText({ group: title, author: req.authorLabel, owner, requestId: req.id, words: req.words, summary: req.summary, own: req.own === true });
    const ok = session ? await this.hub.injectText(ab, this.hub.syntheticUpdateId(), text, session, { kind: 'room-request', requestId: req.id }) : false;
    const now = readRoom(ab.scope, ab.target, chatId, this.hub.home);
    const cur = now.requests.find((q) => q.id === requestId);
    if (!cur || cur.status !== 'open') return;
    if (!ok && cur.own) {
      // His own request never becomes a card for him: it is dropped, and he writes again.
      cur.status = 'refused'; cur.words = '';
      writeRoom(ab.scope, ab.target, now, this.hub.home);
      await this.line(ab, chatId, ROOM_LINES.ownNotDelivered);
      return;
    }
    if (!ok) {
      // D7's failure path: the request stays open, its card is offered again, the group is told.
      await this.line(ab, chatId, ROOM_LINES.notDelivered);
      this.inFlight.delete(requestId);
      if (this.live(ab, chatId)) await this.offer(ab, chatId, cur);
      return;
    }
    cur.status = 'approved';
    writeRoom(ab.scope, ab.target, now, this.hub.home);
    await this.line(ab, chatId, cur.own ? ROOM_LINES.started : ROOM_LINES.approved(owner));
    this.inFlight.delete(requestId);
    // Answered: the next waiting request is asked now (D9), never left behind a later one.
    await this.promoteHeld(ab, chatId);
  }

  /**
   * `super room say <requestId> "<text>"` (G8): the approved request's own Super posts its result to
   * the request's group, once. Refused for any other Super, a request not approved (open, held,
   * refused) or already said (done), and a group no longer permitted. Echoed to the owner privately.
   */
  async say(caller: { root: string; superId: SuperId }, requestId: string, text: string, filePaths: readonly string[] = []): Promise<RoomSayResult> {
    const clean = stripHidden(text).trim();
    if (!/^[a-z0-9]{10}$/.test(requestId)) return { ok: false, status: 404, error: 'unknown_request', message: 'no such group request' };
    if (!clean && !filePaths.length) return { ok: false, status: 400, error: 'invalid_args', message: 'write what the group should read' };
    for (const ab of this.hub.active.values()) {
      const sup = this.hub.superOf(ab);
      if (!sup || resolve(sup.root) !== resolve(caller.root) || ab.disabled) continue;
      for (const g of ab.binding.groups ?? []) {
        const record = readRoom(ab.scope, ab.target, g.chatId, this.hub.home);
        const req = record.requests.find((q) => q.id === requestId);
        if (!req) continue;
        if (req.superId !== caller.superId) return { ok: false, status: 403, error: 'not_your_request', message: 'this group request went to another Super' };
        if (req.status === 'done' || this.saying.has(requestId)) return { ok: false, status: 409, error: 'already_said', message: 'the result of this request is already in the group' };
        if (req.status !== 'approved') return { ok: false, status: 409, error: 'not_approved', message: 'the owner has not approved this request' };
        if (!this.live(ab, g.chatId)) return { ok: false, status: 410, error: 'group_gone', message: 'that group is no longer connected' };
        const root = this.hub.rootOf(ab) ?? caller.root;
        const brainReal = (this.deps.brain ?? quickBrainRoot)(root) ?? root;
        const paths = this.privatePaths(root, brainReal);
        // Pictures written into the text (`![name](path)`) go as files, as in his private chat.
        const pics = picturesOfSay(clean);
        const mediaRoots = await Promise.resolve((this.deps.fileRoots ?? ((r: string) => superMediaRoots(r, this.hub.home)))(root)).catch(() => [] as string[]);
        const files = readRoomFiles([...filePaths, ...pics.paths.filter((x) => !filePaths.includes(x))], {
          projectRoot: dirname(root), mediaRoots, brain: brainReal, ...(this.deps.isGitIgnored ? { isGitIgnored: this.deps.isGitIgnored } : {}),
        });
        if (!files.ok) return { ok: false, status: 400, error: 'bad_file', message: files.message };
        // Its spoken summary (a `dream-voice` block, as in his private chat) goes as a voice.
        const { text: rest, voice } = voiceAnswer(pics.text);
        const say = redactPaths(rest, paths).trim();
        const spoken = voice ? { title: redactSecrets(redactPaths(voice.title, paths)).trim(), text: redactSecrets(redactPaths(voice.text, paths)).trim() } : null;
        if (!say && !spoken?.text && !files.files.length) return { ok: false, status: 400, error: 'invalid_args', message: 'nothing left to post once private details are out' };
        this.saying.add(requestId);
        // What Telegram took, part by part: the owner's copy names only these, and a part it did
        // not take keeps the request open for a say of just that part.
        const landed: string[] = [];
        const notSent: string[] = [];
        try {
          if (say) {
            if (await this.sendLong(ab, g.chatId, say)) landed.push(say);
            else notSent.push('text');
          }
          if (spoken?.text) {
            const how = await this.speakTo(ab, g.chatId, spoken);
            if (how) landed.push(`${how === 'voice' ? '🔊' : '🔊✎'} ${spoken.text}`);
            else notSent.push('voice');
          }
          for (const f of files.files) {
            if (await this.hub.sendRoom(ab, g.chatId, 'room-file', '', { kind: 'file', file: f.file, photo: f.photo })) landed.push(`📎 ${f.file.name}`);
            else notSent.push(f.file.name);
          }
          // Done only once every part landed; a part refused leaves it approved, to say that part again.
          if (landed.length && !notSent.length) {
            const now = readRoom(ab.scope, ab.target, g.chatId, this.hub.home);
            const cur = now.requests.find((q) => q.id === requestId);
            if (cur) { cur.status = 'done'; cur.words = ''; writeRoom(ab.scope, ab.target, now, this.hub.home); }
          }
        } finally { this.saying.delete(requestId); }
        if (!landed.length) return { ok: false, status: 502, error: 'not_sent', message: 'Telegram did not confirm the message; say it again' };
        // His copy: what did not go FIRST (never lost to a cut), then what landed, quoted as far as
        // one message holds (the group has the whole of it).
        const head = [escapeHtml(ROOM_LINES.sayEcho(g.title)), ...(notSent.length ? [`<b>${escapeHtml(ROOM_LINES.notSentEcho(notSent.join(', ')))}</b>`] : [])].join('\n');
        const quote = splitEscaped(landed.join('\n\n'), 3800 - head.length);
        await this.hub.send(ab, `${head}\n<blockquote>${quote[0] ?? ''}${quote.length > 1 ? '…' : ''}</blockquote>`).catch(() => undefined);
        if (!notSent.length) await this.promoteHeld(ab, g.chatId);
        return { ok: true, group: g.title, ...(notSent.length ? { notSent } : {}) };
      }
    }
    return { ok: false, status: 404, error: 'unknown_request', message: 'no such group request' };
  }

  /** A result's text into the group, as many messages as it needs; true only when every one landed. */
  private async sendLong(ab: ActiveBinding, chatId: number, text: string): Promise<boolean> {
    for (const piece of splitEscaped(text)) if (!await this.hub.sendRoom(ab, chatId, 'room-say', piece)) return false;
    return true;
  }

  /**
   * A result's spoken summary into the group: made by the Mac's voice (the same one his private
   * chat hears), sent as a voice message. Anything that stops the voice sends its words as text
   * instead, and the owner hears why privately: a voice asked for never ends in silence.
   */
  private async speakTo(ab: ActiveBinding, chatId: number, v: { title: string; text: string }): Promise<'voice' | 'text' | false> {
    void this.hub.sendRoom(ab, chatId, 'room-typing', 'record_voice');
    let r: SpeakSummaryResult;
    try {
      const speak = this.deps.speak ?? this.hub.deps.speakSummary ?? ((t: string) => speakSummary(t, { home: this.hub.home, signal: AbortSignal.timeout(VOICE_DEADLINE_MS) }));
      r = await speak(v.text);
    } catch { r = { ok: false, reason: 'failed' }; }
    if (r.ok && await this.hub.sendRoom(ab, chatId, 'room-voice', voiceCaptionHtml(v.title), { kind: 'voice', file: { name: 'ozet.ogg', data: r.ogg, contentType: 'audio/ogg' }, seconds: r.seconds })) return 'voice';
    const asText = await this.sendLong(ab, chatId, v.title ? `${v.title}\n${v.text}` : v.text);
    if (!asText) return false;
    // Told only when its words truly went as text (a refused text is a part not sent).
    if (r.ok || r.reason !== 'nothing_speakable') await this.hub.notice(ab, 'warn', ROOM_LINES.voiceAsText(this.titleOf(ab, chatId) ?? '')).catch(() => undefined);
    return 'text';
  }

  /** A group stops (unbound, kicked, "Gruptan çıkar"): its running turn is killed, waiting
   *  messages and requests dropped, its record and folders removed. */
  stop(ab: ActiveBinding, chatId: number): void {
    const st = this.rooms.get(this.keyOf(ab, chatId));
    if (st) {
      st.stopped = true;
      st.pending = [];
      if (st.child) this.killChild(st.child);
      if (!st.running) this.rooms.delete(this.keyOf(ab, chatId));
    }
    try { removeRoom(ab.scope, ab.target, chatId, this.hub.home); } catch { /* gone */ }
  }

  /** Pending requests of a room (tests, the stop line). */
  openRequests(ab: ActiveBinding, chatId: number): RoomRequest[] {
    return readRoom(ab.scope, ab.target, chatId, this.hub.home).requests.filter((q) => q.status === 'open' || q.status === 'held' || q.status === 'approved');
  }
}

export function wireTelegramRooms(hub: TelegramHub, deps: RoomDeps = {}): RoomRunner {
  const runner = new RoomRunner(hub, deps);
  hub.rooms = runner;
  return runner;
}
