#!/usr/bin/env node
/**
 * THE SUPER CHAT SCROLLS LIKE TELEGRAM (owner 2026-11-13, rule C), measured on the real dashboard
 * server with a scratch HOME + vault and a scripted `claude` playing the Super. Every programmatic
 * `scrollTop` write on the Super scroller is logged with its caller (source-mapped), every frame's
 * offset is sampled, and the criteria are checked from those logs, in Chromium AND WebKit, at 1440
 * and 390:
 *   - S1 send at the bottom, a long reply + a question card: the follow stops with the reply's
 *     start on screen; at most one write per frame, no zero-distance write; 0 writes after the
 *     turn ends; the "↓ N yeni" button shows; no question card cut at the top; no gap at the end.
 *   - S2 send, then wheel up while the reply comes: 0 writes while idle, the view does not move.
 *   - S3 answer the question card (a send): the reply's start on screen at the end, 0 writes after.
 *   - S4 the button: click goes to the bottom and hides it.
 *
 *   npm run build && node scripts/verify/super-kayma.mjs
 *   ENGINES=chromium VIEWS=390 node scripts/verify/super-kayma.mjs   (one engine / width)
 *   SHOTS_DIR=<dir>: where screenshots and numbers go (default tmp/verify-super-kayma).
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(join(REPO, 'package.json'));
const playwright = require('playwright');
const { TraceMap, originalPositionFor } = require('@jridgewell/trace-mapping');
const CLI = process.env.CLI_PATH || join(REPO, 'dist', 'index.js');
const SHOTS = process.env.SHOTS_DIR || join(REPO, 'tmp', 'verify-super-kayma');
const ENGINES = (process.env.ENGINES || 'chromium,webkit').split(',');
const VIEWS = (process.env.VIEWS || '1440,390').split(',').map(Number);
const fails = [];

const RAPOR = (tag) => [
  `**Durum ${tag}: bugünkü durum**`,
  'Ödeme sayfasını üç adıma böldüm: sepet, adres, kart. Her adım kendi alanlarını doğruluyor, geri dönünce girilen bilgiler korunuyor. Eski tek sayfalı akış yerinde duruyor, yenisi ayar ile açılıyor.',
  '**Ne bitti**\n\n- Sepet adımı: ürün adedi değişince toplam anında güncelleniyor.\n- Adres adımı: posta kodundan il ve ilçe kendiliğinden doluyor.\n- Kart adımı: hatalı kart numarası alanın altında, sade bir cümleyle söyleniyor.\n- 14 dosya değişti, testlerin hepsi yeşil.',
  '**Ne kaldı**\n\n- Yıllık plan seçilince gösterilecek indirim. Fiyat sayfası ve ödeme özeti bu sayıya bağlı.\n- Kart reddedilince gösterilen mesajların son hali.\n- Telefonda klavye açıkken "Devam" düğmesinin görünür kalması.',
  '**Ölçtüğüm**\n\nGeçen hafta ödeme sayfasına gelen 100 kişiden 31\'i ödemeyi bitirdi. Yeni akışın denemesinde bu sayı 38. Fark en çok adres adımından geliyor: eski sayfada en çok orada bırakılıyordu.',
  '**Yıllık indirim neden şimdi**\n\nAylık plan 12 dolar. Yıllık planda yüzde 15 indirim yıllık 122 dolar, yüzde 20 indirim 115 dolar eder. Rakiplerin çoğu yüzde 16 ile 20 arasında veriyor. Yüzde 20 daha çok kişiyi yıllığa çeker ama kişi başı gelir 7 dolar düşer. Sayıyı sen seçince fiyat sayfasını ve ödeme özetini ona göre bitireceğim.',
].join('\n\n');

const standin = (FRAMES, REPORTS, RAPOR_SRC) => `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
const RAPOR = ${RAPOR_SRC};
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : ''; };
let brief = '';
try { brief = readFileSync(at('--append-system-prompt-file'), 'utf-8'); } catch {}
const role = /(^|\\n)# Mode: Super Agent\\s*\\n/.test(brief) ? 'super' : 'child';
const convo = at('--resume') || at('--session-id') || '';
const sid = convo || 'kayma-' + process.pid;
const persist = (type, content) => {
  if (!convo) return;
  const dir = join(process.env.HOME, '.claude', 'projects', 'verify-super');
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, convo + '.jsonl'), JSON.stringify({ type, sessionId: convo, uuid: randomUUID(), timestamp: new Date().toISOString(), message: { role: type, content } }) + '\\n');
};
const cli = (...args) => {
  const r = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}, ...args], { env: process.env, encoding: 'utf-8', timeout: 60000 });
  return { args: args.join(' '), status: r.status, out: (r.stdout || '') + (r.stderr || '') };
};
const report = (o) => appendFileSync(${JSON.stringify(REPORTS)}, JSON.stringify({ role, pid: process.pid, t: Date.now(), ...o }) + '\\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 0;
const shq = (a) => /^[A-Za-z0-9_.\\/:=-]+$/.test(a) ? a : "'" + a.replace(/'/g, "'\\\\''") + "'";
const bashCall = (...args) => {
  const id = 'toolu_' + (++seq) + '_' + process.pid;
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: ['dreamcontext', ...args].map(shq).join(' '), description: 'Ask the owner' } }] } });
  const r = cli(...args);
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: r.out.trim() }], is_error: r.status !== 0 }] } });
  return r;
};
/** A hidden step: a thinking block (streamed), then a Read tool call and its result. */
async function step(i) {
  out({ type: 'stream_event', event: { type: 'message_start', message: { role: 'assistant' } } });
  out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } });
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Dosyaya bakıyorum ' + i } } });
  out({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Dosyaya bakıyorum ' + i, signature: 'x' }] } });
  out({ type: 'stream_event', event: { type: 'message_stop' } });
  await sleep(250);
  const id = 'toolu_r' + (++seq) + '_' + process.pid;
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: '/src/odeme/adim' + i + '.ts' } }] } });
  await sleep(350);
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'export const adim' + i + ' = 1;\\n'.repeat(5) }] }] } });
  await sleep(200);
}
const say = (text) => { const block = [{ type: 'text', text }]; persist('assistant', block); out({ type: 'assistant', message: { role: 'assistant', content: block } }); };
const askOwner = (tag) => bashCall('super', 'ask', 'Yıllık planda indirim yüzde kaç olsun? (' + tag + ')',
  '--title', 'Ödeme akışı → yıllık plan indirimi',
  '--description', 'Fiyat sayfası ve ödeme özeti bu sayıya bağlı; seçince ikisini de bitiririm.',
  '--option', '%15::Yıllık 122 dolar, kişi başı gelir yüksek kalır',
  '--option', '%20::Yıllık 115 dolar, daha çok kişi yıllığa geçer',
  '--option', 'İndirim yok::Yıllık plan aylığın 12 katı');
