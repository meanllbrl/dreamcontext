/**
 * The voice path's own record: one JSON line per take and per spoken chunk, and the last few
 * takes' audio beside it.
 *
 * ── WHY IT EXISTS ───────────────────────────────────────────────────────────────────────
 * The desktop app starts its server with stdout and stderr on /dev/null, so every
 * `console.info('[voice:stt] …')` this route ever wrote went nowhere. When the owner reported
 * lost first words, bad recognition and skipped sentences (2026-10-13) there was no record of
 * a single take or chunk to check the reports against. These lines are that record: how long
 * after the press the first sample landed, how much audio was captured against how long the
 * take lasted (a page that drops frames shows up as the gap), what the engine answered, and
 * for speech, which chunks were spoken, rescued or dropped and why.
 *
 * Local only, under `~/.dreamcontext/logs/`, never uploaded. Each take's audio is kept for
 * {@link TAKE_TTL_MS} (at most {@link TAKE_MAX_BYTES} in all) so a bad transcript can be replayed
 * through whisper — by hand, as when the mid-word join bug was found, or by the chat's own agent
 * (`dreamcontext voice retry`, which is why a take now has a ref and an owner).
 *
 * Every write is best-effort: a full disk or a permission problem must never cost a take.
 */

import {
  appendFileSync, chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { normalizeLanguage, type ContextTake } from './languageContext.js';

/** How long a take keeps its audio (owner, 2026-10-24: "24 saat"). */
export const TAKE_TTL_MS = 24 * 60 * 60 * 1000;
/** The take store's ceiling; the oldest go first past it. */
export const TAKE_MAX_BYTES = 200 * 1024 * 1024;
/** The log is rotated past this size (one `.1` generation). */
const MAX_LOG_BYTES = 2 * 1024 * 1024;

export function voiceLogDir(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'logs');
}

/** Append one event. */
export function logVoiceEvent(event: Record<string, unknown>, home?: string): void {
  try {
    const dir = voiceLogDir(home);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'voice.jsonl');
    try {
      if (statSync(file).size > MAX_LOG_BYTES) renameSync(file, `${file}.1`);
    } catch { /* no log yet */ }
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
  } catch { /* best-effort */ }
}

/**
 * The capture facts the page sends with a take (`X-Dreamcontext-Take`), reduced to the known
 * numeric fields. The header is the page's own claim and is only ever logged, so anything
 * unexpected is dropped rather than trusted.
 */
export function parseTakeMeta(raw: string | string[] | undefined): Record<string, unknown> {
  const text = Array.isArray(raw) ? raw[0] : raw;
  if (!text || text.length > 600) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return {}; }
  if (!parsed || typeof parsed !== 'object') return {};
  const p = parsed as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (p.source === 'native' || p.source === 'webkit') out.source = p.source;
  for (const k of ['rate', 'firstSampleMs', 'capturedMs', 'wallMs', 'attempt']) {
    const v = p[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e9) out[k] = Math.round(v);
  }
  // The conversation it was dictated into (selects the language context, never access) and
  // the page's UI language (one more context signal).
  if (typeof p.conv === 'string' && CONV_RE.test(p.conv)) out.conv = p.conv;
  const ui = normalizeLanguage(p.ui);
  if (ui) out.ui = ui;
  return out;
}

const CONV_RE = /^[\w-]{1,64}$/;

// ─── The take store ──────────────────────────────────────────────────────────────────────
//
// A take is `<ref>.wav` + `<ref>.json`, the ref `vt_` + 128 random bits: no collisions, no
// guessing. Its record carries ONLY what the server itself determined about it — the vault
// it was dictated into (`contextRoot`), when, its language and quality — so the chat that
// later binds it and the agent that asks to retranscribe it are checked against facts, never
// against anything a page said. The directory is 0700 and the files 0600: it is the owner's
// voice.

export const TAKE_REF_RE = /^vt_[0-9a-f]{32}$/;
export const TAKE_QUALITIES = ['clean', 'suspect', 'garbled'] as const;
export type TakeQuality = typeof TAKE_QUALITIES[number];

