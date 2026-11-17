/**
 * A team's presentation (plan Decision 11): the validated `presentation/manifest.json`, its last
 * thesis card, the conductor's screenshots and its media, drawn only through the stage's card
 * kinds. Also the plain text the blind jury reads (fenced as data by the jury).
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readDecisions, readManifest, readMedia, readShotRequest, readThesis } from './crossing.js';
import type { Design } from './designer.js';
import { conductorDir, teamWorkspace } from './run-store.js';
import { copyBuild, pdfFirstPage, shootBuild, shotsSupported } from './shots.js';
import type { Manifest, ThesisCard } from './team-files.js';

export interface PresentationCard { kind: Manifest['cards'][number]['kind']; title: string; media?: string; reason?: string; thesis?: ThesisCard }

export interface Presentation {
  team: string;
  cards: PresentationCard[];
  thesis: ThesisCard | null;
  borrowed: Manifest['borrowed'];
  flags: string[];
  /** Screenshots the conductor took (relative media names). */
  screens: { width: number; media: string }[];
  /** Why there is no manifest, when there is none. */
  reason?: string;
  decisions: number;
}

export function shotsDir(runId: string, team: string, wsHome?: string): string {
  return join(conductorDir(runId, wsHome), 'shots', team);
}

/** The team's last valid thesis card (newest round first). */
export function lastThesis(out: string, rounds: number): ThesisCard | null {
  for (let r = rounds; r >= 1; r--) {
    const t = readThesis(out, r);
    if (t.ok) return t.value;
  }
  return null;
}

/**
 * Take the team's screen evidence: build copy → sandboxed browser at 390 and 1440, and every
 * PDF card as a page image. Runs once at the presentation phase.
 */
export async function captureEvidence(runId: string, team: string, kind: Design['kind'], wsHome?: string): Promise<string[]> {
  const notes: string[] = [];
  const out = teamWorkspace(runId, team, wsHome).out;
  const dest = shotsDir(runId, team, wsHome);
  if (kind === 'screen' || existsSync(join(out, 'shot-request.json'))) {
    if (!shotsSupported()) notes.push('ekran kanıtı yok (yalnız macOS): kod ve test sunulur');
    else {
      const req = readShotRequest(out);
      if (!req.ok) notes.push(`ekran isteği geçersiz: ${req.reason}`);
      else {
        const copy = join(conductorDir(runId, wsHome), 'builds', team);
        const c = copyBuild(join(out, 'build'), copy);
        if (!c.ok) notes.push(c.reason);
        else {
          const res = await shootBuild({ buildCopy: copy, entry: req.value.entry, destDir: dest, widths: req.value.widths });
          for (const r of res) if (!r.file) notes.push(`${r.width} px: ${r.reason}`);
        }
      }
    }
  }
  const m = readManifest(out);
  if (m.ok) {
    for (const card of m.value.cards) {
      if (card.kind !== 'pdf' || !card.file) continue;
      const pdf = readMedia(out, card.file);
      if (!pdf.ok) { notes.push(`${card.file}: ${pdf.reason}`); continue; }
      const ok = await pdfFirstPage(pdf.bytes, join(dest, `${card.file.replace(/[^a-z0-9.-]/gi, '_')}.png`));
      if (!ok) notes.push(`${card.file}: sayfa görüntüsü alınamadı`);
    }
  }
  return notes;
}

export function readPresentation(runId: string, team: string, rounds: number, wsHome?: string): Presentation {
  const out = teamWorkspace(runId, team, wsHome).out;
  const thesis = lastThesis(out, rounds);
  const dir = shotsDir(runId, team, wsHome);
  let shotNames: string[] = [];
  try { shotNames = readdirSync(dir).filter((n) => n.endsWith('.png')); } catch { /* none */ }
  const screens = shotNames.map((n) => /^screen-(\d+)\.png$/.exec(n)).filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ width: Number(m[1]), media: `shot:${m[0]}` })).sort((a, b) => a.width - b.width);
  const decisions = readDecisions(out).lines.length;
  const m = readManifest(out);
  if (!m.ok) {
    const cards: PresentationCard[] = thesis ? [{ kind: 'thesis', title: 'Tez', thesis }] : [];
    for (const s of screens) cards.push({ kind: 'screen', title: `Ekran ${s.width}px`, media: s.media });
    return { team, cards, thesis, borrowed: [], flags: [], screens, reason: m.reason, decisions };
  }
  const cards: PresentationCard[] = m.value.cards.map((c) => {
    if (c.kind === 'thesis') return { kind: c.kind, title: c.title, thesis: thesis ?? undefined };
    if (c.kind === 'screen') {
      const s = screens.find((x) => x.width === 1440) ?? screens[0];
      return s ? { kind: c.kind, title: c.title, media: s.media } : { kind: c.kind, title: c.title, reason: 'ekran görüntüsü yok' };
    }
    if (c.kind === 'pdf' && c.file) {
      const n = `${c.file.replace(/[^a-z0-9.-]/gi, '_')}.png`;
      return shotNames.includes(n) ? { kind: c.kind, title: c.title, media: `shot:${n}` } : { kind: c.kind, title: c.title, reason: 'PDF sayfası yok' };
    }
    if (c.file) {
      const md = readMedia(out, c.file);
      return md.ok ? { kind: c.kind, title: c.title, media: `out:${c.file}` } : { kind: c.kind, title: c.title, reason: md.reason };
    }
    return { kind: c.kind, title: c.title };
  });
  return { team, cards, thesis, borrowed: m.value.borrowed, flags: m.flags ?? [], screens, decisions };
}

/** What the jury reads: titles, the thesis and its claims, the borrow credit. Never media bytes. */
export function juryText(p: Presentation): string {
  const lines: string[] = [];
  if (p.thesis) lines.push(`Tez: ${p.thesis.thesis}`, ...p.thesis.claims.map((c, i) => `İddia ${i + 1}: ${c}`), `Durum: ${p.thesis.status}`);
  for (const c of p.cards) lines.push(`Kart (${c.kind}): ${c.title}${c.reason ? ` — ${c.reason}` : ''}`);
  if (p.screens.length) lines.push(`Ekran görüntüsü: ${p.screens.map((s) => `${s.width}px`).join(', ')}`);
  for (const b of p.borrowed) lines.push(`Ödünç fikir (tur ${b.round}): ${b.idea}`);
  lines.push(`Ekip kararı sayısı: ${p.decisions}`);
  return lines.join('\n');
}
