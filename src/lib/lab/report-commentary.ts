import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readFrontmatter, writeFrontmatter } from '../frontmatter.js';
import { claudeAwarePath } from '../claude-path.js';
import { labDir, isSafeInsightSlug } from './store.js';
import type { ReportManifest, ResolvedReportSection, ResolvedReportItem } from './reports-store.js';
import { LabError } from './types.js';

/**
 * Report commentary — the OPTIONAL agent-written reading layer of a report
 * (owner decisions, 2026-09-01: generated ON DEMAND from a button, never on a
 * schedule by default; a report without it is first-class — `commentary: false`
 * in the manifest removes the surface entirely).
 *
 * Boundaries, so the layer stays honest:
 * - Deterministic honesty stays CODE: mixed-window warnings, unmeasured
 *   windows, low-sample fades are the platform's job. The commentary adds
 *   INTERPRETATION on top, and is labelled as generated, with its model and
 *   timestamp — the same as-of discipline the data wears.
 * - It never replaces the author's section prose (the reading guide) and never
 *   owns numbers: the prompt embeds the resolved values and forbids inventing
 *   any others.
 * - The generation is a PURE TEXT transform: headless `claude -p` with plan
 *   permission mode and no write surface — the server writes the file, the
 *   model only writes prose.
 *
 * Storage: `lab/reports/.commentary/<slug>/<dateKey>.md` (dateKey = the report
 * view date, or `live`), dated like every other honest artifact.
 */

export interface ReportCommentary {
  slug: string;
  /** The report view this commentary was written for: 'live' or YYYY-MM-DD. */
  dateKey: string;
  generatedAt: string;
  model: string;
  /** Markdown body (the panel renders it with the inline-markdown renderer). */
  body: string;
}

/** Output cap — commentary is a reading, not a second report. */
export const MAX_COMMENTARY_BYTES = 16_000;
/** Generation watchdog. */
export const COMMENTARY_TIMEOUT_MS = 180_000;

export function commentaryDateKey(date: string | null): string {
  return date ?? 'live';
}

export function commentaryDir(contextRoot: string, slug: string): string {
  return join(labDir(contextRoot), 'reports', '.commentary', slug);
}

export function commentaryPath(contextRoot: string, slug: string, dateKey: string): string {
  return join(commentaryDir(contextRoot, slug), `${dateKey}.md`);
}

function isSafeDateKey(dateKey: string): boolean {
  return dateKey === 'live' || /^\d{4}-\d{2}-\d{2}$/.test(dateKey);
}

/** The stored commentary for (slug, dateKey), or null. Lenient read. */
export function readReportCommentary(
  contextRoot: string,
  slug: string,
  dateKey: string,
): ReportCommentary | null {
  if (!isSafeInsightSlug(slug) || !isSafeDateKey(dateKey)) return null;
  const path = commentaryPath(contextRoot, slug, dateKey);
  if (!existsSync(path)) return null;
  try {
    const { data, content } = readFrontmatter<Record<string, unknown>>(path);
    const body = content.trim();
    if (!body) return null;
    return {
      slug,
      dateKey,
      generatedAt: typeof data.generated_at === 'string' ? data.generated_at : '',
      model: typeof data.model === 'string' ? data.model : 'unknown',
      body,
    };
  } catch {
    return null;
  }
}

export function writeReportCommentary(contextRoot: string, commentary: ReportCommentary): void {
  if (!isSafeInsightSlug(commentary.slug) || !isSafeDateKey(commentary.dateKey)) {
    throw new LabError('Invalid commentary slug/date.');
  }
  mkdirSync(commentaryDir(contextRoot, commentary.slug), { recursive: true });
  writeFrontmatter(
    commentaryPath(contextRoot, commentary.slug, commentary.dateKey),
    { generated_at: commentary.generatedAt, model: commentary.model, date: commentary.dateKey },
    commentary.body + '\n',
  );
}

// ─── Prompt ──────────────────────────────────────────────────────────────────

function spanDays(w: { fromISO: string; toISO: string }): number {
  const span = Date.parse(`${w.toISO}T00:00:00Z`) - Date.parse(`${w.fromISO}T00:00:00Z`);
  return Number.isFinite(span) ? Math.max(0, Math.round(span / 86_400_000)) : 0;
}

function fmtWindow(item: ResolvedReportItem): string {
  if (item.window) {
    return `${spanDays(item.window)}-day window ${item.window.fromISO}→${item.window.toISO}`;
  }
  return item.windowStatus === 'cannot' ? 'own window (manual tile, no declared window)' : 'no declared window';
}

function itemLine(item: ResolvedReportItem): string {
  if (item.missing) return `- ${item.insight}: MISSING (insight deleted)`;
  const title = item.title ?? item.insight;
  if (item.asOf === null) {
    return item.targetWindow
      ? `- ${title}: NOT MEASURED YET for ${item.targetWindow.fromISO}→${item.targetWindow.toISO}`
      : `- ${title}: no data`;
  }
  const value = item.latest !== null ? `${item.latest}${item.unit ? ` ${item.unit}` : ''}` : '—';
  const lines = [`- ${title}: ${value} · ${fmtWindow(item)} · status ${item.windowStatus} · as of ${item.asOf}`];
  const set = item.matrixSnapshot ?? item.cache?.matrix?.set ?? null;
  if (set && Array.isArray(set.rows)) {
    for (const row of set.rows.slice(0, 12)) {
      const coords = Object.entries(row.d ?? {}).map(([k, v]) => `${k}=${v}`).join(' ');
      lines.push(`    · ${coords} → ${row.v}${row.n !== undefined ? ` (n=${row.n})` : ''}`);
    }
  }
  if (item.funnelSnapshot) {
    for (const funnel of item.funnelSnapshot.funnels.slice(0, 4)) {
      const steps = funnel.steps.map((s) => `${s.key}:${s.users}`).join(' → ');
      lines.push(`    · funnel ${funnel.id}: ${steps}`);
    }
  }
  return lines.join('\n');
}

