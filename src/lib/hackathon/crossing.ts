/**
 * The ONLY owner-side reader of a team's `out/` and `repo/` (plan C4 helpers table). Team output
 * is bytes: every read is `lstat` + `realpath` contained, a symlink anywhere on the way is
 * refused, and every read is size-cut. The validated shapes come from `team-files.ts`.
 */
import { closeSync, constants as fsc, lstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { containedPath } from './run-store.js';
import {
  parseDecisions, validateAnswer, validateManifest, validateMedia, validateQuestion, validateShotRequest, validateThesis,
  type DecisionLine, type Manifest, type MediaType, type PeekQuestion, type ShotRequest, type ThesisCard, type Valid,
} from './team-files.js';

export const JSON_MAX_BYTES = 64 * 1024;
export const TEXT_PREVIEW_BYTES = 48 * 1024;
export const MEDIA_MAX_BYTES = 40 * 1024 * 1024;

export type ReadResult = { ok: true; bytes: Buffer; truncated: boolean } | { ok: false; reason: string };

/** Bytes of `rel` inside `root`, at most `max`; refused when outside, a link, or not a file. */
export function readContained(root: string, rel: string, max: number): ReadResult {
  const abs = containedPath(root, rel);
  if (!abs) return { ok: false, reason: 'yol ekip klasörünün dışında ya da bağlantı' };
  let fd: number | null = null;
  try {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) return { ok: false, reason: 'bağlantı (symlink) okunmaz' };
    if (!st.isFile()) return { ok: false, reason: 'dosya değil' };
    // O_NOFOLLOW: a link swapped in after the lstat is not followed.
    fd = openSync(abs, fsc.O_RDONLY | (fsc.O_NOFOLLOW ?? 0));
    const n = Math.min(st.size, max);
    const buf = Buffer.alloc(n);
    let got = 0;
    while (got < n) {
      const r = readSync(fd, buf, got, n - got, got);
      if (r <= 0) break;
      got += r;
    }
    return { ok: true, bytes: buf.subarray(0, got), truncated: st.size > max };
  } catch {
    return { ok: false, reason: 'okunamadı' };
  } finally {
    if (fd != null) try { closeSync(fd); } catch { /* closed */ }
  }
}

function readJsonFile(root: string, rel: string): Valid<unknown> {
  const r = readContained(root, rel, JSON_MAX_BYTES);
  if (!r.ok) return { ok: false, reason: r.reason };
  if (r.truncated) return { ok: false, reason: `${rel} çok büyük` };
  try {
    return { ok: true, value: JSON.parse(r.bytes.toString('utf-8')) };
  } catch {
    return { ok: false, reason: `${rel} JSON değil` };
  }
}

function then<T>(v: Valid<unknown>, f: (x: unknown) => Valid<T>): Valid<T> {
  return v.ok ? f(v.value) : v;
}

export const readThesis = (out: string, round: number): Valid<ThesisCard> => then(readJsonFile(out, `thesis-r${round}.json`), validateThesis);
export const readQuestion = (out: string, round: number): Valid<PeekQuestion> => then(readJsonFile(out, `question-r${round}.json`), validateQuestion);
export const readAnswer = (out: string, round: number): Valid<{ text: string }> => then(readJsonFile(out, `answer-r${round}.json`), validateAnswer);
export const readShotRequest = (out: string): Valid<ShotRequest> => then(readJsonFile(out, 'shot-request.json'), validateShotRequest);

export function readDecisions(out: string): { lines: DecisionLine[]; dropped: string[] } {
  const r = readContained(out, 'decisions.jsonl', 512 * 1024);
  if (!r.ok) return { lines: [], dropped: r.reason === 'okunamadı' ? [] : [r.reason] };
  return parseDecisions(r.bytes.toString('utf-8'));
}

export function readManifest(out: string): Valid<Manifest> & { flags?: string[] } {
  const raw = readJsonFile(out, 'presentation/manifest.json');
  if (!raw.ok) return raw;
  return validateManifest(raw.value, readDecisions(out).lines);
}

export function readMedia(out: string, rel: string): { ok: true; bytes: Buffer; type: MediaType } | { ok: false; reason: string } {
  const r = readContained(out, rel, MEDIA_MAX_BYTES);
  if (!r.ok) return r;
  if (r.truncated) return { ok: false, reason: 'medya çok büyük' };
  const v = validateMedia(rel, r.bytes);
  return v.ok ? { ok: true, bytes: r.bytes, type: v.value } : v;
}

/** A text preview of a file the team edited (the room's files frame). */
export function previewText(root: string, rel: string, maxLines = 40): { ok: true; lines: string[]; truncated: boolean } | { ok: false; reason: string } {
  const r = readContained(root, rel, TEXT_PREVIEW_BYTES);
  if (!r.ok) return r;
  if (r.bytes.includes(0)) return { ok: false, reason: 'ikili dosya' };
  const lines = r.bytes.toString('utf-8').split('\n');
  return { ok: true, lines: lines.slice(0, maxLines).map((l) => l.slice(0, 240)), truncated: r.truncated || lines.length > maxLines };
}

/** Names directly in a contained directory, links skipped (never followed). */
export function listContained(root: string, rel = '.'): string[] {
  const abs = containedPath(root, rel);
  if (!abs) return [];
  try {
    if (!lstatSync(abs).isDirectory()) return [];
    return readdirSync(abs).filter((n) => {
      try { return !lstatSync(join(abs, n)).isSymbolicLink(); } catch { return false; }
    });
  } catch {
    return [];
  }
}
