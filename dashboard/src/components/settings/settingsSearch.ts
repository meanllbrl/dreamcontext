/**
 * Settings search (task codex-tarzi-yeni-kabuk W2-C, new shell only; frontend only). While a
 * query is typed every section is drawn, and this filters what is on screen by its own text:
 *  - a block (a direct child of `.settings-content`) whose heading matches shows whole;
 *  - otherwise each `.setting-row` shows only if its name or hint matches, and a block with no
 *    matching row (and no matching text, for a block without rows) is hidden.
 * Matches are painted with the CSS Custom Highlight API: ranges over the existing text nodes,
 * never a rewrite of the markup.
 */
export const SETTINGS_HIGHLIGHT = 'settings-search';
const HIDDEN = 'data-search-hidden';

export function queryWords(q: string): string[] {
  return q.toLocaleLowerCase().split(/\s+/).filter(Boolean);
}

/** Every word of the query appears somewhere in the text. */
export function textMatches(text: string, words: readonly string[]): boolean {
  const t = text.toLocaleLowerCase();
  return words.every((w) => t.includes(w));
}

function heading(block: Element): string {
  return block.querySelector('h1, h2, h3, .settings-section-title, .setting-group-title')?.textContent ?? '';
}

/** Apply the query to `root`; returns how many blocks still show. An empty query clears. */
export function applySettingsSearch(root: HTMLElement, query: string): number {
  const words = queryWords(query);
  const blocks = Array.from(root.children);
  for (const el of root.querySelectorAll(`[${HIDDEN}]`)) el.removeAttribute(HIDDEN);
  paint(root, []);
  if (!words.length) return blocks.length;
  let shown = 0;
  for (const block of blocks) {
    const rows = Array.from(block.querySelectorAll('.setting-row'));
    const head = textMatches(heading(block), words);
    let any = head;
    if (!head) {
      if (rows.length) {
        for (const row of rows) {
          const text = `${row.querySelector('.setting-row-title')?.textContent ?? ''} ${row.querySelector('.setting-row-hint')?.textContent ?? ''}`;
          if (textMatches(text, words)) any = true;
          else row.setAttribute(HIDDEN, '');
        }
      } else {
        any = textMatches(block.textContent ?? '', words);
      }
    }
    if (any) shown++;
    else block.setAttribute(HIDDEN, '');
  }
  paint(root, words);
  return shown;
}

/** Highlight every word in the visible text of `root`. A webview without the API shows the
 *  filtered rows unpainted. */
function paint(root: HTMLElement, words: readonly string[]): void {
  const reg = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights;
  const HighlightCtor = (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  if (!reg || !HighlightCtor) return;
  if (!words.length) { reg.delete(SETTINGS_HIGHLIGHT); return; }
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || el.closest(`[${HIDDEN}], option, select, script, style`)) continue;
    const text = (n.textContent ?? '').toLocaleLowerCase();
    for (const w of words) {
      for (let at = text.indexOf(w); at >= 0; at = text.indexOf(w, at + w.length)) {
        const r = document.createRange();
        r.setStart(n, at);
        r.setEnd(n, at + w.length);
        ranges.push(r);
      }
    }
  }
  reg.set(SETTINGS_HIGHLIGHT, new HighlightCtor(...ranges));
}
