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
 * Local only, under `~/.dreamcontext/logs/`, never uploaded. The audio is kept for the last
 * {@link KEEP_TAKES} takes so a bad transcript can be replayed through whisper by hand, the same
 * comparison that found the mid-word join bug; older ones are deleted as new ones arrive.
 *
 * Every write is best-effort: a full disk or a permission problem must never cost a take.
 */

import { appendFileSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** How many takes keep their audio. */
export const KEEP_TAKES = 12;
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
  return out;
}

/** Keep this take's audio and transcript, and delete all but the newest {@link KEEP_TAKES}. */
export function keepTake(wav: Buffer, record: Record<string, unknown>, home?: string): string | null {
  try {
    const dir = join(voiceLogDir(home), 'voice-takes');
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    writeFileSync(join(dir, `${stamp}.wav`), wav);
    writeFileSync(join(dir, `${stamp}.json`), JSON.stringify(record, null, 2));
    const stamps = [...new Set(readdirSync(dir).map((f) => f.replace(/\.(wav|json)$/, '')))].sort();
    for (const old of stamps.slice(0, Math.max(0, stamps.length - KEEP_TAKES))) {
      rmSync(join(dir, `${old}.wav`), { force: true });
      rmSync(join(dir, `${old}.json`), { force: true });
    }
    return stamp;
  } catch {
    return null;
  }
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
