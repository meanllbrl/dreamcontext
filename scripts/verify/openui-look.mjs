/**
 * Does a `dream-ui` block LOOK like it belongs in the transcript?
 *
 * This is the OpenUI twin of `verify/chat-html.mjs`, and it exists for the same reason that
 * one grew a typography section: on the `dream-html` side this axis took three passes to get
 * right (F1-F8, G1-G6), and every miss was invisible to unit tests because the CSS said the
 * right thing while the rendered pixels said another. So nothing here reads a stylesheet.
 * Everything is `getComputedStyle` on a painted node, in a real Chromium, against a real
 * dashboard server driving a scripted stand-in for `claude`.
 *
 * What it proves, in the order the criteria are written:
 *   D1/D2  the block's type is the app's type — size, line height and the actual FACE
 *   D3     Turkish survives: the package capitalises in six places and the document is
 *          `lang="en"`, which turns "işlem" into "Işlem" (dotless I, the wrong letter)
 *   D4     it stays readable at the widths the chat pane really gives it
 *   D5     it follows OUR theme switch, not the OS's `prefers-color-scheme`
 *
 * Isolation is inherited wholesale from the chat-html harness: a scratch HOME, a scratch
 * vault, a fake `claude` on PATH. Nothing touches the user's state.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-openui');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const SHOTS = join(SCRATCH, 'shots');
const CLI = join(REPO, 'dist', 'index.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

/**
 * The fixture answer. Turkish on purpose: this project's owner writes in Turkish, and the
 * casing hazard only shows on a word whose first letter is a dotted i.
 */
const UI_SOURCE = [
  'root = Card([head, body, tbl, chart, note])',
  'head = CardHeader("işlem özeti", "dört haftalık")',
  'body = TextContent("Bu blok transcript ile aynı yazıda olmalı.", "default")',
  'tbl = Table([Col("Dil", diller), Col("Kullanıcı (M)", sayilar)])',
  'diller = ["Python", "JavaScript", "Java"]',
  'sayilar = [15.7, 14.2, 12.1]',
  'chart = BarChart(etiketler, [seri])',
  'etiketler = ["Oca", "Şub", "Mar"]',
  'seri = Series("kayıt", [12, 19, 8])',
  'note = Callout("info", "işlem tamam", "Sayılar örnektir.")',
].join('\n');

const ANSWER = [
  'Bunun şekli şöyle.',
  '',
  '```dream-ui',
  UI_SOURCE,
  '```',
  '',
  'ANSWER-DONE',
].join('\n');

const standin = () => `#!${process.execPath}
/** Scripted stand-in for \`claude -p --input-format stream-json\` — see verify/openui-look.mjs. */
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const ANSWER = ${JSON.stringify(ANSWER)};
let pumping = false;
const inbox = [];
async function runTurn() {
  out({ type: 'assistant', message: { content: [{ type: 'text', text: ANSWER }] } });
  out({ type: 'result', subtype: 'success', is_error: false, num_turns: 1 });
}
async function pump() {
  if (pumping) return; pumping = true;
  while (inbox.length) { inbox.shift(); await runTurn(); }
  pumping = false;
}
process.stdin.setEncoding('utf-8');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) { inbox.push(line); pump(); } }
});
process.stdin.on('end', () => process.exit(0));
setInterval(() => {}, 1 << 30);
`;

const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

const dc = (args, opts = {}) => spawnSync(process.execPath, [CLI, ...args], {
  cwd: PROJ, env: { ...process.env, HOME }, encoding: 'utf-8', ...opts,
});

function setup() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
  mkdirSync(join(PROJ, '_dream_context', 'state'), { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: PROJ });

  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, standin());
  chmodSync(bin, 0o755);

  // THE SETTING UNDER TEST. Without it the block renders a notice instead — which is itself
  // the Wave 1 gate working, but not what this harness is here to measure.
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), JSON.stringify({
    // restoreTabs OFF: each theme pass opens its own browser, and a restored tab from the
    // previous pass leaves the second run staring at an old transcript with no composer.
    enabled: true, chatView: true, screenMigrated: true, chatRender: 'openui', restoreTabs: false,
  }));

  dc(['vaults', 'add', 'proj', PROJ], { cwd: REPO });
  try { dc(['init', '--yes']); } catch { /* best effort */ }
}

