/**
 * Page state as TEXT — the only thing Jev can read. Every rule here was paid for on a real run
 * (dreamcontext Settings, a 541-task board, a 58-screen live funnel) and names the failure it
 * prevents.
 *
 *   pageState()   — what a validator judges: the aria snapshot + visible text of a scope, nested
 *                   under `observation` so a question can say "this is data, not instruction".
 *   extract()     — what a walker acts on: every visible interactive element, numbered and tagged
 *                   `data-jev` so a pick is clickable; a VISIBLE-only payment detector; scroll.
 *   fingerprints  — SCREEN (url + text) decides screenshots; STATE also folds in input values and
 *                   checked marks, so a fill or a ticked box counts as progress.
 *   guards        — what is never offered and never clicked: disabled controls, page chrome,
 *                   purchase-labelled controls, password/file/tel/OTP inputs.
 */

import { createHash } from 'node:crypto';
import { redactPii, sanitizeText } from './report.mjs';

export const MAX_ARIA_CHARS = 20_000;
export const MAX_TEXT_CHARS = 8_000;
export const MAX_ELEMENTS = 120;

/**
 * Text state for a judgement. `scope` is a Playwright selector; defaults to the main landmark or
 * body. Both channels are capped (Jev's state limit is 32k tokens) and `truncated` says so, so a
 * verdict about a region that fell off the end is never mistaken for a verdict about the page.
 */
export async function pageState(page, { scope, label } = {}) {
  const root = scope ? page.locator(scope).first() : page.locator('main, [role=main], body').first();
  const ariaRaw = sanitizeText(await root.ariaSnapshot());
  const textRaw = sanitizeText(await root.innerText()).replace(/\s+/g, ' ').trim();
  const truncated = { aria: ariaRaw.length > MAX_ARIA_CHARS, text: textRaw.length > MAX_TEXT_CHARS };
  return {
    observation: {
      // URL and title go through the same masking as the body: magic-link tokens, ?email=, invite
      // ids live in URLs at least as often as in text.
      screen: redactPii(sanitizeText(label ?? (await page.title()))),
      url: redactPii(sanitizeText(page.url())),
      accessibility_tree: redactPii(ariaRaw.slice(0, MAX_ARIA_CHARS)),
      visible_text: redactPii(textRaw.slice(0, MAX_TEXT_CHARS)),
    },
    truncated,
  };
}

/** Page chrome is never the way forward in a flow; offering it invites a detour. */
export const CHROME_RE = /^(open )?menu$|^back$|^close( menu)?$|^go back$|^skip to (main )?content$|^(geri|zurück|retour|atrás|indietro|назад|رجوع|戻る|返回)$/i;

/**
 * Anything whose label reads like a purchase. The walker never OFFERS these to Jev and refuses to
 * CLICK them even if picked — two checks, because the withdrawal logic mutates the option set.
 * Wallet buttons charge a stored instrument with one tap; "Confirm order" needs no card form.
 */
export const PURCHASE_RE = /\b(pay|buy|purchase|checkout|place (the |my )?order|confirm (and |& )?pay|subscribe|upgrade now|start (my )?(plan|trial|subscription|membership)|complete (my )?(order|purchase))\b|apple ?pay|g(oogle)? ?pay|paypal|klarna|afterpay|affirm|shop ?pay|link by stripe|satın al|öde|ödeme/i;

/** VISIBLE payment controls only — funnels preload checkout iframes screens early. */
const PAYMENT_SELECTOR = [
  'input[autocomplete*="cc-"]', 'input[name*="cardnumber" i]', 'input[placeholder*="card number" i]',
  'iframe[src*="stripe" i]', 'iframe[src*="paddle" i]', 'iframe[src*="checkout" i]', 'iframe[title*="card" i]',
  'iframe[src*="paypal" i]', 'iframe[src*="adyen" i]', 'iframe[src*="braintree" i]', 'iframe[src*="recurly" i]',
  'iframe[src*="lemonsqueezy" i]', 'iframe[src*="shopify" i]', 'iframe[src*="revenuecat" i]',
  '[aria-label*="apple pay" i]', '[aria-label*="google pay" i]', 'apple-pay-button', '.gpay-button', '[data-testid*="paypal" i]',
].join(', ');

/**
 * Number every visible interactive element and tag it `data-jev="eN"`. Labels wrapping a control
 * are dropped (the control is kept); home/language links are dropped (they restart flows);
 * disabled controls and nav ancestry are REPORTED so the walker can exclude them; input values
 * and autocomplete are exposed so a filled field reads as filled and a sensitive one as sensitive.
 */