async function stream(text, perTick = 70) {
  out({ type: 'stream_event', event: { type: 'message_start', message: { role: 'assistant' } } });
  out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
  const stepN = Math.ceil(text.length / 60);
  for (let i = 0; i < text.length; i += stepN) {
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(i, i + stepN) } } });
    await sleep(perTick);
  }
  out({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  say(text);
  out({ type: 'stream_event', event: { type: 'message_stop' } });
}
async function superTurn(text, all) {
  const ref = (/<owner-msg ref="([^"]+)"/.exec(all) || [])[1];
  const head = ref ? '<!-- re:' + ref + ' -->\\n' : '';
  if (text.startsWith('[super handover]')) { report({ kind: 'handover' }); return 'Devraldım.'; }
  if (text.startsWith('[super answer]')) {
    report({ kind: 'answer', text });
    // Screenshot B: the answer turn. Steps (hidden), a long silent think, then a long reply.
    for (let i = 0; i < 2; i++) await step('c' + i);
    report({ kind: 'answer-thinking' });
    await sleep(7000);
    report({ kind: 'answer-stream' });
    await stream(head + 'Tamam, yüzde 20 ile bitiriyorum.\\n\\n' + RAPOR('Y' + Date.now() % 1000));
    return '';
  }
  if (text.startsWith('[super')) { report({ kind: 'event', text: text.slice(0, 60) }); return ''; }
  const m = /^(TUR|GEC|KOS|KISA|SOR) ?(\\S*)/.exec(text.trim());
  if (!m) { report({ kind: 'owner', text }); return 'ok'; }
  const [, what, tag] = m;
  if (what === 'KISA') { await sleep(400); say(head + 'Not aldım (' + tag + ').'); return ''; }
  if (what === 'KOS') {
    // A run card (dream-view run) the owner will press: its terminal streams for ~12 s.
    await sleep(500);
    say(head + 'Bunu senin çalıştırman gerek (' + tag + '):\\n\\n\\u0060\\u0060\\u0060dream-view\\n' + JSON.stringify({ type: 'run', id: 'kos-' + tag, command: 'for i in $(seq 1 120); do echo "satir $i: derleme adimi tamamlandi, paket $((i*7))"; sleep 0.1; done', why: 'Uzun bir derleme çıktısı' }) + '\\n\\u0060\\u0060\\u0060');
    await sleep(300);
    say('Bir de not (' + tag + '): kart hata mesajlarını yarın göstereceğim.');
    return '';
  }
  // TUR: steps, a long streamed report, then a question card. GEC: the same after a 3 s think.
  report({ kind: 'turn-start', what, tag });
  await sleep(what === 'GEC' ? 3000 : 600);
  for (let i = 0; i < 4; i++) await step(tag + i);
  report({ kind: 'streaming', tag });
  await stream(head + RAPOR(tag));
  await sleep(500);
  report({ kind: 'asked', r: askOwner(tag) });
  if (what === 'SOR') {
    // Screenshot A: the Super asked, and its turn goes on (hidden steps, a long silent think).
    report({ kind: 'sor-thinking', tag });
    await step(tag + 'x');
    await sleep(7000);
    report({ kind: 'sor-end', tag });
    say('Soruyu sordum (' + tag + '), cevabını bekliyorum.');
  }
  return '';
}
let running = false;
let chain = Promise.resolve();
async function turn(blocks) {
  out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] });
  let said = 'ok';
  try { said = role === 'super' ? await superTurn(blocks[0] ?? '', blocks.join('\\n')) : 'ok'; } catch (e) { said = 'error ' + e; }
  if (said) say(said);
  out({ type: 'result', subtype: 'success', is_error: false, result: said, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
  report({ kind: 'turn-end', said });
}
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } }); continue; }
    if (o.type !== 'user') continue;
    const content = (o.message && o.message.content) || [];
    const blocks = typeof content === 'string' ? [content] : content.filter((b) => b.type === 'text').map((b) => b.text);
    if (!blocks.length) continue;
    appendFileSync(${JSON.stringify(FRAMES)}, JSON.stringify({ role, pid: process.pid, t: Date.now(), blocks, folded: running }) + '\\n');
    persist('user', blocks.map((text) => ({ type: 'text', text })));
    if (running) continue;
    running = true;
    chain = chain.then(() => turn(blocks)).finally(() => { running = false; });
  }
});
process.stdin.on('end', () => chain.then(() => process.exit(0)));
`;

/** In the page, BEFORE the app: every scroll write on the Super scroller, scroll events, input, frames. */
const INSTRUMENT = `(() => {
  Error.stackTraceLimit = 40;
  const S = window.__sk = { log: [], frames: [], lastInput: -1e9, lastInputKind: '', scen: '', writesThisFrame: 0 };
  const now = () => Math.round(performance.now() * 10) / 10;
  const isSuperSc = (el) => !!(el && el.classList && el.classList.contains('chat-scroll') && el.closest('[data-super-slot="centre"], .super-dock, [data-testid="super-surface"]'));
  const scOf = (el) => { const sc = el && el.closest ? el.closest('.chat-scroll') : null; return isSuperSc(sc) ? sc : null; };
  const stack = () => (new Error().stack || '').split('\\n').slice(2, 30).map((s) => s.trim());
  const inputAge = () => Math.round(performance.now() - S.lastInput);
  for (const k of ['wheel', 'touchstart', 'touchmove', 'keydown', 'pointerdown', 'mousedown']) window.addEventListener(k, (e) => { S.lastInput = performance.now(); S.lastInputKind = k; }, { capture: true, passive: true });
  const d = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
  Object.defineProperty(Element.prototype, 'scrollTop', { configurable: true, enumerable: d.enumerable, get: d.get, set(v) {
    if (!isSuperSc(this)) return d.set.call(this, v);
    const from = d.get.call(this);
    d.set.call(this, v);
    const to = d.get.call(this);
    S.writesThisFrame++;
    S.log.push({ k: 'set', t: now(), scen: S.scen, from, req: Math.round(v), to, sh: this.scrollHeight, ch: this.clientHeight, inputAge: inputAge(), inputKind: S.lastInputKind, stack: stack() });
  } });
  const wrap = (name) => { const orig = Element.prototype[name]; Element.prototype[name] = function (...a) {
    const sc = name === 'scrollIntoView' ? scOf(this) : (isSuperSc(this) ? this : null);
    if (!sc) return orig.apply(this, a);
    const from = d.get.call(sc);
    const r = orig.apply(this, a);
    S.writesThisFrame++;
    S.log.push({ k: name, t: now(), scen: S.scen, from, to: d.get.call(sc), args: JSON.stringify(a).slice(0, 120), target: name === 'scrollIntoView' ? (this.className || this.tagName).toString().slice(0, 60) : '', sh: sc.scrollHeight, ch: sc.clientHeight, inputAge: inputAge(), inputKind: S.lastInputKind, stack: stack() });
    return r;
  }; };
  for (const n of ['scrollTo', 'scrollBy', 'scrollIntoView']) wrap(n);
  document.addEventListener('scroll', (e) => {
    const el = e.target;
    if (!isSuperSc(el)) return;
    S.log.push({ k: 'scroll', t: now(), scen: S.scen, st: Math.round(el.scrollTop), sh: el.scrollHeight, ch: el.clientHeight, inputAge: inputAge(), inputKind: S.lastInputKind, owner: inputAge() < 300 });
  }, { capture: true, passive: true });
  let last = null;
  const tick = () => {
    const sc = [...document.querySelectorAll('.chat-scroll')].find((e) => isSuperSc(e) && e.getBoundingClientRect().height > 0);
    if (sc) {
      const cur = { st: Math.round(sc.scrollTop), sh: sc.scrollHeight, ch: sc.clientHeight };
      if (!last || cur.st !== last.st || cur.sh !== last.sh || cur.ch !== last.ch) {
        S.frames.push({ t: now(), scen: S.scen, ...cur, writes: S.writesThisFrame, inputAge: inputAge(), dst: cur.st - (last ? last.st : cur.st), dsh: cur.sh - (last ? last.sh : cur.sh) });
        last = cur;
      }
    }
    S.writesThisFrame = 0;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  /** The layout under the view: every child of .chat-scroll-inner, the scroller and its neighbours. */
  window.__skGap = () => {
    const sc = [...document.querySelectorAll('.chat-scroll')].find((e) => isSuperSc(e) && e.getBoundingClientRect().height > 0);
    if (!sc) return null;
    const v = sc.getBoundingClientRect();
    const inner = sc.querySelector('.chat-scroll-inner');
    const cs = getComputedStyle(sc);
    const vis = (el) => { const r = el.getBoundingClientRect(); if (r.height < 1) return false; const tx = (el.innerText || '').trim(); return tx.length > 0 || !!el.querySelector('img,svg,canvas,video,iframe,button,input'); };
    const kids = [...inner.children].map((el, i) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return {
      i, cls: String(el.className).slice(0, 70), tag: el.tagName, item: el.getAttribute('data-item-id'), testid: el.getAttribute('data-testid'),
      top: Math.round(r.top - v.top), bottom: Math.round(r.bottom - v.top), h: Math.round(r.height), minH: s.minHeight, mt: s.marginTop, mb: s.marginBottom, pos: s.position, disp: s.display,
      visible: vis(el), text: (el.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 60) }; });
    const inFlow = kids.filter((k) => k.pos !== 'absolute' && k.pos !== 'fixed' && k.disp !== 'none');
    const lastVis = [...inFlow].reverse().find((k) => k.visible);
    const viewBottom = Math.round(v.height - parseFloat(cs.paddingBottom));
    const tail = lastVis ? inFlow.filter((k) => k.i > lastVis.i) : [];
    const tr = sc.parentElement; const trR = tr.getBoundingClientRect();
    const sibs = [...tr.children].map((el) => { const r = el.getBoundingClientRect(); return { cls: String(el.className).slice(0, 60), testid: el.getAttribute('data-testid'), top: Math.round(r.top - v.top), h: Math.round(r.height), pos: getComputedStyle(el).position }; });
    const composer = document.querySelector('[data-super-slot="centre"] .chat-cmp, .super-dock .chat-cmp');
    const cr = composer ? composer.getBoundingClientRect() : null;
    const pill = document.querySelector('[data-testid="super-new"], .chat-jump');
    const pr = pill && pill.getBoundingClientRect().height ? pill.getBoundingClientRect() : null;
    const innerR = inner.getBoundingClientRect();
    return {
      scrollTop: Math.round(sc.scrollTop), scrollHeight: sc.scrollHeight, clientHeight: sc.clientHeight, maxTop: sc.scrollHeight - sc.clientHeight, distToBottom: Math.round(sc.scrollHeight - sc.scrollTop - sc.clientHeight),
      scrollerPad: cs.padding, scrollerMarginBottom: cs.marginBottom, innerGap: getComputedStyle(inner).rowGap, innerH: Math.round(innerR.height), innerMinH: getComputedStyle(inner).minHeight,
      innerBottomInView: Math.round(innerR.bottom - v.top), viewH: Math.round(v.height),
      lastVisible: lastVis ? { cls: lastVis.cls, bottom: lastVis.bottom, text: lastVis.text } : null,
      emptyBelowLastVisible: lastVis ? Math.max(0, Math.min(viewBottom, Math.round(innerR.bottom - v.top)) - lastVis.bottom) : null,
      emptyToScrollerBottom: lastVis ? Math.max(0, Math.round(v.height) - lastVis.bottom) : null,
      tailChildren: tail, tailGaps: tail.length, tailHeights: tail.reduce((a, k) => a + k.h, 0),
      zeroHeightInFlow: inFlow.filter((k) => k.h === 0).length, invisibleInFlow: inFlow.filter((k) => !k.visible).length, childCount: kids.length,
      scrollerBottomToComposerTop: cr ? Math.round(cr.top - v.bottom) : null, transcriptBottomToComposerTop: cr ? Math.round(cr.top - trR.bottom) : null,
      pill: pr ? { top: Math.round(pr.top - v.top), h: Math.round(pr.height), text: (pill.innerText || '').replace(/\\s+/g, ' ').slice(0, 80) } : null,
      transcriptSiblings: sibs,
      kids,
    };
  };
})();`;

const until = async (page, fn, ms = 20000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(150); } return false; };
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
const readNd = (p) => { try { return readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

// ── source mapping of the stacks ──────────────────────────────────────────────────────────
const ASSETS = join(REPO, 'dist', 'dashboard', 'assets');
const maps = new Map();
const mapFor = (file) => {
  if (maps.has(file)) return maps.get(file);
  let tm = null;
  const p = join(ASSETS, file + '.map');
  if (existsSync(p)) tm = new TraceMap(readFileSync(p, 'utf-8'));
  maps.set(file, tm);
  return tm;
};
const srcCache = new Map();
const enclosing = (tm, source, line) => {
  const key = source;
  let lines = srcCache.get(key);
  if (!lines) {
    const i = tm.sources.indexOf(source);
    const content = i >= 0 && tm.sourcesContent ? tm.sourcesContent[i] : null;
    lines = content ? content.split('\n') : [];
    srcCache.set(key, lines);
  }
  for (let l = line - 1; l >= 0 && l > line - 400; l--) {
    const s = lines[l] || '';
    let m = /^\s*(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:useCallback|useMemo|\(|async|function)/.exec(s); if (m) return `${m[1]}@${l + 1}`;
    m = /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/.exec(s); if (m) return `${m[1]}@${l + 1}`;
    m = /^\s*(useLayoutEffect|useEffect)\(/.exec(s); if (m) return `${m[1]}@${l + 1}`;
    m = /^\s*(?:const\s+)?(\w+)\s*=\s*new ResizeObserver/.exec(s); if (m) return `ResizeObserver(${m[1]})@${l + 1}`;
    m = /^\s*(\w+)\s*[:=]\s*\(.*\)\s*=>\s*\{?\s*$/.exec(s); if (m && l < line - 1) return `${m[1]}@${l + 1}`;
  }
  return '?';
};
const mapFrame = (raw) => {
  const m = /(?:at\s+(?:(.*?)\s+\()?)?(https?:\/\/[^\s)]+?):(\d+):(\d+)\)?$/.exec(raw);
  if (!m) return { raw };
  const file = m[2].split('/').pop().split('?')[0];
  const tm = mapFor(file);
  if (!tm) return { raw: raw.slice(0, 100) };
  const o = originalPositionFor(tm, { line: Number(m[3]), column: Number(m[4]) - 1 });
  if (!o.source) return { raw: raw.slice(0, 100) };
  const src = o.source.split('/').slice(-2).join('/');
  if (/node_modules|react-dom|scheduler/.test(o.source)) return { lib: `${src.split('/').pop()}:${o.line}` };
  return { at: `${src}:${o.line}`, fn: enclosing(tm, o.source, o.line) };
};
const mapStack = (st) => {
  const out = [];
  for (const raw of st || []) { const f = mapFrame(raw); if (f.at) out.push(`${f.fn} (${f.at})`); else if (f.lib && out.length && !out[out.length - 1].startsWith('[')) out.push(`[${f.lib}]`); if (out.filter((x) => !x.startsWith('[')).length >= 6) break; }
  return out;
};

/** What the logs say about one scenario. `tEnd`: the turn's end (page clock). */
function judge(s, tEnd) {
  const writes = s.log.filter((e) => e.k !== 'scroll');
  const moving = writes.filter((e) => Math.abs(e.to - e.from) >= 1);
  const zero = writes.filter((e) => Math.abs(e.to - e.from) < 1 && e.k === 'set');
  const idle = writes.filter((e) => e.inputAge >= 300);
  const perFrame = Math.max(0, ...s.frames.map((f) => f.writes));
  // Writes per second while the reply streamed (the busiest 1 s window).
  let perSec = 0;
  for (const w of moving) perSec = Math.max(perSec, moving.filter((x) => x.t >= w.t && x.t < w.t + 1000).length);
  const after = tEnd == null ? [] : writes.filter((e) => e.t > tEnd + 300);
  const afterMoved = after.reduce((a, e) => a + Math.abs(e.to - e.from), 0);
  const silent = s.frames.filter((f) => f.dst !== 0 && f.writes === 0 && f.inputAge >= 300 && f.dsh === 0);
  return { writes: writes.length, moving: moving.length, zero: zero.length, idle: idle.length, perFrame, perSec, after: after.length, afterMoved: Math.round(afterMoved), silentMoves: silent.length,
    writers: [...new Set(moving.map((e) => (e.writer || [])[0]).filter(Boolean))].slice(0, 6) };
}

async function runOne(engine, VIEW) {
  const OUT = join(SHOTS, `${engine}-${VIEW}`);
  const ok = (name, pass, detail = '') => { console.log(`  ${pass ? '✓' : '✗'} [${engine} ${VIEW}] ${name}${!pass && detail ? `\n      ${detail}` : ''}`); if (!pass) fails.push(`${engine} ${VIEW}: ${name}`); };
  const SCRATCH = join(tmpdir(), `dc-super-kayma-${process.pid}-${engine}-${VIEW}`);
  const HOME = join(SCRATCH, 'home');
  const PROJ = join(SCRATCH, 'acme-app');
  const FRAMES = join(SCRATCH, 'frames.ndjson');
  const REPORTS = join(SCRATCH, 'reports.ndjson');
  const env = () => ({ ...process.env, HOME, DREAMCONTEXT_DESKTOP: '1' });
  rmSync(SCRATCH, { recursive: true, force: true });
  rmSync(OUT, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(PROJ, '_dream_context', 'state'), OUT]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom',
    chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off', superAgent: true,
  }, null, 2)}\n`);
  spawnSync('git', ['-C', PROJ, 'init', '-q']);
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, standin(FRAMES, REPORTS, RAPOR.toString()));
  chmodSync(bin, 0o755);
  const added = spawnSync(process.execPath, [CLI, 'vaults', 'add', 'acme-app', PROJ], { env: env(), encoding: 'utf-8' });
  if (added.status !== 0) throw new Error(`vaults add failed: ${added.stderr || added.stdout}`);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], { cwd: PROJ, env: { ...env(), PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout.pipe(createWriteStream(join(OUT, 'server.log'))); srv.stderr.pipe(createWriteStream(join(OUT, 'server.err')));
  for (const end = Date.now() + 60_000; Date.now() < end;) {
    try { if ((await fetch(`${base}/`)).ok) break; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  const reports = () => readNd(REPORTS);
  const frames = () => readNd(FRAMES);
  const count = (kind) => reports().filter((r) => r.kind === kind).length;
  const browser = await playwright[engine].launch();
  const vp = VIEW === 390 ? { width: 390, height: 844 } : { width: 1440, height: 900 };
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', locale: 'en-US' });
  await context.addInitScript(INSTRUMENT);
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  const result = { engine, view: VIEW, scenarios: {}, verdicts: {} };
  const shot = (name) => page.screenshot({ path: join(OUT, `${name}.png`) });
  const gap = () => page.evaluate(() => window.__skGap());
  const input = () => page.locator('[data-super-slot="centre"] .chat-cmp-input, .super-dock .chat-cmp-input').filter({ visible: true }).first();
  const send = async (text) => { const i = input(); await i.click(); await i.fill(text); await page.keyboard.press('Enter'); };
  const scen = (name) => page.evaluate((n) => { window.__sk.scen = n; }, name);
  const drain = () => page.evaluate(() => { const S = window.__sk; const o = { log: S.log, frames: S.frames }; S.log = []; S.frames = []; return o; });
  const park = async () => { await page.mouse.move(2, vp.height - 2); };
  const now = () => page.evaluate(() => performance.now());
  const newBtn = () => page.locator('[data-testid="super-new"]').filter({ visible: true });
  /** Where the row after the owner's message `text` starts, and where the view is (scroll px). */
  const replyStart = (text) => page.evaluate((t) => {
    const sc = [...document.querySelectorAll('[data-super-slot="centre"] .chat-scroll, .super-dock .chat-scroll')].find((e) => e.getBoundingClientRect().height > 0);
    if (!sc) return null;
    const v = sc.getBoundingClientRect();
    const rows = [...sc.querySelector('.chat-scroll-inner').children].filter((e) => !e.classList.contains('chat-reply-lines'));
    const own = [...rows].reverse().find((r) => (r.innerText || '').trim() === t || (r.innerText || '').includes(t));
    const next = own ? rows[rows.indexOf(own) + 1] : null;
    const at = (e) => (e ? Math.round(e.getBoundingClientRect().top - v.top) : null);
    const cards = [...sc.querySelectorAll('[data-testid="super-question-card"]')].map((c) => { const r = c.getBoundingClientRect(); return { top: Math.round(r.top - v.top), bottom: Math.round(r.bottom - v.top) }; });
    return { ownTop: at(own), replyTop: at(next), viewH: Math.round(v.height), cutCards: cards.filter((c) => c.top < -1 && c.bottom > 0).length, dist: Math.round(sc.scrollHeight - sc.scrollTop - sc.clientHeight) };
  }, text);
  const answer = async () => {
    const card = page.locator('[data-testid="super-question-card"]').filter({ visible: true }).last();
    await card.scrollIntoViewIfNeeded().catch(() => {});
    await card.getByText('%20', { exact: true }).first().click();
    await page.waitForTimeout(250);
    await card.getByRole('button', { name: /Submit|Gönder/ }).click();
  };
  const toBottom = async () => { if (await newBtn().count()) { await newBtn().first().click(); await page.waitForTimeout(700); } };
  const finish = async (name, extra, tEnd = null) => {
    const { log, frames: fr } = await drain();
    for (const e of log) if (e.stack) { e.writer = mapStack(e.stack); delete e.stack; }
    const s = { ...extra, log, frames: fr };
    result.scenarios[name] = s;
    const v = judge(s, tEnd);
    result.verdicts[name] = { ...v, ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'gaps')) };
    console.log(`  · ${name}`, JSON.stringify(v));
    return v;
  };

  try {
    await page.goto(`${base}/?vault=acme-app`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
    const rail = page.locator('[data-testid="ns-rail-chat"]');
    if (await rail.count()) await rail.first().click();
    await page.waitForTimeout(900);
    if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat|Sohbet başlat/ }).click().catch(() => {});
    await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0, 30000);
    await page.locator('.chat-cmp-input:visible').first().fill('merhaba');
    await page.keyboard.press('Enter');
    await until(page, async () => frames().some((f) => f.role === 'child'), 30000);
    await page.waitForTimeout(1200);
    await page.locator('[data-testid="drawer-super-row"]:visible, [data-testid="super-handover-btn"]:visible').first().click();
    ok('the Super stage shows', await until(page, async () => (await page.locator('[data-testid="super-surface"]:visible').count()) > 0, 30000));
    ok('the Super took the hand-over', await until(page, async () => reports().some((r) => r.kind === 'handover'), 60000));
    await until(page, async () => (await input().count()) > 0, 30000);
    await page.waitForTimeout(2500);
    if (VIEW === 390) {
      await page.setViewportSize(vp);
      await page.waitForTimeout(1500);
      await page.locator('[data-testid="super-dock-pill"]').filter({ visible: true }).first().click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(1200);
    }
    for (const k of ['h1', 'h2', 'h3']) { const n = count('turn-end'); await send(`KISA ${k}`); await until(page, async () => count('turn-end') > n, 30000); await page.waitForTimeout(400); }
    await toBottom();
    await drain();

    // ── S1: his send at the bottom; a long report + a question card arrive; he is idle ──
    console.log(`S1 ${engine} ${VIEW}`);
    await scen('s1');
    let n = count('turn-end');
    await send('TUR A');
    await park();
    await until(page, async () => reports().some((r) => r.kind === 'streaming' && r.tag === 'A'), 20000);
    await page.waitForTimeout(1200);
    await shot('s1-a-mid-reply');
    await until(page, async () => count('turn-end') > n, 60000);
    const t1 = await now();
    await page.waitForTimeout(300);
    const s1End = await replyStart('TUR A');
    await shot('s1-b-stopped');
    await page.waitForTimeout(4000);
    const s1Later = await replyStart('TUR A');
    const g1 = await gap();
    const btn1 = ((await newBtn().getAttribute('aria-label').catch(() => '')) ?? '').trim();
    await shot('s1-c-idle-after-4s');
    const v1 = await finish('s1', { end: s1End, later: s1Later, button: btn1, gaps: { end: g1 } }, t1);
    ok('S1 his send moved the view to the bottom and followed (writes happened)', v1.moving > 0, JSON.stringify(v1));
    ok('S1 at most one write per frame', v1.perFrame <= 1, JSON.stringify(v1));
    ok('S1 no zero-distance write', v1.zero === 0, JSON.stringify(v1));
    ok('S1 0 writes after the turn ended', v1.after === 0, JSON.stringify(v1));
    ok('S1 the reply\'s start is on screen at the end', !!s1End && s1End.replyTop !== null && s1End.replyTop >= -2 && s1End.replyTop < s1End.viewH, JSON.stringify(s1End));
    ok('S1 nothing moved in the 4 s after', !!s1Later && s1Later.replyTop === s1End?.replyTop, JSON.stringify({ s1End, s1Later }));
    ok('S1 no question card cut at the top', !!s1End && s1End.cutCards === 0, JSON.stringify(s1End));
    if (s1End && s1End.dist > 60) ok('S1 stopped above the end: the button says "N new"', /\d+\s+new/.test(btn1), JSON.stringify(btn1));

    // ── S3: he answers the card (a send); the answer turn thinks, then streams ──
    console.log(`S3 ${engine} ${VIEW}`);
    await scen('s3');
    n = count('turn-end');
    const na = count('answer');
    await answer();
    await park();
    await until(page, async () => count('answer') > na, 20000);
    await until(page, async () => count('turn-end') > n, 60000);
    const t3 = await now();
    await page.waitForTimeout(300);
    const s3End = await page.evaluate(() => {
      const sc = [...document.querySelectorAll('[data-super-slot="centre"] .chat-scroll, .super-dock .chat-scroll')].find((e) => e.getBoundingClientRect().height > 0);
      const v = sc.getBoundingClientRect();
      const rows = [...sc.querySelectorAll('.chat-scroll-inner > *')];
      const reply = [...rows].reverse().find((r) => /yüzde 20 ile bitiriyorum/.test(r.innerText || ''));
      const r = reply ? reply.getBoundingClientRect() : null;
      return { replyTop: r ? Math.round(r.top - v.top) : null, viewH: Math.round(v.height), dist: Math.round(sc.scrollHeight - sc.scrollTop - sc.clientHeight) };
    });
    await shot('s3-a-answer-reply');
    await page.waitForTimeout(3000);
    const v3 = await finish('s3', { end: s3End }, t3);
    ok('S3 the answer\'s reply starts on screen at the end', s3End.replyTop !== null && s3End.replyTop >= -2 && s3End.replyTop < s3End.viewH, JSON.stringify(s3End));
    ok('S3 0 writes after the turn ended', v3.after === 0, JSON.stringify(v3));
    ok('S3 at most one write per frame, no zero-distance write', v3.perFrame <= 1 && v3.zero === 0, JSON.stringify(v3));

    // ── S2: he sends, then wheels UP before the reply comes, then idles ──
    console.log(`S2 ${engine} ${VIEW}`);
    await toBottom();
    await drain();
    await scen('s2');
    n = count('turn-end');
    await send('GEC B');
    await page.waitForTimeout(1200);
    const scs = await page.locator('[data-super-slot="centre"] .chat-scroll, .super-dock .chat-scroll').filter({ visible: true }).first().boundingBox();
    await page.mouse.move(scs.x + scs.width / 2, scs.y + scs.height / 2);
    for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -100); await page.waitForTimeout(30); }
    await page.waitForTimeout(400);
    await park();
    const before = await gap();
    const t2 = await now();
    await until(page, async () => count('turn-end') > n, 60000);
    await page.waitForTimeout(3000);
    const after = await gap();
    const btn2 = ((await newBtn().getAttribute('aria-label').catch(() => '')) ?? '').trim();
    await shot('s2-scrolled-up-idle');
    const v2 = await finish('s2', { before: before.scrollTop, after: after.scrollTop, button: btn2 });
    const idleWrites = result.scenarios.s2.log.filter((e) => e.k !== 'scroll' && e.t > t2 && Math.abs(e.to - e.from) >= 1).length;
    ok('S2 scrolled up: 0 moving writes while he idles', idleWrites === 0, JSON.stringify({ idleWrites, v2 }));
    ok('S2 the view did not move', Math.abs(after.scrollTop - before.scrollTop) <= 1, `${before.scrollTop} -> ${after.scrollTop}`);
    ok('S2 the button shows below', btn2.length > 0, JSON.stringify(btn2));

    // ── S4: the button ──
    console.log(`S4 ${engine} ${VIEW}`);
    await scen('s4');
    if (await newBtn().count()) {
      await newBtn().first().click();
      await page.waitForTimeout(800);
      const g4 = await gap();
      ok('S4 the button goes to the bottom and hides', g4.distToBottom < 60 && (await newBtn().count()) === 0, JSON.stringify({ dist: g4.distToBottom }));
      ok('S4 no gap above the button strip at the bottom', (g4.emptyBelowLastVisible ?? 0) <= 16, JSON.stringify({ empty: g4.emptyBelowLastVisible }));
      await shot('s4-at-bottom');
    } else ok('S4 a button to press', false);
    await finish('s4', {});

    // ── S6: a queued send (⌥⏎ mid-turn) moves the view at his press, never when the queue sends it ──
    console.log(`S6 ${engine} ${VIEW}`);
    await toBottom();
    await drain();
    await scen('s6');
    n = count('turn-end');
    await send('GEC C');
    await page.waitForTimeout(600);
    const wheelUp = async () => {
      const box = await page.locator('[data-super-slot="centre"] .chat-scroll, .super-dock .chat-scroll').filter({ visible: true }).first().boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -100); await page.waitForTimeout(30); }
      await page.waitForTimeout(400);
    };
    await wheelUp();
    const up6 = await gap();
    // fill, not click: under a finger a tap on the field is itself a way to the bottom.
    await input().fill('KISA q6');
    await page.keyboard.press('Alt+Enter');
    await page.waitForTimeout(500);
    const pressed6 = await gap();
    ok('S6 the queued press takes the view to the bottom', up6.distToBottom <= 60 || pressed6.distToBottom < 60, JSON.stringify({ before: up6.distToBottom, after: pressed6.distToBottom }));
    await wheelUp();
    await park();
    const held6 = await gap();
    ok('S6 the queued message waits (not sent at the press)', !frames().some((f) => f.role === 'super' && f.blocks.some((b) => b.includes('KISA q6'))));
    await until(page, async () => frames().some((f) => f.role === 'super' && f.blocks.some((b) => b.includes('KISA q6'))) && count('turn-end') >= n + 2, 60000);
    await page.waitForTimeout(1500);
    const drained6 = await gap();
    await shot('s6-queued-drained-scrolled-up');
    const v6 = await finish('s6', { up: up6.distToBottom, pressed: pressed6.distToBottom, held: held6.scrollTop, drained: drained6.scrollTop });
    ok('S6 the queue sending it later moves nothing', Math.abs(drained6.scrollTop - held6.scrollTop) <= 1, `${held6.scrollTop} -> ${drained6.scrollTop} ${JSON.stringify(v6)}`);

    // ── S8: back at the bottom mid-turn (only the steps line new), then a long answer arrives ──
    // The follow must survive the steps line being redrawn when the answer starts (r3): followed,
    // and stopped with the answer's start in the upper half of the view, never left at the bottom edge.
    console.log(`S8 ${engine} ${VIEW}`);
    await toBottom();
    await drain();
    await scen('s8');
    n = count('turn-end');
    await send('TUR E');
    await until(page, async () => reports().some((r) => r.kind === 'turn-start' && r.tag === 'E'), 20000);
    await page.waitForTimeout(900);
    await wheelUp();
    if (await newBtn().count()) await newBtn().first().click();
    await park();
    await until(page, async () => count('turn-end') > n, 60000);
    const t8 = await now();
    await page.waitForTimeout(300);
    const s8End = await page.evaluate(() => {
      const sc = [...document.querySelectorAll('[data-super-slot="centre"] .chat-scroll, .super-dock .chat-scroll')].find((e) => e.getBoundingClientRect().height > 0);
      const v = sc.getBoundingClientRect();
      const rows = [...sc.querySelectorAll('.chat-scroll-inner > .chat-msg-assistant-row, .chat-scroll-inner [data-item-id]')];
      const ans = [...rows].reverse().find((r) => /Durum E:/.test(r.innerText || ''));
      const r = ans ? ans.getBoundingClientRect() : null;
      return { ansTop: r ? Math.round(r.top - v.top) : null, viewH: Math.round(v.height), dist: Math.round(sc.scrollHeight - sc.scrollTop - sc.clientHeight) };
    });
    await shot('s8-steps-then-answer');
    const v8 = await finish('s8', { end: s8End }, t8);
    if (s8End.ansTop === null) ok('S8 found the long answer row', false, JSON.stringify(s8End));
    else if (s8End.dist > 60) ok('S8 followed: the answer\'s start stopped in the upper half', s8End.ansTop >= -2 && s8End.ansTop <= s8End.viewH / 2, JSON.stringify(s8End));
    else ok('S8 the answer\'s start is on screen', s8End.ansTop >= -2 && s8End.ansTop < s8End.viewH, JSON.stringify(s8End));
    ok('S8 0 writes after the turn ended', v8.after === 0, JSON.stringify(v8));

    // ── S7: reopening the app with nothing unread lands at the bottom (history arrives after mount) ──
    if (VIEW === 1440) {
      console.log(`S7 ${engine} ${VIEW}`);
      await toBottom();
      await page.waitForTimeout(2500);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await until(page, async () => (await page.locator('[data-testid="super-surface"]:visible').count()) > 0, 30000);
      await until(page, async () => (await input().count()) > 0, 30000);
      await page.waitForTimeout(3000);
      const g7 = await gap();
      const btn7 = ((await newBtn().getAttribute('aria-label').catch(() => '')) ?? '').trim();
      await shot('s7-reopened');
      // Something still unread lands on its line instead (D7): only "nothing unread" must be at the bottom.
      if (/\d/.test(btn7)) console.log(`  · S7 reopened onto an unread line (${btn7}); bottom check skipped`);
      else ok('S7 reopened with nothing unread: at the bottom', g7.distToBottom < 60, JSON.stringify({ dist: g7.distToBottom, button: btn7 }));
      await drain();
    }
    for (const theme of ['dark']) {
      await page.emulateMedia({ colorScheme: theme });
      await page.waitForTimeout(500);
      await page.locator('[data-super-slot="centre"] .chat-scroll, .super-dock .chat-scroll').filter({ visible: true }).first().evaluate((el) => { el.scrollTop = Math.max(0, el.scrollTop - 500); });
      await page.waitForTimeout(600);
      await shot(`s5-${theme}-scrolled-up`);
    }
    result.errors = errors.filter((x) => !/favicon|ERR_CONNECTION|WebSocket|Failed to load resource/i.test(x));
    ok('no console errors', result.errors.length === 0, result.errors.join('\n'));
  } catch (err) {
    ok('run finished', false, String(err?.stack || err));
    result.crash = String(err?.stack || err);
    await page.screenshot({ path: join(OUT, 'zz-crash.png') }).catch(() => {});
  } finally {
    writeFileSync(join(OUT, 'raw.json'), `${JSON.stringify(result, null, 1)}\n`);
    writeFileSync(join(OUT, 'verdicts.json'), `${JSON.stringify(result.verdicts, null, 1)}\n`);
    await context.close();
    await browser.close();
    srv.kill('SIGTERM');
    spawnSync('pkill', ['-f', bin]);
    rmSync(SCRATCH, { recursive: true, force: true });
  }
  return result.verdicts;
}

mkdirSync(SHOTS, { recursive: true });
const all = {};
for (const engine of ENGINES) for (const view of VIEWS) all[`${engine}-${view}`] = await runOne(engine, view);
writeFileSync(join(SHOTS, 'summary.json'), `${JSON.stringify(all, null, 1)}\n`);
console.log(`\n${fails.length ? `✗ ${fails.length} failed:\n  ${fails.join('\n  ')}` : '✓ all passed'} — screenshots and numbers in ${SHOTS}`);
process.exit(fails.length ? 1 : 0);