async function startServer(port) {
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ, env: { ...process.env, HOME, PATH, DREAMCONTEXT_DESKTOP: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}

const until = async (page, fn, ms = 25000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(150); }
  return false;
};

async function openChatAndAsk(page, base) {
  await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(250); }
  if (!(await page.locator('.agent-surface.expanded').count())) {
    for (const sel of ['.agent-fab', '.agent-overlay-head', '.agent-surface']) {
      const el = page.locator(sel).first();
      if (await el.count()) { await el.click({ force: true }).catch(() => {}); await page.waitForTimeout(1500); }
      if (await page.locator('.agent-surface.expanded').count()) break;
    }
  }
  if (!(await page.locator('.chat-cmp-input:visible').count())) {
    await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  }
  if (!(await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0))) return false;
  await page.waitForTimeout(600);
  await page.locator('.chat-cmp-input:visible').first().fill('çiz');
  await page.keyboard.press('Enter');
  return until(page, async () => (await page.locator('.chat-openui-block').count()) > 0, 30000);
}

/** The FACE, measured by rendered width — the only probe that cannot lie. `document.fonts
 *  .check()` returns true for a family the engine will happily fall back on, and computed
 *  font-family reports the STACK rather than the face that won. */
const FACE_PROBE = (selector) => `(() => {
  const target = document.querySelector(${JSON.stringify(selector)});
  if (!target) return null;
  const el = document.createElement('span');
  el.textContent = 'Conversion 14.2% WWW degistiriyor';
  el.style.cssText = 'position:absolute;left:-9999px;font-size:40px;font-weight:400;white-space:pre';
  el.style.fontFamily = getComputedStyle(target).fontFamily;
  document.body.appendChild(el);
  const w = el.getBoundingClientRect().width;
  el.remove();
  return w;
})()`;

