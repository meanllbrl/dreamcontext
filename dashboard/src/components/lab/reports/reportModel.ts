import type { ReportDetail, ResolvedReportItem } from '../../../hooks/useLab';
import { LAB_HTML_KIT_CSS } from '../labHtmlKit';
import { dimLabel, dimValues, pivotCell, pivotToMarkdown, snapshotToSet, type MatrixSet } from '../matrixModel';

/**
 * Report export builders — the PURE half of ReportPage.tsx.
 *
 * Two artifacts, one honesty rule: both carry the "as of" stamp for every item
 * and say "no snapshot" where there is none — an export must never look more
 * complete than the page it came from.
 *
 * - `reportToMarkdown`: the whole report as GFM (copy button).
 * - `reportToHtml`: a SELF-CONTAINED single-file document — the kit CSS plus
 *   the resolved token values inlined, no external requests, openable anywhere.
 */

function fmtNum(v: number | null, unit?: string | null): string {
  if (v === null) return '—';
  return `${v.toLocaleString('en-US')}${unit ? ` ${unit}` : ''}`;
}

// ─── Measurement-window honesty (pure; shared by page + exports) ────────────

const DAY_MS = 86_400_000;

export type ItemWindow = { fromISO: string; toISO: string };

/** Whole days a window spans (7 for last_7_days). */
export function windowSpanDays(w: ItemWindow): number {
  const span = Date.parse(`${w.toISO}T00:00:00Z`) - Date.parse(`${w.fromISO}T00:00:00Z`);
  return Number.isFinite(span) ? Math.max(0, Math.round(span / DAY_MS)) : 0;
}

function fmtDay(iso: string): string {
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(t)
    ? new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
    : iso;
}

export type WindowTone = 'known' | 'none' | 'unknown';

/**
 * The window label an item wears next to its as-of stamp. Three honest states:
 * a real window ("7-day · Aug 25 – Sep 1"), a live item that declared none
 * ("no declared window" — an unlabelled number must not pass as a windowed
 * one), and a dated series item whose history recorded none ("window unknown"
 * — today's tweak must not relabel history).
 */
export function windowLabel(
  item: Pick<ResolvedReportItem, 'window' | 'matrixSnapshot' | 'funnelSnapshot'>,
  dated: boolean,
): { text: string; tone: WindowTone } {
  if (item.window) {
    const days = windowSpanDays(item.window);
    return {
      text: `${days}-day · ${fmtDay(item.window.fromISO)} – ${fmtDay(item.window.toISO)}`,
      tone: 'known',
    };
  }
  if (dated && !item.matrixSnapshot && !item.funnelSnapshot) {
    return { text: 'window unknown', tone: 'unknown' };
  }
  return { text: 'no declared window', tone: 'none' };
}

/**
 * Mixed-window detection for one section: data-bearing items are bucketed by
 * window span ("7-day", "30-day", "no declared window"); two or more buckets
 * side by side is the silent 7d-next-to-30d composition the surface must call
 * out instead of a footnote (2026-08-31 report). All-same or no-data → null.
 */
export function sectionWindowMix(items: ResolvedReportItem[]): string[] | null {
  const buckets = new Map<string, string>();
  for (const item of items) {
    if (item.missing || item.asOf === null) continue;
    if (item.window) {
      const days = windowSpanDays(item.window);
      buckets.set(`d${days}`, `${days}-day`);
    } else {
      buckets.set('none', 'no declared window');
    }
  }
  return buckets.size >= 2 ? [...buckets.values()] : null;
}

// ─── Minimal inline markdown (bold + code) for prose/notes ──────────────────

export type InlineSeg = { kind: 'text' | 'strong' | 'code'; text: string };

/** Tokenize `**bold**` and `` `code` `` — the two marks report prose actually
 *  uses. Pure segments: the page maps them to React nodes, the export to
 *  escaped HTML. Everything else stays literal text. */
export function parseInlineMarkdown(text: string): InlineSeg[] {
  const segs: InlineSeg[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) segs.push({ kind: 'text', text: text.slice(last, m.index) });
    if (m[1] !== undefined) segs.push({ kind: 'strong', text: m[1] });
    else segs.push({ kind: 'code', text: m[2] as string });
    last = m.index + m[0].length;
  }
  if (last < text.length) segs.push({ kind: 'text', text: text.slice(last) });
  return segs;
}

