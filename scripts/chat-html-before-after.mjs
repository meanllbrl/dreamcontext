#!/usr/bin/env node
/**
 * BEFORE vs AFTER for the `dream-html` block, rendered side by side in real Chromium.
 *
 *   node scripts/chat-html-before-after.mjs [<git-ref>]
 *
 * The question this answers is the owner's, and it is not "do the tests pass" — it is
 * "does it actually LOOK better". So it does the only thing that can answer that: renders
 * the SAME markup twice, once through the kit as it was at <git-ref> (default HEAD) and
 * once through the working tree, in a column that behaves like the real transcript — the
 * app's own reading size, leading, tracking and webfont — and screenshots both.
 *
 * Nothing here is a mock of the old behaviour. The BEFORE column is the real previous
 * stylesheet read straight out of git, assembled the way the previous code assembled it:
 * the old CSP (no `font-src`), no embedded face, no `lang`, and the old token set. If the
 * two columns look the same, the work did nothing, and this script is how that would show.
 *
 * Writes to <tmp>/dreamcontext-before-after/ and prints the paths.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(tmpdir(), 'dreamcontext-before-after');
const REF = process.argv[2] || 'HEAD';
mkdirSync(OUT, { recursive: true });

const KIT_REL = 'dashboard/src/components/sleepy/chat/chat-html-kit.css';
const oldKit = execFileSync('git', ['show', `${REF}:${KIT_REL}`], { cwd: REPO, encoding: 'utf-8' });
const newKit = readFileSync(join(REPO, KIT_REL), 'utf-8');
const fontTs = readFileSync(join(REPO, 'dashboard/src/lib/sandboxFont.ts'), 'utf-8');
const FONT_CSS = JSON.parse(fontTs.slice(fontTs.indexOf('= ') + 2, fontTs.lastIndexOf(';')));

/** The app's real theme values (light), as the host resolves and injects them. */
const TOKENS = `--font-family:'Inter',ui-sans-serif,system-ui,sans-serif;
--font-family-display:'Plus Jakarta Sans','Inter',ui-sans-serif,system-ui,sans-serif;
--font-mono:'JetBrains Mono',ui-monospace,monospace;
--color-text:#292d34;--color-text-secondary:#475569;--color-text-tertiary:#64748b;
--color-border:#e4e6ea;--color-border-hover:#cbd2d9;--color-bg:#ffffff;
--color-bg-secondary:#fbfbfc;--color-bg-tertiary:#f1f2f5;--color-bg-elevated:#ffffff;
--color-accent:#7b68ee;--color-accent-soft:rgba(123,104,238,0.12);--color-accent-text:#ffffff;
--color-success:#16a34a;--color-success-subtle:rgba(22,163,74,0.10);
--color-error:#dc2626;--color-error-subtle:rgba(220,38,38,0.10);
--color-warning:#e08c0c;
--color-highlight:#fde68a;--color-highlight-edge:rgba(253,230,138,0.35);
--chart-1:#7b68ee;--chart-2:#22b8cf;--chart-3:#f97362;--chart-4:#16a34a;
--chart-5:#e08c0c;--chart-6:#a855f7;--chart-7:#0ea5e9;--chart-8:#ec4899;
--radius-sm:6px;--radius-md:9px;--radius-lg:12px;--radius-xl:16px;
--shadow-md:0 4px 12px rgba(0,0,0,.10);
--space-1:4px;--space-2:8px;--space-3:12px;--space-4:16px;--space-6:24px;--space-8:32px;`;

/** The transcript's own reading contract (ChatPane.css), and the tracking the app's body
 *  sets (global.css) — the AFTER build inherits both; the BEFORE build never saw them. */
const READING = '--chat-text:15px;--chat-line-height:1.75;--letter-spacing-body:-0.26px;';

/**
 * One block that exercises every complaint at once: Turkish uppercase labels, a four-up
 * stat grid with a long number, a wide table, a flow with a step that MEANS something,
 * and ordinary prose to compare against the column it sits in.
 */
