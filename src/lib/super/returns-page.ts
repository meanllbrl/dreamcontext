/**
 * The owner's report page of a cut's returns (kesim-geri-donus K8): one numbered row per branch
 * not back in dev, its commits' subjects and what "Hepsine aç" does with it. Turkish, the owner's
 * language; self-contained HTML (no script), opened as a web card beside the ask.
 *
 * Drawn ONLY with the app's kit tokens (review r1, class report-page-bypasses-theme-tokens): the
 * card injects them and swaps them live with the theme, so no literal colour, font or own
 * dark-mode rule here. A `var()` fallback is the light theme's value, used only when the file is
 * opened outside the app. The branch number is a neutral chip in the body text colour (readable in
 * both themes); spacing on the 4px grid.
 */
import { ACTION_MEANING, type ReturnGroup, type ReturnsReport } from './returns.js';

const esc = (t: string): string => t.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string));

/** What happens to a group when the owner says yes. */
export function actionLine(g: ReturnGroup): string {
  return (ACTION_MEANING[g.action] ?? ACTION_MEANING.none).tr(g);
}

export function renderReturnsPage(topic: string, r: ReturnsReport, at = new Date()): string {
  const rows = r.awaiting.map((g, i) => {
    const commits = g.commits.filter((c) => c.state === 'awaiting');
    const list = commits.map((c) => `<li><code>${esc(c.sha.slice(0, 9))}</code> ${esc(c.subject)}</li>`).join('');
    return `<section class="g"><h2><span class="n">${i + 1}</span> ${esc(g.name)}</h2>`
      + `<p class="a">${esc(actionLine(g))}</p>${list ? `<ul>${list}</ul>` : ''}</section>`;
  }).join('\n');
  const inPr = r.inPr.length
    ? `<h3>Zaten PR'da (${r.inPr.length})</h3><ul>${r.inPr.map((g) => `<li>${esc(g.name)}</li>`).join('')}</ul>` : '';
  const dev = r.dev ? `${esc(r.dev.ref)} ${esc(r.dev.sha.slice(0, 9))}${r.dev.stale ? ' (güncellenemedi)' : ''}` : 'yok';
  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kesim ${esc(topic)} → dev'e dönüş</title>
<style>
body{margin:0;padding:var(--space-6,24px) var(--space-4,16px);font:15px/1.5 var(--font-family,system-ui,sans-serif);color:var(--color-text,#292d34);background:var(--color-bg,#ffffff)}
main{max-width:760px;margin:0 auto}h1{font-size:20px;margin:0 0 var(--space-1,4px)}
p.m{color:var(--color-text-secondary,#646464);margin:0 0 var(--space-1,4px)}p.ask{margin:0 0 var(--space-6,24px);font-weight:600}
.g{background:var(--color-bg-tertiary,#e9ebf0);border-radius:var(--radius-lg,12px);padding:var(--space-3,12px) var(--space-4,16px);margin:0 0 var(--space-3,12px)}
.g h2{font-size:16px;margin:0 0 var(--space-1,4px);display:flex;gap:var(--space-2,8px);align-items:center;overflow-wrap:anywhere}
.n{flex:none;display:inline-grid;place-items:center;min-width:24px;height:24px;padding:0 var(--space-1,4px);box-sizing:border-box;border-radius:12px;background:var(--color-bg,#ffffff);color:var(--color-text,#292d34);border:1px solid var(--color-border,#e8e8e8);font-size:14px;font-weight:700}
.a{margin:0 0 var(--space-2,8px);color:var(--color-text-secondary,#646464)}ul{margin:0;padding-left:var(--space-6,24px)}li{overflow-wrap:anywhere}
code{font:13px var(--font-mono,ui-monospace,monospace)}h3{font-size:15px;margin:var(--space-6,24px) 0 var(--space-2,8px)}
</style></head><body><main>
<h1>Kesim ${esc(topic)} → dev'e dönüş</h1>
<p class="m">${r.awaiting.length} dal dev'e dönmedi · dev: ${dev} · ${esc(at.toISOString().slice(0, 16).replace('T', ' '))} UTC</p>
<p class="ask">Seçmek için numaraları yaz (ör. 1, 3).</p>
${rows}
${inPr}
</main></body></html>
`;
}