/** The same segments as escaped HTML (escape FIRST, then our own tags only). */
export function inlineMarkdownHtml(text: string): string {
  return parseInlineMarkdown(text)
    .map((s) => {
      if (s.kind === 'strong') return `<strong>${esc(s.text)}</strong>`;
      if (s.kind === 'code') return `<code>${esc(s.text)}</code>`;
      return esc(s.text);
    })
    .join('');
}

/** The renderable MatrixSet for an item, live or dated, or null. */
export function itemMatrixSet(item: ResolvedReportItem): MatrixSet | null {
  if (item.cache?.matrix) return item.cache.matrix.set as unknown as MatrixSet;
  if (item.matrixSnapshot) return snapshotToSet(item.matrixSnapshot);
  return null;
}

function itemToMarkdown(item: ResolvedReportItem, dated: boolean): string[] {
  const title = item.title ?? item.insight;
  if (item.missing) return [`### ${title}`, '', `> ⚠ Insight \`${item.insight}\` no longer exists.`, ''];
  if (item.asOf === null) {
    if (item.targetWindow && (item.windowStatus === 'missing' || item.windowStatus === 'stale')) {
      return [`### ${title}`, '', `_Window ${item.targetWindow.fromISO} → ${item.targetWindow.toISO} not measured yet._`, ''];
    }
    return [`### ${title}`, '', '_No snapshot at or before this date._', ''];
  }

  const win = windowLabel(item, dated);
  const lines: string[] = [`### ${title}`, '', `_as of ${item.asOf}_ · _${win.text}_`, ''];
  const set = itemMatrixSet(item);
  if (set) {
    const rowDim = item.breakdown?.rows ?? set.dims[0]?.key;
    const colDim = item.breakdown?.cols ?? set.dims[1]?.key;
    lines.push(pivotToMarkdown(set, { rowDim, colDim, filter: item.breakdown?.filter }), '');
    return lines;
  }
  if (item.funnelSnapshot) {
    for (const funnel of item.funnelSnapshot.funnels) {
      lines.push(`**${funnel.id}**`);
      lines.push('| Step | Users |', '| --- | ---: |');
      for (const step of funnel.steps) lines.push(`| ${step.key} | ${fmtNum(step.users)} |`);
      lines.push('');
    }
    return lines;
  }
  if (item.cache && item.cache.series.length > 0 && item.cache.series.some((s) => s.points.length > 1)) {
    lines.push('| Series | Latest |', '| --- | ---: |');
    for (const s of item.cache.series) {
      const last = s.points[s.points.length - 1];
      lines.push(`| ${s.name} | ${fmtNum(last ? last.v : null, item.unit)} |`);
    }
    lines.push('');
    return lines;
  }
  lines.push(`**${fmtNum(item.latest, item.unit)}**`, '');
  return lines;
}

/** The AI commentary an export may carry (labelled, never a substitute). */
export interface ExportCommentary {
  body: string;
  model: string;
  generatedAt: string;
}

/**
 * Split a commentary body into the overall reading and per-section notes.
 * The generation contract asks the model for: leading paragraphs (the overall
 * reading), then `## <section title exactly as listed>` blocks. Parsing is
 * LENIENT: a heading that matches no section (trimmed, case-insensitive)
 * folds back into the summary rather than disappearing — a hallucinated title
 * must not silently eat a paragraph.
 */
