/**
 * A permitted Telegram group's room agent (tg-grup C3, C5, D5-D10).
 *
 * Every addressed message of a permitted group, the owner's included, becomes a turn of THAT room's
 * agent: one `claude -p` in the room envelope ({@link roomAgentArgs}), started in the room's EMPTY
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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
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
import { quickReadable } from '../../lib/whiteboards/quick-readable.js';
import { resultLine } from '../../lib/whiteboards/quick-edit.js';
import { readRoom, removeRoom, roomDirs, writeRoom, type RoomFile, type RoomRequest } from '../../lib/telegram/config.js';
import { escapeHtml } from '../../lib/telegram/format.js';
import { ROOM_SCHEMA, readRoomAnswer, roomSystemPrompt, roomUserMessage, type RoomAnswer } from '../../lib/telegram/room-prompt.js';
import {
  ROOM_LINES, approvedTurnText, asShown, authorLabel, batchWords, consentable, foldBatch, redactPaths, requestIdFrom, roomCard, stripHidden, type RoomLine,
} from '../../lib/telegram/rooms.js';
import type { ButtonRecord } from '../../lib/telegram/contract.js';
import { identityFor } from './identity.js';
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
    ...(o.resume ? ['--resume', o.resume] : []),
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
}

type VoiceNote = { file_id?: string; file_size?: number; duration?: number };
/** A waiting message: its text, or a voice note heard in the drain, in arrival order. */
type Pending = RoomLine | { authorId: number; author: string; voice: VoiceNote };

interface RoomState {
  pending: Pending[];
  running: boolean;
  child: ChildProcess | null;
  stopped: boolean;
}

/** Owner-facing results of `room say`. */
export type RoomSayResult = { ok: true; group: string } | { ok: false; status: number; error: string; message: string };

export class RoomRunner {
  private rooms = new Map<string, RoomState>();
  /** Request ids whose `room say` is being sent now: a second say waits for the first's outcome. */
  private saying = new Set<string>();
  /** Request ids being offered or delivered right now: their card is on its way, or the owner
   *  pressed Onayla and the turn is being delivered. Such a request already has its answer path. */
  private inFlight = new Set<string>();
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
    // A member's voice note (a reply to the bot) is heard into the turn (D4); never kept anywhere.
    const voice = msg.voice as VoiceNote | undefined;
    if (!text.trim() && voice?.file_id) { this.queue(ab, chatId, { authorId: from.id, author: authorLabel(from), voice }); return; }
    if (!text.trim()) return;
    this.queue(ab, chatId, { authorId: from.id, author: authorLabel(from), text: text.trim() });
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
      const user = roomUserMessage(batch, memory, randomBytes(6).toString('hex'));
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
      if (say) await this.hub.sendRoom(ab, chatId, 'room-say', escapeHtml(say));
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
    // D9: a request waits behind every one not yet answered (open or held), in order.
    const held = record.requests.some((q) => q.status === 'open' || q.status === 'held');
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
    record.requests = [...record.requests.filter((q) => q.status !== 'done' && q.status !== 'refused'), req];
    writeRoom(ab.scope, ab.target, record, this.hub.home);
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
    const head = readRoom(ab.scope, ab.target, chatId, this.hub.home).requests.find((q) => q.status === 'open');
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
    if (record.requests.some((q) => q.status === 'open')) return;
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
    const text = approvedTurnText({ group: title, author: req.authorLabel, owner, requestId: req.id, words: req.words, summary: req.summary });
    const ok = session ? await this.hub.injectText(ab, this.hub.syntheticUpdateId(), text, session, { kind: 'room-request', requestId: req.id }) : false;
    const now = readRoom(ab.scope, ab.target, chatId, this.hub.home);
    const cur = now.requests.find((q) => q.id === requestId);
    if (!cur || cur.status !== 'open') return;
    if (!ok) {
      // D7's failure path: the request stays open, its card is offered again, the group is told.
      await this.line(ab, chatId, ROOM_LINES.notDelivered);
      this.inFlight.delete(requestId);
      if (this.live(ab, chatId)) await this.offer(ab, chatId, cur);
      return;
    }
    cur.status = 'approved';
    writeRoom(ab.scope, ab.target, now, this.hub.home);
    await this.line(ab, chatId, ROOM_LINES.approved(owner));
    this.inFlight.delete(requestId);
    // Answered: the next waiting request is asked now (D9), never left behind a later one.
    await this.promoteHeld(ab, chatId);
  }

  /**
   * `super room say <requestId> "<text>"` (G8): the approved request's own Super posts its result to
   * the request's group, once. Refused for any other Super, a request not approved (open, held,
   * refused) or already said (done), and a group no longer permitted. Echoed to the owner privately.
   */
  async say(caller: { root: string; superId: SuperId }, requestId: string, text: string): Promise<RoomSayResult> {
    const clean = stripHidden(text).trim();
    if (!/^[a-z0-9]{10}$/.test(requestId)) return { ok: false, status: 404, error: 'unknown_request', message: 'no such group request' };
    if (!clean) return { ok: false, status: 400, error: 'invalid_args', message: 'write what the group should read' };
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
        const say = redactPaths(clean, this.privatePaths(root, brainReal)).slice(0, 3500);
        this.saying.add(requestId);
        let sent: boolean;
        try {
          sent = await this.hub.sendRoom(ab, g.chatId, 'room-say', escapeHtml(say));
          // Done only once Telegram took it: a refused send leaves it approved, to be said again.
          if (sent) {
            const now = readRoom(ab.scope, ab.target, g.chatId, this.hub.home);
            const cur = now.requests.find((q) => q.id === requestId);
            if (cur) { cur.status = 'done'; cur.words = ''; writeRoom(ab.scope, ab.target, now, this.hub.home); }
          }
        } finally { this.saying.delete(requestId); }
        if (!sent) return { ok: false, status: 502, error: 'not_sent', message: 'Telegram did not confirm the message; say it again' };
        await this.hub.send(ab, `${escapeHtml(ROOM_LINES.sayEcho(g.title))}\n<blockquote>${escapeHtml(say)}</blockquote>`).catch(() => undefined);
        await this.promoteHeld(ab, g.chatId);
        return { ok: true, group: g.title };
      }
    }
    return { ok: false, status: 404, error: 'unknown_request', message: 'no such group request' };
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
