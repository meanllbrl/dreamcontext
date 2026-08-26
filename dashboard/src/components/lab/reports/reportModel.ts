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

/** The renderable MatrixSet for an item, live or dated, or null. */
export function itemMatrixSet(item: ResolvedReportItem): MatrixSet | null {
  if (item.cache?.matrix) return item.cache.matrix.set as unknown as MatrixSet;
  if (item.matrixSnapshot) return snapshotToSet(item.matrixSnapshot);
  return null;
}

function itemToMarkdown(item: ResolvedReportItem): string[] {
  const title = item.title ?? item.insight;
  if (item.missing) return [`### ${title}`, '', `> ⚠ Insight \`${item.insight}\` no longer exists.`, ''];
  if (item.asOf === null) return [`### ${title}`, '', '_No snapshot at or before this date._', ''];

  const lines: string[] = [`### ${title}`, '', `_as of ${item.asOf}_`, ''];
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

/** The whole report as GitHub-flavored Markdown. */
export function reportToMarkdown(detail: ReportDetail): string {
  const lines: string[] = [`# ${detail.report.title}`, ''];
  if (detail.report.description) lines.push(detail.report.description, '');
  lines.push(detail.date ? `_Date: ${detail.date} (latest sync at/before end of day)_` : '_Live data_', '');
  for (const section of detail.sections) {
    lines.push(`## ${section.title}`, '');
    if (section.prose) lines.push(section.prose, '');
    for (const item of section.items) lines.push(...itemToMarkdown(item));
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

function itemToHtml(item: ResolvedReportItem): string {
  const title = esc(item.title ?? item.insight);
  if (item.missing) {
    return `<div class="lk-stat"><span class="lk-label">${title}</span><span class="lk-muted">⚠ Insight ${esc(item.insight)} no longer exists.</span></div>`;
  }
  if (item.asOf === null) {
    return `<div class="lk-stat"><span class="lk-label">${title}</span><span class="lk-muted">No snapshot at or before this date.</span></div>`;
  }
  const asOf = `<div class="lk-muted">as of ${esc(item.asOf)}</div>`;
  const set = itemMatrixSet(item);
  if (set) return `<h3 class="lk-title">${title}</h3>${asOf}${matrixToHtml(set, item.breakdown)}`;
  if (item.funnelSnapshot) {
    const funnels = item.funnelSnapshot.funnels.map((funnel) => {
      const rows = funnel.steps.map((s) => `<tr><td>${esc(s.key)}</td><td class="lk-num">${esc(fmtNum(s.users))}</td></tr>`);
      return `<div class="lk-label">${esc(funnel.id)}</div><table class="lk-table"><thead><tr><th>Step</th><th class="lk-num">Users</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
    });
    return `<h3 class="lk-title">${title}</h3>${asOf}${funnels.join('')}`;
  }
  return `<div class="lk-stat"><span class="lk-label">${title}</span><span class="lk-value">${esc(fmtNum(item.latest, item.unit))}</span>${asOf}</div>`;
}

/** The whole report as ONE self-contained HTML document (no external requests). */
export function reportToHtml(detail: ReportDetail, tokens: Record<string, string>): string {
  const rootVars = Object.entries(tokens).map(([t, v]) => `${t}: ${v};`).join(' ');
  const sections = detail.sections.map((section) => [
    `<h2 class="lk-title" style="font-size:16px">${esc(section.title)}</h2>`,
    section.prose ? `<p class="lk-muted">${esc(section.prose)}</p>` : '',
    ...section.items.map(itemToHtml),
  ].filter(Boolean).join('\n'));
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<title>${esc(detail.report.title)}</title>`,
    `<style>:root { ${rootVars} } body { background: var(--color-bg); max-width: 860px; margin: 0 auto; padding: 24px; }</style>`,
    `<style>${LAB_HTML_KIT_CSS}</style>`,
    '</head><body>',
    `<h1 class="lk-title" style="font-size:20px">${esc(detail.report.title)}</h1>`,
    detail.report.description ? `<p class="lk-muted">${esc(detail.report.description)}</p>` : '',
    `<p class="lk-muted">${detail.date ? `Date: ${esc(detail.date)} (latest sync at/before end of day)` : 'Live data'}</p>`,
    sections.join('\n<hr class="lk-divider">\n'),
    detail.report.notes ? `<hr class="lk-divider"><pre class="lk-muted" style="white-space:pre-wrap;font-family:inherit">${esc(detail.report.notes)}</pre>` : '',
    '</body></html>',
  ].filter(Boolean).join('\n');
}
