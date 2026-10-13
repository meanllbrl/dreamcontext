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