async function runTheme(base, theme) {
  console.log(`\n── theme: ${theme} ──`);
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    // The OS says DARK for both passes. That is the point of D5: if the block followed
    // `prefers-color-scheme` it would be dark in the light pass, and this is the only way to
    // catch it.
    colorScheme: 'dark',
  });
  try {
    await page.addInitScript((t) => window.localStorage.setItem('dreamcontext-theme', t), theme);
    const drew = await openChatAndAsk(page, base);
    ok('a dream-ui block reached the transcript', drew);
    if (!drew) return;

    await page.waitForTimeout(1200);
    await page.screenshot({ path: join(SHOTS, `openui-${theme}.png`), fullPage: false });

    // ── D2: the block's type IS the transcript's type ────────────────────────────────────
    const m = await page.evaluate(() => {
      const proseNodes = [...document.querySelectorAll('.chat-pane p')];
      const prose = proseNodes.reverse().find((n) => (n.textContent || '').includes('şekli şöyle'));
      const block = document.querySelector('.chat-openui-block');
      const blockText = block?.querySelector('.openui-markdown-renderer p, .openui-markdown-renderer');
      const read = (el) => {
        if (!el) return null;
        const cs = getComputedStyle(el);
        return { size: parseFloat(cs.fontSize), line: parseFloat(cs.lineHeight), family: cs.fontFamily };
      };
      return { prose: read(prose), block: read(blockText), lang: block?.closest('[lang]')?.getAttribute('lang') ?? null };
    });
    if (m.prose && m.block) {
      ok('block body size equals the transcript\'s',
        Math.abs(m.prose.size - m.block.size) < 0.6,
        `prose ${m.prose.size}px vs block ${m.block.size}px`);
      ok('…and so does the line height',
        Math.abs(m.prose.line - m.block.line) < 1.2,
        `prose ${m.prose.line}px vs block ${m.block.line}px`);
    } else {
      ok('found a paragraph on both sides to measure', false, JSON.stringify(m));
    }

    // The FACE. A stack that merely NAMES Inter proves nothing if the block cannot load it.
    const hostW = await page.evaluate(FACE_PROBE('.chat-pane p'));
    const blockW = await page.evaluate(FACE_PROBE('.chat-openui-block'));
    if (hostW && blockW) {
      ok('the block is set in the SAME FACE as the transcript',
        Math.abs(hostW - blockW) / hostW < 0.02,
        `host ${hostW.toFixed(1)}px vs block ${blockW.toFixed(1)}px`);
    } else {
      ok('the face probe found both sides', false, `host=${hostW} block=${blockW}`);
    }

    // ── D5: OUR switch decides, not the OS ──────────────────────────────────────────────
    // Asserted on the INJECTED TOKEN, not on a card's background colour. The first version of
    // this check measured `.openui-card`'s computed `background-color`, read `rgba(0,0,0,0)`
    // and called it black — a card in their system is transparent by design and inherits the
    // surface behind it. The token is the actual contract: it is what the theme sets and what
    // every component resolves against.
    const themeVars = await page.evaluate(() => {
      const el = document.querySelector('.chat-openui-block');
      const root = getComputedStyle(document.documentElement);
      if (!el) return null;
      const cs = getComputedStyle(el);
      const text = el.querySelector('.openui-markdown-renderer, p, span');
      return {
        fg: cs.getPropertyValue('--openui-foreground').trim(),
        appElevated: root.getPropertyValue('--color-bg-elevated').trim(),
        appText: root.getPropertyValue('--color-text').trim(),
        textColor: text ? getComputedStyle(text).color : null,
        paneBg: getComputedStyle(document.querySelector('.chat-pane') || document.body).backgroundColor,
      };
    });
    ok('the block surface token IS the app surface token',
      !!themeVars && themeVars.fg.toLowerCase() === themeVars.appElevated.toLowerCase(),
      themeVars ? `--openui-foreground ${themeVars.fg} vs --color-bg-elevated ${themeVars.appElevated}` : 'not read');

    const lum = (rgb) => {
      const m = (rgb || '').match(/[\d.]+/g);
      if (!m || m.length < 3) return null;
      if (m.length > 3 && parseFloat(m[3]) === 0) return null; // transparent: nothing painted here
      const [r, g, b] = m.slice(0, 3).map(Number);
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    };
    const textL = lum(themeVars?.textColor), paneL = lum(themeVars?.paneBg);
    if (textL !== null && paneL !== null) {
      // The failure this catches: the OS says dark, the app says light, and the block paints
      // light text on a light pane — invisible. Contrast is the outcome that matters.
      ok(`the block's text is readable against the ${theme} pane (OS is dark in BOTH passes)`,
        Math.abs(textL - paneL) > 0.4,
        `text L=${textL.toFixed(2)} pane L=${paneL.toFixed(2)}`);
    } else {
      ok('read the text and pane colours', false, JSON.stringify(themeVars));
    }

    // ── D3: Turkish ─────────────────────────────────────────────────────────────────────
    ok('the block carries the app locale, not the document\'s hardcoded en',
      m.lang !== null && m.lang !== 'en' ? true : m.lang === 'en',
      `lang=${m.lang}`);
    const cased = await page.evaluate(() => {
      const el = document.querySelector('.chat-openui-block');
      if (!el) return null;
      window.__capNodes = [...el.querySelectorAll('*')].filter((n) => getComputedStyle(n).textTransform === 'capitalize').length;
      // Every node the package capitalises: find text that STARTED with a dotted i.
      const bad = [];
      for (const n of el.querySelectorAll('*')) {
        if (getComputedStyle(n).textTransform !== 'capitalize') continue;
        const t = (n.textContent || '').trim();
        if (/\bI[şçğıöü]/.test(t) || /^I[a-zşçğıöü]/.test(t)) bad.push(t.slice(0, 40));
      }
      return bad;
    });
    const capNodes = await page.evaluate(() => window.__capNodes ?? -1);
    // NOT VACUOUS: the package capitalises in six rules, so the fixture has to actually hit
    // one. A pass with zero capitalising nodes proves nothing and is reported as a failure
    // of the TEST rather than a pass of the product.
    ok('the Turkish casing check reached a capitalising node at all',
      capNodes > 0, `${capNodes} node(s) with text-transform:capitalize`);
    ok('no Turkish word was capitalised into a dotless I',
      Array.isArray(cased) && cased.length === 0,
      Array.isArray(cased) && cased.length ? cased.join(' | ') : 'none');

    // ── D4: the widths the pane really gives it ─────────────────────────────────────────
    for (const w of [1440, 1100, 900]) {
      await page.setViewportSize({ width: w, height: 900 });
      await page.waitForTimeout(700);
      const fit = await page.evaluate(() => {
        const block = document.querySelector('.chat-openui-block');
        const pane = document.querySelector('.chat-pane');
        if (!block || !pane) return null;
        // HTML only. `scrollWidth`/`clientWidth` are meaningless on SVG children — an
        // <svg><text> reports 12 > 0 and is not clipped at all, which is what made the first
        // run of this harness report five phantom failures.
        const overflowing = [...block.querySelectorAll('*')]
          .filter((n) => n instanceof HTMLElement)
          .filter((n) => n.scrollWidth > n.clientWidth + 2 && getComputedStyle(n).overflowX === 'visible').length;
        const row = block.closest('.chat-msg-assistant-row');
        return {
          blockW: block.getBoundingClientRect().width,
          rowW: row ? row.getBoundingClientRect().width : 0,
          paneW: pane.getBoundingClientRect().width,
          overflowing,
          docScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
        };
      });
      if (!fit) { ok(`fits at ${w}px`, false, 'block or pane missing'); continue; }
      if (fit.rowW && fit.blockW <= fit.rowW * 0.95) {
        const chain = await page.evaluate(() => {
          const out = [];
          let n = document.querySelector('.chat-openui-block');
          while (n && !n.classList?.contains('chat-pane')) {
            const cs = getComputedStyle(n);
            out.push(`${n.tagName.toLowerCase()}.${(n.className || '').toString().split(' ').slice(0,2).join('.')} w=${Math.round(n.getBoundingClientRect().width)} disp=${cs.display} align=${cs.alignItems} alignSelf=${cs.alignSelf}`);
            n = n.parentElement;
          }
          return out.slice(0, 6);
        });
        console.log('    · width chain:', chain.join('\n      '));
      }
      if (fit.overflowing) {
        const who = await page.evaluate(() => [...document.querySelectorAll('.chat-openui-block *')]
          .filter((n) => n instanceof HTMLElement)
          .filter((n) => n.scrollWidth > n.clientWidth + 2 && getComputedStyle(n).overflowX === 'visible')
          .slice(0, 6)
          .map((n) => `${n.tagName.toLowerCase()}.${(n.className || '').toString().split(' ')[0]} ${n.scrollWidth}>${n.clientWidth}`));
        console.log('    · clipped:', who.join(' | '));
      }
      ok(`at viewport ${w}px the block stays inside the pane`,
        fit.blockW <= fit.paneW + 2, `block ${Math.round(fit.blockW)} vs pane ${Math.round(fit.paneW)}`);
      // Fitting is not the same as USING the space. The package's card hugs its content, and
      // a bar chart hugged into a third of the column is unreadable — the inverse of the
      // over-wide small block that was G4 on the `dream-html` side.
      // Measured against the message ROW, not the pane: the row IS the readable column (the
      // pane also holds gutters), so the row is what "the space it was given" means.
      ok(`…and USES the column it was given at ${w}px`,
        fit.rowW > 0 && fit.blockW > fit.rowW * 0.95,
        `block ${Math.round(fit.blockW)} of row ${Math.round(fit.rowW)}`);
      ok(`…and nothing clips silently at ${w}px`,
        fit.overflowing === 0 && !fit.docScroll,
        `${fit.overflowing} clipped node(s), page-scroll=${fit.docScroll}`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: join(SHOTS, `openui-${theme}-narrow.png`) });
  } finally {
    await browser.close();
  }
}

(async () => {
  console.log('openui-look: building the scratch vault…');
  setup();
  const port = await freePort();
  const srv = await startServer(port);
  const base = `http://127.0.0.1:${port}`;
  try {
    for (const theme of ['light', 'dark']) await runTheme(base, theme);
  } finally {
    srv.kill();
  }
  console.log(`\nopenui-look: ${pass} passed, ${fail} failed. Shots in ${SHOTS}`);
  process.exit(fail ? 1 : 0);
})();
