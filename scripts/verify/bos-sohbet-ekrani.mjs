#!/usr/bin/env node
/**
 * Boş Chat sayfası (sohbet açık değil): eski "Chat — real Claude Code" ekranı yok; yerinde Super
 * karşılaması (işaret, tek soru, öneri çipleri) ve gerçek composer var; terminal ve geçmiş sohbetler
 * tek tık uzakta. 1440x900 ve 390x844, açık ve koyu. Ölçer: eski metin yok, başlık ve çipler var,
 * composer yazılabilir, ikincil satırın yazısı AA geçer, yatay taşma yok, console hatası yok.
 * Sonra bir mesaj yazılıp gönderilir: karşılama gider, bir sohbet sekmesi açılır.
 *
 *   SHOT_OUT=<dir> dreamcontext builder heavy -- node scripts/verify/bos-sohbet-ekrani.mjs
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { openApp } from './lib/app.mjs';
import { markAnnouncementsSeen, setTheme } from './lib/measure.mjs';

const OUT = process.env.SHOT_OUT ?? null;
if (OUT) mkdirSync(OUT, { recursive: true });
const app = await openApp({ suite: 'bos-sohbet-ekrani' });
const browser = await chromium.launch();
const SIZES = [{ name: 'desktop', width: 1440, height: 900 }, { name: 'phone', width: 390, height: 844 }];

const lum = (rgb) => {
  const [r, g, b] = rgb.map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

try {
  for (const theme of ['light', 'dark']) for (const s of SIZES) {
    const context = await browser.newContext({ viewport: { width: s.width, height: s.height }, colorScheme: theme });
    await setTheme(context, theme);
    await markAnnouncementsSeen(context, app.base);
    const page = await context.newPage();
    const where = `${s.name} ${theme}`;
    page.on('console', (m) => { if (m.type() === 'error' && !/\/@vite\/|favicon|\/ws\b|WebSocket/.test(m.text())) app.findings.push(`${where} console: ${m.text().slice(0, 200)}`); });
    page.on('pageerror', (e) => app.findings.push(`${where} crash: ${String(e.message).slice(0, 200)}`));
    page.on('response', (r) => { if (r.status() >= 400) process.stdout.write(`${where} ${r.status()} ${new URL(r.url()).pathname}\n`); });
    await page.goto(`${app.base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    if (s.name === 'phone') {
      // The phone has its own empty chat (one line + New chat): only that the old text is gone.
      await page.waitForTimeout(1500);
    } else {
      const seen = await page.locator('[data-testid="chat-landing"]').waitFor({ state: 'visible', timeout: 20_000 }).then(() => true, () => false);
      if (!seen) app.findings.push(`${where}: the landing is not on the page`);
    }
    const m = await page.evaluate(() => {
      const land = document.querySelector('[data-testid="chat-landing"]');
      const title = land?.querySelector('.chat-banner-empty-title');
      const chips = land ? [...land.querySelectorAll('.chat-banner-chip')].map((c) => c.textContent) : [];
      const more = land ? [...land.querySelectorAll('.chat-banner-more-btn')] : [];
      const ta = land?.querySelector('textarea');
      const bg = (el) => {
        for (let e = el; e; e = e.parentElement) {
          const c = getComputedStyle(e).backgroundColor;
          const v = c.match(/[\d.]+/g)?.map(Number) ?? [];
          if (v.length >= 3 && (v.length < 4 || v[3] > 0.9)) return v.slice(0, 3);
        }
        return [255, 255, 255];
      };
      const fg = (el) => getComputedStyle(el).color.match(/[\d.]+/g).map(Number).slice(0, 3);
      return {
        old: document.body.innerText.includes('real Claude Code'),
        title: title?.textContent ?? null,
        chips,
        more: more.map((b) => ({ text: b.textContent, fg: fg(b), bg: bg(b), h: Math.round(b.getBoundingClientRect().height) })),
        composer: !!ta && !ta.disabled,
        composerTop: ta ? Math.round(ta.getBoundingClientRect().top) : null,
        over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    if (m.old) app.findings.push(`${where}: "real Claude Code" is still on the page`);
    if (m.over > 1) app.findings.push(`${where}: overflows sideways by ${m.over}px`);
    if (s.name === 'desktop') {
      if (!m.title?.includes('proj')) app.findings.push(`${where}: title is ${JSON.stringify(m.title)}`);
      if (m.chips.length < 2) app.findings.push(`${where}: ${m.chips.length} chips`);
      if (!m.composer) app.findings.push(`${where}: no writable composer`);
      if (m.composerTop == null || m.composerTop > s.height) app.findings.push(`${where}: composer below the fold (${m.composerTop})`);
      for (const b of m.more) {
        const r = ratio(b.fg, b.bg);
        if (r < 4.5) app.findings.push(`${where}: "${b.text}" contrast ${r.toFixed(2)}`);
        if (b.h < 24) app.findings.push(`${where}: "${b.text}" is ${b.h}px tall`);
      }
      process.stdout.write(`${where}: title=${JSON.stringify(m.title)} chips=${m.chips.length} more=${m.more.map((b) => `${b.text}(${ratio(b.fg, b.bg).toFixed(1)}:1,${b.h}px)`).join(' ')} composerTop=${m.composerTop}\n`);
    } else {
      process.stdout.write(`${where}: old=${m.old} over=${m.over}\n`);
    }
    const file = join(app.shots, `sonra-${s.name}-${theme}.png`);
    await page.screenshot({ path: file });
    if (OUT) copyFileSync(file, join(OUT, `sonra-${s.name}-${theme}.png`));
    await context.close();
  }
  {
    const s = SIZES[0];
    const where = 'send';
    const context = await browser.newContext({ viewport: { width: s.width, height: s.height } });
    await markAnnouncementsSeen(context, app.base);
    const page = await context.newPage();
    await page.goto(`${app.base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-testid="chat-landing"]').waitFor({ state: 'visible', timeout: 20_000 });
      // Typing and sending starts a real chat: the landing leaves and a chat tab is on screen.
      const ta = page.locator('[data-testid="chat-landing"] textarea').first();
      await ta.fill('hello');
      await ta.press('Enter');
      const gone = await page.locator('[data-testid="chat-landing"]').waitFor({ state: 'detached', timeout: 10_000 }).then(() => true, () => false);
      if (!gone) app.findings.push(`${where}: the landing stayed after sending`);
      const tab = await page.locator('.agent-pane-chat').first().waitFor({ state: 'attached', timeout: 10_000 }).then(() => true, () => false);
      if (!tab) app.findings.push(`${where}: no chat pane after sending`);
      const blank = await page.getByText('Say something to start').isVisible().catch(() => false);
      if (blank) app.findings.push(`${where}: the new chat says "Say something to start" over the message it holds`);
      process.stdout.write(`${where}: send -> landing gone=${gone} chat pane=${tab}\n`);
      const sent = join(app.shots, 'sonra-gonderince.png');
      await page.waitForTimeout(1200);
      await page.screenshot({ path: sent });
      if (OUT) copyFileSync(sent, join(OUT, 'sonra-gonderince.png'));
    await context.close();
  }
} catch (err) {
  app.findings.push(`could not finish: ${err instanceof Error ? err.message : err}`);
}
await browser.close();
process.exit(await app.finish());