/**
 * The owner's own screenshot, as markup (2026-09-02, "hiçbir şey anlaşılmıyor"): a numbered
 * fix plan whose sentences carry inline `dc-code` chips, written as direct children of
 * `.dc-step-body`. That container used to be a flex column, so every chip became a
 * full-width row and every sentence was cut into three pieces.
 */
/**
 * The owner's SECOND screenshot (2026-09-02, "bu da zor okunan bir gösterim"): a two-option
 * comparison whose options are dense paragraphs. `dc-compare` used `minmax(230px, 1fr)`, so
 * at the pane it was read in it kept two columns of 261px — a measure of 27 characters, and
 * prose broken every three words down two ragged ribbons.
 */
const BLOCK = `<div class="dc-doc">
  <h2 class="dc-h2">Tek kök neden yok — iki app, iki ayrı arıza</h2>
  <div class="dc-compare">
    <div class="dc-option"><div class="dc-option-head">
      <span class="dc-option-title">PushMe — BACKEND</span>
      <span class="dc-chip dc-chip--bad">token hiç üretilmemiş</span></div>
      <p class="dc-p">Onur'un mailindeki link <strong>çıplak şablon</strong>:
      <span class="dc-code">8t6B/yu1ay9l1</span>, <span class="dc-code">deep_link_sub1</span> YOK.</p>
      <ul class="dc-list">
        <li>Kablo <strong>takılı</strong> — webhook provisioner'ı welcome'a geçiriyor, welcome da çağırıyor. Yani eksik entegrasyon değil, çalışan bir dalda düşme.</li>
        <li>Üç aday: anchor kontrolü hata verip fail-closed anchored döndü · mint patlayıp fail-open düz linke düştü · ya da aynı adres sabah 08:34'teki ilk turda da kullanıldıysa tasarım gereği doğru.</li>
        <li>Ayırt edici tek ölçüm: o adresin <span class="dc-code">auth.users</span>'ta ilk oluşma zamanı.</li>
      </ul></div>
    <div class="dc-option dc-option--pick"><div class="dc-option-head">
      <span class="dc-option-title">CalBuddy — APP</span>
      <span class="dc-chip dc-chip--accent">kök neden net</span></div>
      <p class="dc-p">Mailde token <strong>VARDI</strong>
      (<span class="dc-code">deep_link_sub1=8136e0f6…</span>) — backend görevini yaptı. Kayıp app'te.</p>
      <ul class="dc-list">
        <li>Token <span class="dc-code">runSilentLogin</span>'e yalnızca AppsFlyer UDL callback'inden geliyor. Ham URL yolu yok.</li>
        <li>PushMe'de tam bu boşluk 27 Ağustos'ta kapatıldı (<span class="dc-code">token_hash</span>) — gerekçesi bile yazılı: App Link ile açılışta OS URL'i aynen verir.</li>
        <li>UDL ateşlenmezse CalBuddy token'ı <strong>sessizce düşürüyor</strong> — senin çalışman, Onur'da çalışmaması bu yarış.</li>
      </ul></div>
  </div>
  <div class="dc-callout dc-callout--warn"><strong>Kaydettiğim asimetri, önceki okumamı düzeltiyor:</strong> her iki alanda da PushMe'nin düzeltmesi CalBuddy'ye portlanmamış. Tekrar eden bir desen, tek tek kusur değil.</div>
</div>`;

/** BEFORE: the previous CSP, no embedded face, no lang, no reading tokens. */
function before() {
  return `<!doctype html><html data-dc-mode="card"><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<meta charset="utf-8">
<style>:root{color-scheme:light;${TOKENS}}</style>
<style>${oldKit}</style>
</head><body>${BLOCK}</body></html>`;
}

/** AFTER: the working tree — face embedded, `font-src data:`, lang, reading tokens. */
function after() {
  return `<!doctype html><html lang="tr" data-dc-mode="card"><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:">
<meta charset="utf-8">
<style>${FONT_CSS}</style>
<style>:root{color-scheme:light;${TOKENS}${READING}}</style>
<style>${newKit}</style>
</head><body>${BLOCK}</body></html>`;
}