export function parseCommentarySections(
  body: string,
  sectionTitles: string[],
): { summary: string; sections: Record<string, string> } {
  const byNorm = new Map(sectionTitles.map((t) => [t.trim().toLowerCase(), t]));
  const chunks = body.split(/^##\s+/m);
  const summaryParts: string[] = [chunks[0]?.trim() ?? ''];
  const sections: Record<string, string> = {};
  for (const chunk of chunks.slice(1)) {
    const nl = chunk.indexOf('\n');
    const heading = (nl === -1 ? chunk : chunk.slice(0, nl)).trim();
    const text = (nl === -1 ? '' : chunk.slice(nl + 1)).trim();
    const match = byNorm.get(heading.toLowerCase());
    if (match && text) {
      sections[match] = sections[match] ? `${sections[match]}\n\n${text}` : text;
    } else if (text || heading) {
      summaryParts.push([heading, text].filter(Boolean).join(' — '));
    }
  }
  return { summary: summaryParts.filter(Boolean).join('\n\n'), sections };
}

/** The whole report as GitHub-flavored Markdown. */
export function reportToMarkdown(detail: ReportDetail, commentary?: ExportCommentary | null): string {
  const parsed = commentary
    ? parseCommentarySections(commentary.body, detail.sections.map((s) => s.title))
    : null;
  const lines: string[] = [`# ${detail.report.title}`, ''];
  if (detail.report.description) lines.push(detail.report.description, '');
  lines.push(detail.date ? `_Date: ${detail.date} (latest sync at/before end of day)_` : '_Live data_', '');
  if (commentary && parsed?.summary) {
    lines.push(`> **AI commentary** (${commentary.model} · ${commentary.generatedAt}):`);
    for (const para of parsed.summary.split(/\n{2,}/)) lines.push(`> ${para.replace(/\n/g, ' ')}`);
    lines.push('');
  }
  for (const section of detail.sections) {
    lines.push(`## ${section.title}`, '');
    const mix = sectionWindowMix(section.items);
    if (mix) lines.push(`> ⚠ Mixed measurement windows in this section: ${mix.join(', ')}.`, '');
    if (section.prose) lines.push(section.prose, '');
    for (const item of section.items) lines.push(...itemToMarkdown(item, detail.date !== null));
    const note = parsed?.sections[section.title];
    if (note) lines.push(`> 🤖 AI: ${note.replace(/\n+/g, ' ')}`, '');
  }
  if (detail.report.notes) lines.push('---', '', detail.report.notes, '');
  return lines.join('\n');
}

// ─── Single-file HTML export ────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function matrixToHtml(set: MatrixSet, breakdown: ResolvedReportItem['breakdown']): string {
  const rowDim = breakdown?.rows ?? set.dims[0]?.key;
  const colDim = breakdown?.cols ?? set.dims[1]?.key;
  const filter = breakdown?.filter ?? {};
  const rowValues = dimValues(set, rowDim);
  const rowDimDecl = set.dims.find((d) => d.key === rowDim) ?? { key: rowDim };
  if (!colDim) {
    const rows = rowValues.map((value) => {
      const cell = pivotCell(set, { ...filter, [rowDim]: value });
      return `<tr><td>${esc(value)}</td><td class="lk-num">${esc(fmtNum(cell.v))}</td></tr>`;
    });
    return `<table class="lk-table"><thead><tr><th>${esc(dimLabel(rowDimDecl))}</th><th class="lk-num">Value</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
  }
  const colValues = dimValues(set, colDim);
  const head = `<tr><th>${esc(dimLabel(rowDimDecl))}</th>${colValues.map((v) => `<th class="lk-num">${esc(v)}</th>`).join('')}</tr>`;
  const rows = rowValues.map((rowValue) => {
    const cells = colValues.map((colValue) => {
      const cell = pivotCell(set, { ...filter, [rowDim]: rowValue, [colDim]: colValue });
      return `<td class="lk-num">${esc(fmtNum(cell.v))}</td>`;
    });
    return `<tr><td>${esc(rowValue)}</td>${cells.join('')}</tr>`;
  });
  return `<table class="lk-table"><thead>${head}</thead><tbody>${rows.join('')}</tbody></table>`;
}

/** A window chip for the export (same honest tones as the page). */
function windowChipHtml(item: ResolvedReportItem, dated: boolean): string {
  const win = windowLabel(item, dated);
  if (item.windowStatus === 'cannot') {
    return `<span class="rp-chip rp-chip--none">own · ${esc(win.text)}</span>`;
  }
  const tone = item.windowStatus === 'aligned' || item.windowStatus === 'window' || item.windowStatus === 'stale'
    ? 'known'
    : win.tone;
  return `<span class="rp-chip rp-chip--${tone}">${esc(win.text)}</span>`;
}

function itemToHtml(item: ResolvedReportItem, dated: boolean): string {
  const title = esc(item.title ?? item.insight);
  if (item.missing) {
    return `<article class="rp-item rp-item--missing">⚠ Insight <code>${esc(item.insight)}</code> no longer exists.</article>`;
  }
  if (item.asOf === null) {
    const empty = item.targetWindow && (item.windowStatus === 'missing' || item.windowStatus === 'stale')
      ? `Window ${esc(item.targetWindow.fromISO)} → ${esc(item.targetWindow.toISO)} not measured yet.`
      : 'No snapshot at or before this date.';
    return `<article class="rp-item rp-item--stat"><div class="rp-item-head"><span class="rp-item-title">${title}</span></div><div class="rp-empty">${empty}</div></article>`;
  }
  const head = `<div class="rp-item-head"><span class="rp-item-title">${title}</span>${windowChipHtml(item, dated)}</div>`;
  const foot = `<div class="rp-item-foot">as of ${esc(item.asOf)}</div>`;
  const set = itemMatrixSet(item);
  if (set) {
    return `<article class="rp-item">${head}${matrixToHtml(set, item.breakdown)}${foot}</article>`;
  }
  if (item.funnelSnapshot) {
    const funnels = item.funnelSnapshot.funnels.map((funnel) => {
      const rows = funnel.steps.map((s) => `<tr><td>${esc(s.key)}</td><td class="lk-num">${esc(fmtNum(s.users))}</td></tr>`);
      return `<div class="lk-label">${esc(funnel.id)}</div><table class="lk-table"><thead><tr><th>Step</th><th class="lk-num">Users</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
    });
    return `<article class="rp-item">${head}${funnels.join('')}${foot}</article>`;
  }
  return `<article class="rp-item rp-item--stat">${head}<div class="rp-value">${esc(fmtNum(item.latest, item.unit))}</div>${foot}</article>`;
}

