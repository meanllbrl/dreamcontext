import { SANDBOX_CSP, SANDBOX_FONT_CSS } from './sandboxHtml';
import { CHAT_HTML_KIT_CSS } from '../components/sleepy/chat/chatHtmlKit';
import { REPORT_HTML_CSS } from '../components/lab/reports/reportModel';

/**
 * Several saved blocks and some prose, composed into ONE document.
 *
 * E3 of the artifact layer, and the place the Lab Reports question finally gets answered.
 * The owner's wording was "birkaç kayıtlı blok + metin tek bir rapor" — blocks and text,
 * not blocks and live charts — and that is what settles it: this reuses the Reports LOOK
 * (`REPORT_HTML_CSS`: masthead, brand rule, section rhythm, print rules) so a composed set
 * of blocks is visibly the same family of document, and reuses none of the Reports SCHEMA,
 * because a report item is `{ insight: <slug> }` resolved live and an artifact is frozen.
 * A reader cannot tell the two apart at a glance; a maintainer never has to make one
 * pretend to be the other.
 *
 * Self-contained by the same inheritance as a single-block export: every block was already
 * network-less, so a document made of several is too — CSP included.
 */

export interface ReportBlock {
  title: string;
  /** The block's markup, straight out of the artifact store. */
  html: string;
  /** Optional prose above this block — the "+ metin" half of the request. */
  prose?: string;
  /** Where it came from, shown small under the title. */
  source?: string | null;
  /** When it was saved. */
  date?: string;
}

export interface ArtifactReportInput {
  title: string;
  /** A lede under the title. */
  intro?: string;
  blocks: ReportBlock[];
  tokens: Record<string, string>;
  scheme?: 'light' | 'dark';
  overrideCss?: string;
  lang?: string;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Prose to paragraphs. No markdown parser: this is a text field the user typed into a
 *  compose form, and inventing syntax for it would mean teaching them syntax. */
function proseToHtml(prose: string): string {
  return prose.split(/\n{2,}/)
    .map((p) => `<p>${esc(p.trim()).replace(/\n/g, '<br>')}</p>`)
    .filter((p) => p !== '<p></p>')
    .join('');
}

/**
 * The composed report, as one self-contained file.
 *
 * CASCADE ORDER IS LOAD-BEARING and differs from the single-block export by one step: the
 * kit comes first, then the report template. The kit styles what is INSIDE each block
 * (`dc-*`), the template styles the document AROUND them (`rp-*`), and the template's
 * `body`/`section` rules must win over the kit's — the same ordering `reportToHtml` uses,
 * for the same reason. The vault's brand override stays last, so it still wins over both.
 */
export function artifactReportToHtml(input: ArtifactReportInput): string {
  const { title, intro, blocks, tokens, scheme = 'light', overrideCss, lang } = input;
  const rootVars = Object.entries(tokens).map(([t, v]) => `${t}: ${v};`).join(' ');
  const generated = new Date().toISOString().slice(0, 10);
  const langAttr = lang ? ` lang="${lang.replace(/[^a-zA-Z0-9-]/g, '')}"` : '';

  const sections = blocks.map((b) => [
    '<section class="rp-section">',
    `<h2 class="rp-section-title">${esc(b.title)}</h2>`,
    (b.source || b.date)
      ? `<div class="rp-metaline"><span class="rp-chip">${
        esc([b.date, b.source].filter(Boolean).join(' · '))}</span></div>`
      : '',
    b.prose ? `<div class="rp-prose">${proseToHtml(b.prose)}</div>` : '',
    // The block itself, verbatim. Wrapped in the kit's own doc class so its internal
    // rhythm survives being dropped into a document that has its own.
    `<div class="rp-items"><div class="rp-item">${b.html}</div></div>`,
    '</section>',
  ].filter(Boolean).join('\n'));

  return [
    `<!doctype html><html${langAttr} data-dc-mode="card"><head>`,
    `<meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">`,
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${esc(title)}</title>`,
    `<style>${SANDBOX_FONT_CSS}</style>`,
    `<style>:root { color-scheme: ${scheme}; ${rootVars} }</style>`,
    // A page sets its own reading size — there is no transcript here to inherit one from.
    '<style>html { font-size: 15px; }</style>',
    `<style>${CHAT_HTML_KIT_CSS}</style>`,
    `<style>${REPORT_HTML_CSS}</style>`,
    overrideCss ? `<style>${overrideCss}</style>` : '',
    '</head><body><div class="rp-sheet">',
    '<header class="rp-masthead"><span class="rp-mark"></span>',
    '<span class="rp-logotype">dreamcontext</span><span class="rp-kicker">Report</span>',
    `<span class="rp-mast-meta">Generated ${esc(generated)}</span></header>`,
    '<div class="rp-rule"></div>',
    `<h1 class="rp-title">${esc(title)}</h1>`,
    intro ? `<p class="rp-lede">${esc(intro)}</p>` : '',
    blocks.length === 0
      ? '<p class="rp-empty">No blocks selected.</p>'
      : sections.join('\n'),
    '<footer class="rp-foot"><span class="rp-mark"></span>Composed in dreamcontext</footer>',
    '</div></body></html>',
  ].filter(Boolean).join('\n');
}