/** What a stored take says about itself, re-validated on every read. */
export interface TakeRecord {
  ref: string;
  contextRoot: string;
  createdAt: number;
  language: string | null;
  /** The context's primary when it was taken: the default language of a retranscribe. */
  primary: string | null;
  quality: TakeQuality;
  passes: number;
  conv?: string;
  chars: number;
  /** The chat (registry id) that sent it as a message; set once. */
  session?: string;
}

export function takesDir(home?: string): string {
  return join(voiceLogDir(home), 'voice-takes');
}

/** The store's directory, created and forced to 0700 (an existing 0755 one too). */
function ensureTakesDir(home?: string): string {
  const dir = takesDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

/** Re-validate a stored record: a hand-edited or old-format file is no take. */
function readRecord(dir: string, ref: string): TakeRecord | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, `${ref}.json`), 'utf-8')) as Record<string, unknown>;
    if (typeof raw.contextRoot !== 'string' || !raw.contextRoot) return null;
    if (typeof raw.createdAt !== 'number' || !Number.isFinite(raw.createdAt)) return null;
    const quality = (TAKE_QUALITIES as readonly unknown[]).includes(raw.quality) ? raw.quality as TakeQuality : null;
    if (!quality) return null;
    return {
      ref,
      contextRoot: raw.contextRoot,
      createdAt: raw.createdAt,
      language: normalizeLanguage(raw.language),
      primary: normalizeLanguage(raw.primary),
      quality,
      passes: typeof raw.passes === 'number' && raw.passes >= 1 && raw.passes <= 2 ? raw.passes : 1,
      ...(typeof raw.conv === 'string' && CONV_RE.test(raw.conv) ? { conv: raw.conv } : {}),
      chars: typeof raw.chars === 'number' && raw.chars >= 0 ? raw.chars : 0,
      ...(typeof raw.session === 'string' && raw.session ? { session: raw.session } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Delete takes older than {@link TAKE_TTL_MS}, then the oldest while the store is over
 * {@link TAKE_MAX_BYTES}. Age is the file's mtime, so an old-format take (a timestamp name, no
 * ref) ages out the same way. Runs on every write and at server start; best-effort.
 */
export function pruneTakes(home?: string, now: number = Date.now(), maxBytes: number = TAKE_MAX_BYTES): void {
  try {
    const dir = takesDir(home);
    const groups = new Map<string, { mtime: number; size: number }>();
    for (const f of readdirSync(dir)) {
      const base = f.replace(/\.(wav|json)$/, '');
      let st;
      try { st = statSync(join(dir, f)); } catch { continue; }
      const g = groups.get(base) ?? { mtime: 0, size: 0 };
      g.mtime = Math.max(g.mtime, st.mtimeMs);
      g.size += st.size;
      groups.set(base, g);
    }
    const drop = (base: string) => {
      rmSync(join(dir, `${base}.wav`), { force: true });
      rmSync(join(dir, `${base}.json`), { force: true });
      groups.delete(base);
    };
    for (const [base, g] of [...groups]) if (now - g.mtime > TAKE_TTL_MS) drop(base);
    const oldestFirst = [...groups].sort((a, b) => a[1].mtime - b[1].mtime);
    let total = oldestFirst.reduce((n, [, g]) => n + g.size, 0);
    for (const [base, g] of oldestFirst) {
      if (total <= maxBytes) break;
      drop(base);
      total -= g.size;
    }
  } catch { /* no store yet */ }
}

/**
 * Keep this take's audio and record; returns its ref, or null when it could not be written.
 * `record` is logged as given; the trusted fields (`contextRoot`, `createdAt`, `language`,
 * `quality`, `passes`, `conv`) are set by the caller from what the server determined.
 */
export function keepTake(
  wav: Buffer,
  record: Record<string, unknown> & { contextRoot: string; quality: TakeQuality },
  home?: string,
  now: number = Date.now(),
): string | null {
  try {
    const dir = ensureTakesDir(home);
    const ref = `vt_${randomBytes(16).toString('hex')}`;
    const conv = typeof record.conv === 'string' && CONV_RE.test(record.conv) ? record.conv : undefined;
    const stored = {
      ...record,
      conv,
      language: normalizeLanguage(record.language),
      primary: normalizeLanguage(record.primary),
      createdAt: now,
    };
    writeFileSync(join(dir, `${ref}.wav`), wav, { mode: 0o600 });
    writeFileSync(join(dir, `${ref}.json`), JSON.stringify(stored, null, 2), { mode: 0o600 });
    pruneTakes(home, now);
    return ref;
  } catch {
    return null;
  }
}

/** A take by ref, with its audio path; null for a malformed ref (no path is joined), an
 *  unknown or expired one. */
export function findTake(ref: unknown, home?: string, now: number = Date.now()): (TakeRecord & { wavPath: string }) | null {
  if (typeof ref !== 'string' || !TAKE_REF_RE.test(ref)) return null;
  const dir = takesDir(home);
  const rec = readRecord(dir, ref);
  if (!rec || now - rec.createdAt > TAKE_TTL_MS) return null;
  return { ...rec, wavPath: join(dir, `${ref}.wav`) };
}

/** How long after a take a message may still claim it. */
export const BIND_WINDOW_MS = 10 * 60 * 1000;

/**
 * Bind a take to the chat that sent it as a message — once, from the same vault, within
 * {@link BIND_WINDOW_MS}. The check and the write are one synchronous step (no await), so two
 * frames carrying one ref cannot both bind. Returns the record, or null (the ref is dropped).
 */
export function bindTake(
  ref: unknown,
  session: string,
  contextRoot: string,
  home?: string,
  now: number = Date.now(),
  sentText?: string,
): TakeRecord | null {
  const take = findTake(ref, home, now);
  if (!take || !session || take.session || take.contextRoot !== contextRoot) return null;
  if (now - take.createdAt > BIND_WINDOW_MS || take.quality === 'garbled') return null;
  try {
    const file = join(takesDir(home), `${take.ref}.json`);
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
    // "Sent unchanged" is checked here too, not only by the page: the message must still hold
    // the words that were heard (a quote or an attachment block may surround them).
    if (sentText !== undefined && !(typeof raw.text === 'string' && raw.text.trim() && sentText.includes(raw.text.trim()))) return null;
    writeFileSync(file, JSON.stringify({ ...raw, session }, null, 2), { mode: 0o600 });
  } catch {
    return null;
  }
  const { wavPath: _wav, ...rec } = take;
  return { ...rec, session };
}

/**
 * The block an agent sees beside a dictated owner message: `<voice-take ref lang quality/>`.
 * Built ONLY from a bound, stored record, re-validated here, so no frame field and no
 * transcript text can reach an attribute. Starts with `<`, so the transcript replay drops it
 * and the owner's bubble shows his words alone.
 */
export function voiceTakeBlock(take: Pick<TakeRecord, 'ref' | 'language' | 'quality'>): string | null {
  if (!TAKE_REF_RE.test(take.ref)) return null;
  const lang = normalizeLanguage(take.language) ?? 'unknown';
  const quality = take.quality === 'clean' || take.quality === 'suspect' ? take.quality : null;
  if (!quality) return null;
  return `<voice-take ref="${take.ref}" lang="${lang}" quality="${quality}"/>`;
}

/** Every take in the store, newest first (re-validated; unreadable ones skipped). */
export function listTakes(home?: string, now: number = Date.now()): TakeRecord[] {
  try {
    const dir = takesDir(home);
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json') && TAKE_REF_RE.test(f.slice(0, -5)))
      .map((f) => readRecord(dir, f.slice(0, -5)))
      .filter((r): r is TakeRecord => !!r && now - r.createdAt <= TAKE_TTL_MS)
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

/** The newest take bound to `session` in `contextRoot`, or null. */
export function latestTakeOf(session: string, contextRoot: string, home?: string, now?: number): TakeRecord | null {
  return listTakes(home, now).find((t) => t.session === session && t.contextRoot === contextRoot) ?? null;
}

/** The recent takes as language-context input (newest first). */
export function contextTakes(home?: string, now?: number): ContextTake[] {
  return listTakes(home, now).slice(0, 50).map((t) => ({
    language: t.language, quality: t.quality, conv: t.conv, createdAt: t.createdAt, chars: t.chars,
  }));
}

const SPEECH_OUTCOMES = new Set(['played', 'skipped', 'cut']);
/** Every reason the page's queue gives (dashboard/src/lib/voice/speechQueue.ts). */
const SPEECH_REASONS = new Set([
  'nothing-speakable', 'busy', 'failed', 'refused', 'aborted', 'phone', 'speech-off',
  'barge-in', 'stopped', 'steer', 'closed', 'speaker-busy', 'talked-over',
]);
const SPEECH_SURFACES = new Set(['assistant', 'super']);

/**
 * One spoken chunk's fate from the page's speech queue — `played`, `skipped` (never reached the
 * speaker) or `cut` (a stop took it away) — the record that answers "it skipped a sentence"
 * (owner, 2026-10-21) chunk by chunk. Like the other page records it is the page's own claim,
 * rebuilt field by field: an unknown outcome is no record, an unknown reason is dropped, and
 * the chunk's opening words are kept short and on one line.
 */
export function parseSpeechReport(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (b.kind !== 'speech' || typeof b.outcome !== 'string' || !SPEECH_OUTCOMES.has(b.outcome)) return null;
  const out: Record<string, unknown> = { kind: 'speech', outcome: b.outcome };
  if (typeof b.surface === 'string' && SPEECH_SURFACES.has(b.surface)) out.surface = b.surface;
  if (typeof b.id === 'string' && /^[\w-]{1,48}$/.test(b.id)) out.id = b.id;
  if (typeof b.reason === 'string' && SPEECH_REASONS.has(b.reason)) out.reason = b.reason;
  const chars = count(b.chars, 100_000);
  if (chars !== undefined) out.chars = chars;
  if (typeof b.heard === 'boolean') out.heard = b.heard;
  if (typeof b.head === 'string') {
    // eslint-disable-next-line no-control-regex
    const head = b.head.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 80);
    if (head) out.head = head;
  }
  return out;
}

const TURN_STAGES = ['stt', 'sent', 'firstToken', 'firstText', 'ttsAsked', 'ttsReady', 'audio', 'end'] as const;
const TURN_OUTCOMES = new Set(['answered', 'silent', 'stt_failed', 'no_audio', 'abandoned', 'superseded']);
/** A stage later than this is not a stage of one turn (the page's tracer gives up at 180 s). */
const MAX_STAGE_MS = 600_000;

function count(v: unknown, max: number): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? Math.round(v) : undefined;
}

/**
 * A voice turn's timing from the page (`dashboard/src/lib/voice/turnTrace.ts`), reduced to the
 * known fields. Like {@link parseTakeMeta} it is the page's own claim and only ever logged, so
 * it is rebuilt field by field: an unknown outcome is no record, an absent or out-of-range
 * stage stays absent, and the model is kept only when it looks like a model id.
 */
export function parseTurnTrace(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (b.kind !== 'turn' || typeof b.outcome !== 'string' || !TURN_OUTCOMES.has(b.outcome)) return null;
  const out: Record<string, unknown> = { kind: 'turn', outcome: b.outcome };
  const stages = b.stages && typeof b.stages === 'object' ? b.stages as Record<string, unknown> : {};
  for (const k of TURN_STAGES) {
    const v = count(stages[k], MAX_STAGE_MS);
    if (v !== undefined) out[`${k}Ms`] = v;
  }
  const u = b.usage && typeof b.usage === 'object' ? b.usage as Record<string, unknown> : null;
  if (u) {
    for (const k of ['input', 'cacheRead', 'cacheCreation'] as const) {
      const v = count(u[k], 10_000_000);
      if (v !== undefined) out[k] = v;
    }
    if (typeof u.model === 'string' && /^[\w.\-[\]]{1,64}$/.test(u.model)) out.model = u.model;
  }
  const tools = count(b.toolsBeforeText, 1000);
  if (tools !== undefined) out.toolsBeforeText = tools;
  const attempts = count(b.sttAttempts, 10);
  if (attempts !== undefined) out.sttAttempts = attempts;
  return out;
}