/**
 * The export's own template stylesheet — the "dreamcontext Reports" identity
 * (masthead wordmark, gradient rule, designed sections, stat grid, footer).
 * Every color/face rides the inlined design tokens with a light-theme fallback
 * so the file stays readable even opened with no tokens at all. Self-contained:
 * no src/href/URL anywhere (pinned by lab-reports-ui.test.ts).
 */
/**
 * The Reports LOOK — masthead, rule, section rhythm, print rules.
 *
 * Exported because the saved-blocks report (`lib/artifactReport.ts`) composes a
 * different ENTITY out of the same document family: frozen `dream-html` blocks instead
 * of live insight items. Sharing the stylesheet is the point — the two are recognisably
 * the same kind of document — while sharing the report MANIFEST would not be, because a
 * report item is `{ insight: <slug> }` resolved against a live cache and an artifact has
 * nothing to resolve. Look, not schema.
 */
export const REPORT_HTML_CSS = `
* { box-sizing: border-box; }
body { margin: 0; background: var(--color-bg, #ffffff); color: var(--color-text, #292d34); font-family: var(--font-family, ui-sans-serif, system-ui, sans-serif); font-size: 14px; line-height: 1.55; -webkit-font-smoothing: antialiased; }
.rp-sheet { max-width: 880px; margin: 0 auto; padding: 40px 44px 36px; }
.rp-masthead { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.rp-mark { width: 14px; height: 14px; border-radius: 4px; background: var(--gradient-brand, linear-gradient(135deg, #6647f0, #7b68ee)); }
.rp-logotype { font-family: var(--font-family-display, inherit); font-size: 15px; font-weight: 700; letter-spacing: -0.02em; }
.rp-kicker { font-size: 11px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: var(--color-accent, #7b68ee); margin-left: 2px; padding-left: 12px; border-left: 1px solid var(--color-border, #e8e8e8); }
.rp-mast-meta { margin-left: auto; font-size: 12px; color: var(--color-text-tertiary, #64748b); }
.rp-rule { height: 2px; border-radius: 2px; background: var(--gradient-brand, linear-gradient(135deg, #6647f0, #7b68ee)); margin-bottom: 28px; }
.rp-title { font-family: var(--font-family-display, inherit); font-size: 30px; font-weight: 700; letter-spacing: -0.02em; line-height: 1.15; margin: 0 0 8px; }
.rp-lede { font-size: 14px; color: var(--color-text-secondary, #475569); margin: 0 0 12px; max-width: 64ch; }
.rp-metaline { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 12px; color: var(--color-text-tertiary, #64748b); }
.rp-chip { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; white-space: nowrap; color: var(--color-text-secondary, #475569); background: var(--color-bg-tertiary, #eef0f3); }
.rp-chip--known { color: var(--color-accent, #7b68ee); background: var(--color-accent-soft, rgba(123, 104, 238, 0.12)); }
.rp-chip--none, .rp-chip--unknown { color: var(--color-warning, #b45309); background: var(--color-warning-subtle, rgba(224, 140, 12, 0.1)); }
.rp-section { margin: 32px 0 0; }
.rp-section-title { font-family: var(--font-family-display, inherit); font-size: 20px; font-weight: 700; letter-spacing: -0.01em; margin: 0 0 4px; padding-top: 24px; border-top: 1px solid var(--color-border, #e8e8e8); }
.rp-warn { border: 1px solid var(--color-warning, #e08c0c); background: var(--color-warning-subtle, rgba(224, 140, 12, 0.08)); border-radius: 8px; padding: 8px 12px; font-size: 12.5px; margin: 10px 0; }
.rp-prose { background: var(--color-bg-tertiary, #f2f3f7); border-left: 3px solid var(--color-accent, #7b68ee); border-radius: 8px; padding: 12px 16px; font-size: 13px; line-height: 1.65; color: var(--color-text-secondary, #475569); margin: 12px 0 16px; max-width: 76ch; }
.rp-prose strong, .rp-notes strong { color: var(--color-text, #292d34); }
.rp-prose code, .rp-notes code, .rp-item code { font-family: var(--font-mono, ui-monospace, monospace); font-size: 12px; background: rgba(127, 127, 127, 0.14); padding: 1px 4px; border-radius: 4px; }
.rp-items { display: flex; flex-wrap: wrap; gap: 12px; margin: 14px 0 0; }
.rp-item { flex: 1 1 100%; min-width: 0; border: 1px solid var(--color-border, #e8e8e8); border-radius: 12px; padding: 14px 16px; background: var(--color-bg-secondary, #ffffff); }
.rp-item--stat { flex: 1 1 236px; }
.rp-item--missing { border-color: var(--color-error, #dc2626); color: var(--color-error, #dc2626); font-size: 12.5px; }
.rp-item-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px; }
.rp-item-title { font-size: 13px; font-weight: 600; min-width: 0; }
.rp-item-head .rp-chip { margin-left: auto; }
.rp-value { font-family: var(--font-family-display, inherit); font-size: 26px; font-weight: 700; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.rp-empty { font-size: 12.5px; color: var(--color-text-tertiary, #64748b); }
.rp-item-foot { margin-top: 8px; font-size: 11px; color: var(--color-text-tertiary, #64748b); }
.rp-commentary { background: var(--gradient-brand-subtle, rgba(123, 104, 238, 0.06)); border: 1px solid var(--color-accent-soft, rgba(123, 104, 238, 0.12)); border-radius: 12px; padding: 16px; margin: 20px 0 0; font-size: 13px; line-height: 1.65; color: var(--color-text-secondary, #475569); }
.rp-commentary p { margin: 0 0 8px; }
.rp-commentary strong { color: var(--color-text, #292d34); }
.rp-commentary-kicker { font-size: 11px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: var(--color-accent, #7b68ee); margin-bottom: 8px; }
.rp-ai-note { display: flex; align-items: baseline; gap: 8px; background: var(--gradient-brand-subtle, rgba(123, 104, 238, 0.06)); border: 1px solid var(--color-accent-soft, rgba(123, 104, 238, 0.12)); border-radius: 10px; padding: 10px 12px; margin-top: 12px; font-size: 12.5px; line-height: 1.6; color: var(--color-text-secondary, #475569); }
.rp-ai-chip { flex-shrink: 0; font-size: 10px; font-weight: 700; letter-spacing: 0.1em; color: var(--color-accent, #7b68ee); border: 1px solid var(--color-accent-soft, rgba(123, 104, 238, 0.2)); border-radius: 6px; padding: 1px 5px; }
.rp-notes { margin-top: 32px; padding-top: 16px; border-top: 1px solid var(--color-border, #e8e8e8); font-size: 13px; line-height: 1.65; color: var(--color-text-secondary, #475569); max-width: 76ch; }
.rp-notes p { margin: 0 0 10px; }
.rp-foot { margin-top: 48px; padding-top: 14px; border-top: 1px solid var(--color-border, #e8e8e8); display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--color-text-tertiary, #64748b); }
.rp-foot .rp-mark { width: 10px; height: 10px; border-radius: 3px; }
@media print {
  .rp-sheet { max-width: none; padding: 0; }
  .rp-section, .rp-item { break-inside: avoid; }
}
`;