/** The page the two frames sit in: a real transcript column, in the app's own type. */
function harness(width) {
  const prose = `Yukarıdaki paragraf transcript'in kendi yazısı. Aşağıdaki blok onunla
  aynı puntoda, aynı satır aralığında ve aynı karakterde görünmeli — fark buradan okunur.`;
  const col = (label, srcdoc, id) => `
    <section class="col">
      <div class="tag ${id}">${label}</div>
      <p class="prose">${prose}</p>
      <iframe id="${id}" sandbox="allow-scripts" srcdoc="${srcdoc.replace(/"/g, '&quot;')}"></iframe>
    </section>`;
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;650;700&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap">
<style>
  :root{${TOKENS}${READING}}
  body{margin:0;padding:24px;background:#ffffff;font-family:var(--font-family);
    letter-spacing:var(--letter-spacing-body);font-feature-settings:"calt" 0,"clig" 0,"liga" 0;
    -webkit-font-smoothing:antialiased;display:flex;gap:28px;align-items:flex-start}
  .col{width:${width}px;flex:0 0 ${width}px}
  .tag{font:700 11px/1 var(--font-family);letter-spacing:.14em;text-transform:uppercase;
    padding:6px 10px;border-radius:6px;margin-bottom:14px;display:inline-block;color:#fff}
  .tag.before{background:#dc2626}.tag.after{background:#16a34a}
  .prose{font-size:var(--chat-text);line-height:var(--chat-line-height);color:var(--color-text);
    margin:0 0 14px}
  iframe{width:100%;border:1px dashed #cbd2d9;border-radius:10px;background:#fff}
</style></head><body>
${col('BEFORE', before(), 'before')}
${col('AFTER', after(), 'after')}
</body></html>`;
}

const shots = [];

async function shoot(browser, width, name) {
  const page = await browser.newPage({ viewport: { width: width * 2 + 100, height: 1200 } });
  await page.setContent(harness(width), { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  // Size each frame to its content so nothing is cropped by an arbitrary iframe height.
  for (const id of ['before', 'after']) {
    const h = await page.frameLocator(`#${id}`).locator('body')
      .evaluate((b) => Math.ceil(b.getBoundingClientRect().height));
    await page.locator(`#${id}`).evaluate((el, px) => { el.style.height = `${px}px`; }, h);
  }
  await page.waitForTimeout(400);

  const measured = await page.evaluate(async () => {
    const read = async (id) => {
      const f = document.getElementById(id);
      const doc = f.contentDocument;
      return null; // opaque origin — measured below via Playwright instead
    };
    const p = getComputedStyle(document.querySelector('.prose'));
    return { transcriptSize: parseFloat(p.fontSize), transcriptLine: parseFloat(p.lineHeight) };
  });
  const inFrame = {};
  for (const id of ['before', 'after']) {
    inFrame[id] = await page.frameLocator(`#${id}`).locator('.dc-p').first().evaluate((el) => {
      const cs = getComputedStyle(el);
      const probe = document.createElement('span');
      probe.textContent = 'Conversion 14.2% WWW degistiriyor';
      probe.style.cssText = 'position:absolute;left:-9999px;font-size:40px;font-weight:400;white-space:pre';
      probe.style.fontFamily = getComputedStyle(document.body).fontFamily;
      probe.style.letterSpacing = getComputedStyle(document.body).letterSpacing;
      document.body.appendChild(probe);
      const w = probe.getBoundingClientRect().width;
      probe.remove();
      const label = document.querySelector('.dc-label');
      return {
        size: parseFloat(cs.fontSize),
        line: parseFloat(cs.lineHeight),
        faceWidth: w,
        upper: label ? getComputedStyle(label).textTransform : '',
        labelText: label ? label.textContent : '',
      };
    });
  }
  // The transcript's own face width, same probe, for the comparison.
  const hostFace = await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.textContent = 'Conversion 14.2% WWW degistiriyor';
    probe.style.cssText = 'position:absolute;left:-9999px;font-size:40px;font-weight:400;white-space:pre';
    probe.style.fontFamily = getComputedStyle(document.body).fontFamily;
    probe.style.letterSpacing = getComputedStyle(document.body).letterSpacing;
    document.body.appendChild(probe);
    const w = probe.getBoundingClientRect().width;
    probe.remove();
    return w;
  });

  // ── every face the kit uses, measured on the REAL classes ──────────────────────────
  // Not a synthetic `font-family: 'Inter'` probe: an unknown family and a loaded one can
  // measure identically, so a hand-written family string proves nothing. These read the
  // classes the kit actually applies — .dc-h2 (display face), .dc-code (mono) — and
  // compare them to the same string rendered by the HOST with the app's own stacks.
  const faceRow = async (sel, hostFamily) => {
    const hostW = await page.evaluate((fam) => {
      const el = document.createElement('span');
      el.textContent = 'Ceyrek okumasi WWW';
      el.style.cssText = 'position:absolute;left:-9999px;white-space:pre';
      el.style.font = fam;
      document.body.appendChild(el);
      const w = +el.getBoundingClientRect().width.toFixed(1); el.remove(); return w;
    }, hostFamily);
    const out = {};
    for (const id of ['before', 'after']) {
      out[id] = await page.frameLocator(`#${id}`).locator(sel).first().evaluate((el, fam) => {
        const cs = getComputedStyle(el);
        const probe = document.createElement('span');
        probe.textContent = 'Ceyrek okumasi WWW';
        probe.style.cssText = 'position:absolute;left:-9999px;white-space:pre';
        probe.style.font = fam;
        probe.style.fontFamily = cs.fontFamily;
        document.body.appendChild(probe);
        const w = +probe.getBoundingClientRect().width.toFixed(1); probe.remove(); return w;
      }, hostFamily);
    }
    return { hostW, ...out };
  };
  const FACES = [
    ['gövde  (.dc-p)', '.dc-p', "700 40px 'Inter',ui-sans-serif,system-ui,sans-serif"],
    ['başlık (.dc-h2)', '.dc-h2', "700 40px 'Plus Jakarta Sans','Inter',ui-sans-serif,system-ui,sans-serif"],
    ['kod    (.dc-code)', '.dc-code', "400 40px 'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace"],
  ];
  console.log('    ── yüzler (host / before / after) ──');
  for (const [label, sel, fam] of FACES) {
    const r = await faceRow(sel, fam);
    const mark = (v) => (Math.abs(v - r.hostW) < 1 ? '✓' : '✗');
    console.log(`    ${label.padEnd(19)} ${String(r.hostW).padEnd(8)} ${String(r.before).padEnd(7)}${mark(r.before)}  ${String(r.after).padEnd(7)}${mark(r.after)}`);
  }

  const path = join(OUT, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  shots.push(path);

  const row = (k, v) => `    ${k.padEnd(26)} ${v}`;
  console.log(`\n── ${name} (pane ${width}px) ─────────────────────────────────`);
  console.log(row('transcript', `${measured.transcriptSize}px / ${measured.transcriptLine}px line / face ${hostFace.toFixed(1)}px`));
  for (const id of ['before', 'after']) {
    const m = inFrame[id];
    const same = Math.abs(m.size - measured.transcriptSize) < 0.51
      && Math.abs(m.line - measured.transcriptLine) < 1.01
      && Math.abs(m.faceWidth - hostFace) < 2;
    console.log(row(id.toUpperCase(), `${m.size}px / ${m.line}px line / face ${m.faceWidth.toFixed(1)}px  ${same ? '✓ matches' : '✗ differs'}`));
  }
  await page.close();
}

const browser = await chromium.launch();
try {
  // 760px: the chat pane at a comfortable window. 380px: the pane with the slide-over open,
  // which is where the owner's clipped-number screenshot came from.
  await shoot(browser, 760, 'wide');
  await shoot(browser, 380, 'narrow');
} finally {
  await browser.close();
}

console.log(`\nscreenshots:\n${shots.map((s) => `  ${s}`).join('\n')}\n`);
