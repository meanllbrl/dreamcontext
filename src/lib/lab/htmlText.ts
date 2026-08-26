/**
 * html -> text/markdown extraction for script-authored bodies (html/v1 and
 * app/v1 pages). Dependency-free by design (no cheerio/jsdom/turndown): a
 * card body is authored against the small, curated `lk-*` kit, not an
 * arbitrary web page, so a purpose-built extractor covers it without a
 * supply-chain addition. Regex-based, not a real parser - nested tables and
 * malformed markup are out of scope, matching what the kit actually produces.
 *
 * Used by `lab body` (CLI) so an agent can read what a script-authored card
 * or app page actually renders without opening the dashboard.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', middot: '·',
  copy: '©', reg: '®', trade: '™',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
};

/** Decode named (`&amp;`) and numeric (`&#8212;`, `&#x2014;`) entities. */
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, ent: string) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[ent] ?? whole;
  });
}

/** Strip every remaining tag, keeping only its text content. */
function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '');
}

/** One table's rows/cells, decoded and whitespace-collapsed. `<th>`/`<td>`
 *  are treated identically - the first row is always the header. */
function tableRows(tableHtml: string): string[][] {
  const rows: string[][] = [];
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(tableHtml))) {
    const cells: string[] = [];
    const cellRe = /<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRe.exec(rowMatch[1]))) {
      cells.push(decodeEntities(stripTags(cellMatch[1])).replace(/\s+/g, ' ').trim());
    }
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

/** One `<table>` rendered as a GFM pipe table (`md`) or a plain space-joined
 *  listing (`text`) - no pipes/separator row, just the same row structure. */
function tableToText(tableHtml: string, format: 'text' | 'md'): string {
  const rows = tableRows(tableHtml);
  if (rows.length === 0) return '';
  if (format === 'text') return rows.map((r) => r.join('  ')).join('\n');
  const [head, ...body] = rows;
  const sep = head.map(() => '---');
  return [head, sep, ...body].map((r) => `| ${r.join(' | ')} |`).join('\n');
}

/** A delimiter pair that cannot occur in decoded/stripped html text, so a
 *  restored table can never collide with a plain number already in the
 *  body (Private Use Area code points - not producible by entity decoding
 *  or by stripping tags). */
const TABLE_TOKEN_OPEN = '';
const TABLE_TOKEN_CLOSE = '';

/**
 * Extract what a script-authored html body actually shows: plain text
 * (`format: 'text'`, the CLI default) or GitHub-flavored markdown
 * (`format: 'md'`). Headings, list items and tables keep their block
 * structure in both formats - `md` decorates it (`#`x level, `- `, pipe
 * tables); `text` reads the same structure without markdown syntax.
 * `<script>`/`<style>` CONTENTS are dropped entirely (never shown - this is
 * a static read, nothing executes). `maxChars` truncates the rendered
 * output (after entity decoding, never mid-tag) and marks the cut with an
 * ellipsis.
 */
export function htmlToText(html: string, opts: { format?: 'text' | 'md'; maxChars?: number } = {}): string {
  const format = opts.format ?? 'text';
  let out = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');

  // Tables first - protected as opaque delimited tokens so the generic
  // block/tag pass below can't shred row/cell structure before
  // tableToText sees it.
  const tables: string[] = [];
  out = out.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_whole, inner: string) => {
    tables.push(tableToText(inner, format));
    return `\n${TABLE_TOKEN_OPEN}${tables.length - 1}${TABLE_TOKEN_CLOSE}\n`;
  });

  // Headings -> their own line, decorated only in `md`.
  out = out.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_whole, level: string, inner: string) => {
    const prefix = format === 'md' ? `${'#'.repeat(Number(level))} ` : '';
    return `\n${prefix}${decodeEntities(stripTags(inner)).trim()}\n`;
  });

  // List items -> their own line, decorated only in `md`.
  out = out.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_whole, inner: string) => {
    const prefix = format === 'md' ? '- ' : '';
    return `\n${prefix}${decodeEntities(stripTags(inner)).trim()}\n`;
  });

  // Remaining block-level tags -> line breaks; their own content falls
  // through to the generic tag-strip pass below.
  out = out.replace(/<\/?(p|div|section|article|header|footer|nav|aside|blockquote|ul|ol|tr|br|hr)\b[^>]*>/gi, '\n');

  out = decodeEntities(stripTags(out));

  // Restore the pre-rendered tables (the delimiters survive stripTags -
  // they contain no `<`/`>` - and decodeEntities, which touches only
  // `&...;` sequences).
  const tableTokenRe = new RegExp(`${TABLE_TOKEN_OPEN}(\\d+)${TABLE_TOKEN_CLOSE}`, 'g');
  out = out.replace(tableTokenRe, (_whole, i: string) => tables[Number(i)] ?? '');

  // Collapse blank-line runs (at most one blank line between blocks) and trim.
  out = out.split('\n').map((line) => line.trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (opts.maxChars !== undefined && opts.maxChars >= 0 && out.length > opts.maxChars) {
    out = `${out.slice(0, opts.maxChars).trimEnd()}…`;
  }
  return out;
}