/**
 * A SELF-CONTAINED prompt: everything the model may talk about is embedded,
 * and everything else is forbidden. Pure text in, markdown out.
 */
export function buildCommentaryPrompt(
  report: ReportManifest,
  sections: ResolvedReportSection[],
  date: string | null,
  prior: ReportCommentary | null,
): string {
  const sectionTitles = sections.map((s) => s.title);
  const parts: string[] = [
    'You write the commentary layer of an analytics report. Respond with MARKDOWN only (paragraphs, **bold**, `code` — no lists of raw numbers, no preamble).',
    '',
    'OUTPUT FORMAT (parsed mechanically — follow it exactly):',
    '- Start with the OVERALL reading: 1–2 short paragraphs, NO heading.',
    '- Then, for each section that deserves a comment, one block:',
    '  `## <the section title EXACTLY as listed below>`',
    '  followed by 1–3 sentences positioning that section (what moved, what to act on, what to distrust).',
    '- Skip sections with nothing worth saying. Never invent a section title.',
    `- Section titles, exactly: ${sectionTitles.map((t) => `"${t}"`).join(', ')}`,
    '',
    'HARD RULES:',
    '- Use ONLY the numbers below. NEVER invent, extrapolate or round beyond them.',
    '- An item marked NOT MEASURED / no data is exactly that — you may point at it, never fill it.',
    '- Respect the measurement windows: never compare values whose windows differ without saying so.',
    '- Write in the LANGUAGE the report itself is written in (title, prose).',
    `- At most ${Math.floor(MAX_COMMENTARY_BYTES / 8)} characters in total.`,
    '- You are interpretation on top of the data; the report already renders the numbers, warnings and windows itself.',
    '',
    `REPORT: ${report.title}`,
    report.description ? `DESCRIPTION: ${report.description}` : '',
    `VIEW: ${date ? `window ending ${date}` : 'live (window ending today)'}`,
    '',
  ];
  for (const section of sections) {
    parts.push(`SECTION: ${section.title}`);
    if (section.prose) parts.push(`AUTHOR'S READING GUIDE: ${section.prose}`);
    for (const item of section.items) parts.push(itemLine(item));
    parts.push('');
  }
  if (report.notes) parts.push(`REPORT NOTES:\n${report.notes}`, '');
  if (prior) {
    parts.push(
      `PREVIOUS COMMENTARY (${prior.dateKey}, for continuity — mention real changes since, don't repeat it):`,
      prior.body.slice(0, 2_000),
      '',
    );
  }
  return parts.filter((p) => p !== null && p !== undefined).join('\n');
}

// ─── Generation (headless `claude -p`, pure text transform) ─────────────────

export interface GenerateOptions {
  model?: string;
  timeoutMs?: number;
  /** Test seam: fake the claude run. Receives the prompt, returns the body. */
  runImpl?: (prompt: string, model: string) => Promise<string>;
}

function runClaude(prompt: string, model: string, timeoutMs: number): Promise<string> {
  const bin = process.env.DREAMCONTEXT_CLAUDE_BIN || 'claude';
  return new Promise((resolve, reject) => {
    // Plan mode + no tools needed: the model transforms text; the SERVER owns
    // the file write. Prompt goes as an argv positional (never shell-parsed).
    const child = spawn(bin, ['-p', prompt, '--model', model, '--permission-mode', 'plan'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: claudeAwarePath() },
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new LabError(`Commentary generation timed out after ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (c: Buffer) => { out += c.toString('utf-8'); });
    child.stderr?.on('data', (c: Buffer) => { err = (err + c.toString('utf-8')).slice(-2000); });
    child.on('error', (e) => { clearTimeout(timer); reject(new LabError(`Couldn't start claude: ${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && out.trim()) resolve(out.trim());
      else reject(new LabError(err.trim() || `claude exited with code ${code} and no output.`));
    });
  });
}

/**
 * Generate + persist the commentary for one report view. The caller resolves
 * the report FIRST (typically after the window syncs settled) and hands the
 * sections in — generation never triggers data fetches of its own.
 */
export async function generateReportCommentary(
  contextRoot: string,
  report: ReportManifest,
  sections: ResolvedReportSection[],
  date: string | null,
  opts: GenerateOptions = {},
): Promise<ReportCommentary> {
  if (report.commentary === false) {
    throw new LabError(`Report "${report.slug}" has commentary disabled (commentary: false).`);
  }
  const dateKey = commentaryDateKey(date);
  const model = opts.model ?? 'sonnet';
  const prior = readReportCommentary(contextRoot, report.slug, dateKey)
    ?? (date === null ? null : readReportCommentary(contextRoot, report.slug, 'live'));
  const prompt = buildCommentaryPrompt(report, sections, date, prior);
  const run = opts.runImpl ?? ((p: string, m: string) => runClaude(p, m, opts.timeoutMs ?? COMMENTARY_TIMEOUT_MS));
  let body = (await run(prompt, model)).trim();
  if (Buffer.byteLength(body, 'utf-8') > MAX_COMMENTARY_BYTES) {
    body = body.slice(0, MAX_COMMENTARY_BYTES) + '…';
  }
  if (!body) throw new LabError('Commentary generation produced no text.');
  const commentary: ReportCommentary = {
    slug: report.slug,
    dateKey,
    generatedAt: new Date().toISOString(),
    model,
    body,
  };
  writeReportCommentary(contextRoot, commentary);
  return commentary;
}