/** Notes body → paragraphs with inline markdown (the leading `## Notes` line
 *  is template scaffolding, not content — dropped). */
function notesToHtml(notes: string): string {
  const body = notes.replace(/^##\s*Notes\s*\n/, '').trim();
  if (!body) return '';
  const paras = body.split(/\n{2,}/).map((p) => `<p>${inlineMarkdownHtml(p.replace(/\n/g, ' '))}</p>`);
  return `<section class="rp-notes">${paras.join('')}</section>`;
}

/** The overall-commentary block for the HTML export (escaped, labelled). */
function commentaryToHtml(commentary: ExportCommentary, summary: string): string {
  const paras = summary.split(/\n{2,}/).map((p) => `<p>${inlineMarkdownHtml(p.replace(/\n/g, ' '))}</p>`);
  return [
    '<section class="rp-commentary"><div class="rp-commentary-kicker">AI commentary</div>',
    paras.join(''),
    `<div class="rp-item-foot">AI-generated · ${esc(commentary.model)} · ${esc(commentary.generatedAt)}</div></section>`,
  ].join('');
}

/** The whole report as ONE self-contained HTML document (no external requests). */
export function reportToHtml(
  detail: ReportDetail,
  tokens: Record<string, string>,
  commentary?: ExportCommentary | null,
): string {
  const rootVars = Object.entries(tokens).map(([t, v]) => `${t}: ${v};`).join(' ');
  const dated = detail.date !== null;
  const generated = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  const parsed = commentary
    ? parseCommentarySections(commentary.body, detail.sections.map((s) => s.title))
    : null;
  const sections = detail.sections.map((section) => {
    const mix = sectionWindowMix(section.items);
    const note = parsed?.sections[section.title];
    return [
      `<section class="rp-section"><h2 class="rp-section-title">${esc(section.title)}</h2>`,
      mix ? `<div class="rp-warn">⚠ Mixed measurement windows in this section: ${esc(mix.join(', '))}.</div>` : '',
      section.prose ? `<div class="rp-prose">${inlineMarkdownHtml(section.prose)}</div>` : '',
      `<div class="rp-items">${section.items.map((item) => itemToHtml(item, dated)).join('\n')}</div>`,
      note ? `<div class="rp-ai-note"><span class="rp-ai-chip">AI</span>${inlineMarkdownHtml(note.replace(/\n+/g, ' '))}</div>` : '',
      '</section>',
    ].filter(Boolean).join('\n');
  });
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<title>${esc(detail.report.title)}</title>`,
    `<style>:root { ${rootVars} }</style>`,
    // Kit first (tables/labels), template second — the template's body/section
    // rules must win the cascade over the kit's card-body defaults.
    `<style>${LAB_HTML_KIT_CSS}</style>`,
    `<style>${REPORT_HTML_CSS}</style>`,
    '</head><body><div class="rp-sheet">',
    '<header class="rp-masthead"><span class="rp-mark"></span><span class="rp-logotype">dreamcontext</span><span class="rp-kicker">Reports</span>',
    `<span class="rp-mast-meta">Generated ${esc(generated)}</span></header>`,
    '<div class="rp-rule"></div>',
    `<h1 class="rp-title">${esc(detail.report.title)}</h1>`,
    detail.report.description ? `<p class="rp-lede">${esc(detail.report.description)}</p>` : '',
    `<div class="rp-metaline"><span class="rp-chip">${detail.date ? `Date: ${esc(detail.date)} — latest sync at/before end of day` : 'Live data'}</span></div>`,
    commentary && parsed?.summary ? commentaryToHtml(commentary, parsed.summary) : '',
    sections.join('\n'),
    detail.report.notes ? notesToHtml(detail.report.notes) : '',
    '<footer class="rp-foot"><span class="rp-mark"></span>Generated with dreamcontext Reports</footer>',
    '</div></body></html>',
  ].filter(Boolean).join('\n');
}