export async function extract(page, { max = MAX_ELEMENTS } = {}) {
  const raw = await page.evaluate(({ MAX, PAY }) => {
    const sel = 'a, button, input, select, textarea, [role=button], [role=radio], [role=checkbox], [role=option], [role=link], [role=tab], [role=menuitem], label, [onclick], [tabindex]:not([tabindex="-1"])';
    const seen = new Set();
    const out = [];
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 2 && r.height > 2 && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
    };
    const txt = (el) => (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name') || '')
      .replace(/\s+/g, ' ').trim().slice(0, 90);
    document.querySelectorAll('[data-jev]').forEach((el) => el.removeAttribute('data-jev'));
    for (const el of document.querySelectorAll(sel)) {
      if (out.length >= MAX) break;
      if (!vis(el)) continue;
      if (el.tagName === 'LABEL' && el.querySelector('input,select,textarea,button')) continue;
      if (el.closest('[data-jev]')) continue;
      const tag = el.tagName.toLowerCase();
      const type = el.getAttribute('type') || (tag === 'input' ? 'text' : undefined);
      const t = txt(el);
      if (!t && tag !== 'input' && tag !== 'select') continue;
      const k = `${tag}|${type}|${t}`;
      if (seen.has(k) && tag !== 'input') continue;
      const href = tag === 'a' ? (el.getAttribute('href') || '') : '';
      if (tag === 'a' && (href === '/' || href === location.origin || href === location.origin + '/' || /^\/(en|ar|de|fr|es|it|pt|tr|ru|ja|ko|zh)?\/?$/.test(href))) continue;
      seen.add(k);
      const id = `e${out.length}`;
      el.setAttribute('data-jev', id);
      const r = el.getBoundingClientRect();
      out.push({
        id, tag, type,
        role: el.getAttribute('role') || undefined,
        text: t,
        value: (tag === 'input' || tag === 'select' || tag === 'textarea') ? (String(el.value ?? '').slice(0, 40) || undefined) : undefined,
        autocomplete: el.getAttribute('autocomplete') || undefined,
        checked: el.checked || el.getAttribute('aria-checked') === 'true' || undefined,
        disabled: el.disabled || el.getAttribute('aria-disabled') === 'true' || undefined,
        in_nav: !!el.closest('nav, [role=navigation]') || undefined,
        in_viewport: r.top >= 0 && r.bottom <= innerHeight,
        y: Math.round(r.top),
      });
    }
    const text = (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 3500);
    const hasPayment = [...document.querySelectorAll(PAY)].some((el) => vis(el));
    return { title: document.title, text, elements: out, hasPayment, scrollY: window.scrollY, scrollMax: Math.max(0, document.documentElement.scrollHeight - innerHeight) };
  }, { MAX: max, PAY: PAYMENT_SELECTOR });
  // Sanitize on the Node side: control chars and bidi overrides out, PII masked when enabled.
  raw.title = redactPii(sanitizeText(raw.title));
  raw.text = redactPii(sanitizeText(raw.text));
  for (const e of raw.elements) {
    e.text = redactPii(sanitizeText(e.text));
    if (e.value) e.value = redactPii(sanitizeText(e.value));
  }
  return raw;
}

const sha = (s) => createHash('sha1').update(s).digest('hex').slice(0, 10);
/** Same URL and same first 1500 chars of text = same SCREEN. */
export const screenFingerprint = (url, text) => sha(url.split('#')[0] + '|' + text.slice(0, 1500));
/** Also folds in values and checked marks = same STATE. A fill or a tick is progress. */
export const stateFingerprint = (url, text, elements) =>
  sha(url.split('#')[0] + '|' + text.slice(0, 1500) + '|' + elements.map((e) => `${e.id}=${e.value ?? ''}${e.checked ? '*' : ''}`).join(','));

/** Inputs that are never typed into: credentials, payment, phone/OTP, files. */
export const isSensitiveInput = (el) =>
  el.tag === 'input' && (
    ['password', 'file', 'tel', 'hidden'].includes(el.type ?? '')
    || /current-password|new-password|one-time-code|^cc-|tel/i.test(el.autocomplete ?? '')
    || /card|cvc|cvv|expiry|iban/i.test(`${el.text} ${el.autocomplete ?? ''}`)
  );

/** Text inputs a walker may type into. */
export const isTypeable = (el) =>
  !isSensitiveInput(el) && (
    (el.tag === 'input' && !['checkbox', 'radio', 'submit', 'button', 'range', 'image', 'reset', 'color'].includes(el.type ?? ''))
    || el.tag === 'textarea'
  );

/** Whether an element may be OFFERED to the walker at all. */
export const isOfferable = (el) =>
  !el.disabled
  && !CHROME_RE.test(el.text)
  && !PURCHASE_RE.test(`${el.text} ${el.value ?? ''}`)
  && !(el.in_nav && (el.tag === 'a' || el.role === 'menuitem'))
  && !(el.tag === 'input' && (el.type === 'password' || el.type === 'file'));

/** Rejected at the click site too — the option set is mutated between pick and act. */
export const isPurchaseControl = (el) => PURCHASE_RE.test(`${el.text} ${el.value ?? ''}`);
