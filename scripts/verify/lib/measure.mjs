/**
 * Runtime measurement helpers for the #agents verify scripts.
 *
 * Every function here reads what Chromium PAINTED (computed colours composited over their
 * real backgrounds, client rects, line boxes), never what a stylesheet says. See
 * `pattern-runtime-measurement-verification`: a rule can say 26px and paint 35.
 *
 * Also the one place the scripts learn WHICH build they drive and where they write:
 *   DC_VERIFY_DIST   the `index.js` to run (default `dist/index.js`), relative to the repo.
 *                    The mutation proof points it at `tmp/goal/dist-prefix/index.js`.
 *   DC_VERIFY_PHASE  `before` / `after` / a lane name. Screenshots and scratch vaults are
 *                    keyed by it, so two lanes can run the same suite at once.
 */
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const PHASE = process.env.DC_VERIFY_PHASE || 'after';

export const distIndex = (repo) => resolve(repo, process.env.DC_VERIFY_DIST || join('dist', 'index.js'));
export const shotsDir = (repo, suite) => join(repo, 'tmp', `verify-${suite}`, PHASE);
export const scratchDir = (name) => join(tmpdir(), `${name}-${PHASE}`);

/**
 * WCAG contrast of an element's text (or a pseudo-element's, e.g. `::placeholder`) against
 * the background actually behind it: every translucent ancestor fill is composited from the
 * first opaque one up, and the text's own alpha and every ancestor `opacity` are applied.
 */
export async function contrast(locator, pseudo = null) {
  return locator.evaluate((el, pseudoSel) => {
    // Chromium serialises colours as `rgb()`, `rgba()` or, for `color-mix()`, `color(srgb …)`.
    const parse = (s) => {
      const nums = (s.match(/-?[\d.]+(?:e-?\d+)?/g) || []).map(Number);
      if (s.startsWith("color(")) return [nums[0] * 255, nums[1] * 255, nums[2] * 255, nums.length > 3 ? nums[3] : 1];
      return [nums[0], nums[1], nums[2], nums.length > 3 ? nums[3] : 1];
    };
    const layers = [];
    let opacity = 1;
    for (let n = el; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      opacity *= Number(cs.opacity);
      const bg = parse(cs.backgroundColor);
      if (bg[3] > 0) layers.push(bg);
      if (bg[3] >= 1) break;
    }
    let base = [255, 255, 255];
    if (!layers.length || layers[layers.length - 1][3] < 1) {
      const root = parse(getComputedStyle(document.documentElement).backgroundColor);
      if (root[3] >= 1) base = root.slice(0, 3);
    }
    for (let i = layers.length - 1; i >= 0; i--) {
      const [r, g, b, a] = layers[i];
      base = [r * a + base[0] * (1 - a), g * a + base[1] * (1 - a), b * a + base[2] * (1 - a)];
    }
    const fg = parse(getComputedStyle(el, pseudoSel).color);
    const a = fg[3] * opacity;
    const ink = [fg[0] * a + base[0] * (1 - a), fg[1] * a + base[1] * (1 - a), fg[2] * a + base[2] * (1 - a)];
    const lum = (c) => {
      const [r, g, b] = c.map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const l1 = lum(ink);
    const l2 = lum(base);
    return Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100;
  }, pseudo);
}

/**
 * WCAG contrast of a FILLED control: its own background against its own text, the way the
 * control PAINTS. Unlike {@link contrast}, the element's opacity applies to its fill as well
 * as its text (both are composited over the page behind it), and a `filter: brightness()`
 * on the element or an ancestor scales both. That is what a hover state is made of, so a
 * hover measured with `contrast()` would read the resting fill.
 */
export async function fillContrast(locator) {
  return locator.evaluate((el) => {
    const parse = (s) => {
      const nums = (s.match(/-?[\d.]+(?:e-?\d+)?/g) || []).map(Number);
      if (s.startsWith('color(')) return [nums[0] * 255, nums[1] * 255, nums[2] * 255, nums.length > 3 ? nums[3] : 1];
      return [nums[0], nums[1], nums[2], nums.length > 3 ? nums[3] : 1];
    };
    let opacity = 1;
    let bright = 1;
    for (let n = el; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      opacity *= Number(cs.opacity);
      const m = /brightness\(([\d.]+)\)/.exec(cs.filter || '');
      if (m) bright *= Number(m[1]);
    }
    // The page behind the control: the first opaque ancestor fill above it.
    let page = [255, 255, 255];
    for (let n = el.parentElement; n; n = n.parentElement) {
      const bg = parse(getComputedStyle(n).backgroundColor);
      if (bg[3] >= 1) { page = bg.slice(0, 3); break; }
    }
    const mix = (c, a, under) => [0, 1, 2].map((i) => c[i] * a + under[i] * (1 - a));
    const own = parse(getComputedStyle(el).backgroundColor);
    const fill = mix(own, own[3] * opacity, page);
    const fg = parse(getComputedStyle(el).color);
    const ink = mix(fg, fg[3] * opacity, fill);
    const lit = (c) => c.map((v) => Math.min(255, v * bright));
    const lum = (c) => {
      const [r, g, b] = c.map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const l1 = lum(lit(ink));
    const l2 = lum(lit(fill));
    return Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100;
  });
}

/**
 * The WORST contrast between a gradient-filled control's text and any colour stop of its
 * `background-image`: a gradient is only as readable as its lightest stop. Falls back to the
 * flat `background-color` when there is no gradient.
 */
export async function minGradientContrast(locator) {
  return locator.evaluate((el) => {
    const parse = (s) => {
      const nums = (s.match(/-?[\d.]+(?:e-?\d+)?/g) || []).map(Number);
      if (s.startsWith('color(')) return [nums[0] * 255, nums[1] * 255, nums[2] * 255];
      return [nums[0], nums[1], nums[2]];
    };
    const cs = getComputedStyle(el);
    const stops = (cs.backgroundImage.match(/(?:rgba?|color)\([^)]*\)/g) || []).map(parse);
    if (!stops.length) stops.push(parse(cs.backgroundColor));
    const fg = parse(cs.color);
    const lum = (c) => {
      const [r, g, b] = c.map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a, b) => { const l1 = lum(a); const l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
    return Math.round(Math.min(...stops.map((s) => ratio(fg, s))) * 100) / 100;
  });
}

/** A CSS colour value (a token, a `var()`) as the computed `rgb()` string it resolves to. */
export async function resolveColor(page, value, scopeSel = 'body') {
  return page.evaluate(([v, scope]) => {
    const host = document.querySelector(scope) || document.body;
    const probe = document.createElement('span');
    probe.style.color = v;
    host.appendChild(probe);
    const out = getComputedStyle(probe).color;
    probe.remove();
    return out;
  }, [value, scopeSel]);
}

export async function rect(locator) {
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  });
}

