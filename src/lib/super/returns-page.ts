/**
 * The owner's report page of a cut's returns (kesim-geri-donus K8): one numbered row per branch
 * not back in dev, its commits' subjects and what "Hepsine aç" does with it. Turkish, the owner's
 * language; self-contained HTML (no script), opened as a web card beside the ask.
 */
import type { ReturnGroup, ReturnsReport } from './returns.js';

const esc = (t: string): string => t.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string));

/** What happens to a group when the owner says yes. */
export function actionLine(g: ReturnGroup): string {
  switch (g.action) {
    case 'push': return 'Dal push edilir, dev\'e taslak PR açılır.';
    case 'push-pr': return 'PR\'ı birleşmiş; sonraki commit\'ler için yeni bir taslak PR açılır.';
    case 'rescue': return `Commit'ler kendi dalına (${g.rescueBranch ?? 'yeni dal'}) taşınır, o dal için taslak PR açılır.`;
    default: return 'Bir şey yapılmaz.';
  }
}

export function renderReturnsPage(topic: string, r: ReturnsReport, at = new Date()): string {
  const rows = r.awaiting.map((g, i) => {
    const commits = g.commits.filter((c) => c.state === 'awaiting');
    const list = commits.map((c) => `<li><code>${esc(c.sha.slice(0, 9))}</code> ${esc(c.subject)}</li>`).join('');
    return `<section class="g"><h2><span class="n">${i + 1}</span> ${esc(g.name)}</h2>`
      + `<p class="a">${esc(actionLine(g))}</p><ul>${list}</ul></section>`;
  }).join('\n');
  const inPr = r.inPr.length
    ? `<h3>Zaten PR'da (${r.inPr.length})</h3><ul>${r.inPr.map((g) => `<li>${esc(g.name)}</li>`).join('')}</ul>` : '';
  const dev = r.dev ? `${esc(r.dev.ref)} ${esc(r.dev.sha.slice(0, 9))}${r.dev.stale ? ' (güncellenemedi)' : ''}` : 'yok';
  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kesim ${esc(topic)} → dev'e dönüş</title>
<style>
:root{color-scheme:light dark;--fg:#1d1b26;--mut:#6b6880;--bg:#fff;--card:#f6f5fa;--acc:#6d4ae0}
@media (prefers-color-scheme:dark){:root{--fg:#eeecf6;--mut:#a5a2b8;--bg:#15131c;--card:#211e2b;--acc:#a58bff}}
body{margin:0;padding:24px 16px;font:15px/1.5 -apple-system,system-ui,sans-serif;color:var(--fg);background:var(--bg)}
main{max-width:760px;margin:0 auto}h1{font-size:20px;margin:0 0 4px}p.m{color:var(--mut);margin:0 0 20px}
.g{background:var(--card);border-radius:12px;padding:12px 16px;margin:0 0 12px}
.g h2{font-size:16px;margin:0 0 4px;display:flex;gap:8px;align-items:center;overflow-wrap:anywhere}
.n{flex:none;display:inline-grid;place-items:center;width:24px;height:24px;border-radius:12px;background:var(--acc);color:#fff;font-size:13px}
.a{margin:0 0 6px;color:var(--mut)}ul{margin:0;padding-left:20px}li{overflow-wrap:anywhere}code{font-size:13px}h3{font-size:15px;margin:20px 0 6px}
</style></head><body><main>
<h1>Kesim ${esc(topic)} → dev'e dönüş</h1>
<p class="m">${r.awaiting.length} dal dev'e dönmedi. dev: ${dev}. Seçmek için numaraları yaz (ör. 1, 3). ${esc(at.toISOString().slice(0, 16).replace('T', ' '))}</p>
${rows}
${inPr}
</main></body></html>
`;
}