export function overlapArea(a, b) {
  if (!a || !b) return -1;
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? Math.round(w * h) : 0;
}

/**
 * The tops of the line boxes that PAINT inside an element — text-node ranges, clipped to the
 * element's own box, so lines a clamp hides do not count and a blank line shows up as a gap.
 */
export async function lineTops(locator) {
  return locator.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const tops = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const q of range.getClientRects()) {
        if (q.width <= 0 || q.height <= 0) continue;
        if (q.bottom <= box.top + 1 || q.top >= box.bottom - 1) continue;
        tops.push(Math.round(q.top));
      }
    }
    tops.sort((a, b) => a - b);
    return tops.filter((t, i) => i === 0 || t - tops[i - 1] > 2);
  });
}

/**
 * The app's own words under `rootSel`: every painted text node plus every title, aria-label
 * and placeholder, with the subtrees in `exclude` (agent-authored prose) left out.
 */
export async function chromeText(page, rootSel, exclude = []) {
  return page.evaluate(([sel, ex]) => {
    const parts = [];
    const skip = ex.join(',');
    for (const root of document.querySelectorAll(sel)) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const p = n.parentElement;
        if (!p || (skip && p.closest(skip)) || !p.getClientRects().length) continue;
        parts.push(n.textContent);
      }
      for (const el of [root, ...root.querySelectorAll('[title],[aria-label],[placeholder]')]) {
        if (skip && el.closest(skip)) continue;
        for (const a of ['title', 'aria-label', 'placeholder']) {
          const v = el.getAttribute(a);
          if (v) parts.push(v);
        }
      }
    }
    return parts.join('\n');
  }, [rootSel, exclude]);
}

/** The lines of `text` that carry an em dash, for evidence. */
export const dashLines = (text) => text.split('\n').filter((l) => l.includes('—')).map((l) => l.trim()).slice(0, 6);

/** The dashboard's theme, set the way the app reads it (`ThemeContext` → `dreamcontext-theme`). */
export async function setTheme(context, theme) {
  await context.addInitScript((t) => { try { localStorage.setItem('dreamcontext-theme', t); } catch { /* private mode */ } }, theme);
}

/**
 * The dispatcher, as `GET /api/automations/dispatcher` reports it — every field the bar
 * reads, healthy by default, so a check mocks exactly the state it is about.
 */
export function dispatcherState(over = {}) {
  return {
    supported: true, platform: 'darwin', installed: true, current: true, bootstrapped: true,
    plistPresent: true, plistCurrent: true, wrapperPresent: true, wrapperCurrent: true, mismatch: false,
    resolvedBin: '/usr/local/bin/dreamcontext', runningBin: '/usr/local/bin/dreamcontext',
    logPath: '/tmp/dispatcher.log', logSizeBytes: 0, projectRegistered: true,
    lastTickStartedAt: null, lastTickCompletedAt: null,
    notifier: { supported: false, present: false, current: false },
    ...over,
  };
}

/** Route the dispatcher read (and optionally its install) on one page to a fixed state. */
export async function mockDispatcher(page, state, { installDelayMs = null } = {}) {
  await page.unroute(/\/api\/automations\/dispatcher(\?|$)/).catch(() => {});
  await page.route(/\/api\/automations\/dispatcher(\?|$)/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ dispatcher: state }) }));
  if (installDelayMs !== null) {
    await page.route(/\/api\/automations\/dispatcher\/install/, async (route) => {
      await new Promise((r) => setTimeout(r, installDelayMs));
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ installed: false, method: 'none', warnings: ['held by the verify script'], notifier: { built: false, reason: null }, dispatcher: state }),
      });
    });
  }
}
