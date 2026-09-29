import { buildSandboxSrcdoc } from '../../../lib/sandboxHtml';
import { CHAT_HTML_KIT_CSS, KIT_BEHAVIOUR } from '../../sleepy/chat/chatHtmlKit';
import { escapeForInlineScript, isLabAppEnvelope, LAB_APP_PROTOCOL } from '../labAppRuntime';
import type { Frame } from '../../../generated/frameOps';
import type { Block, LibraryBlock } from '../board/boardTypes';

/**
 * The board `html` block's host<->iframe bridge (plan D4): pure, so the
 * security rules are unit-tested without a DOM (tests/unit/lab-html-block-bridge.test.ts).
 *
 * What it reuses, unchanged:
 *   - `buildSandboxSrcdoc` (lib/sandboxHtml.ts): CSP meta first, `default-src 'none'`.
 *     The iframe itself carries SANDBOX_GRANT + SANDBOX_ALLOW (HtmlBlock.tsx).
 *   - The full `dc-` kit: CHAT_HTML_KIT_CSS + KIT_BEHAVIOUR (tabs, diagrams), the
 *     same kit a Chat `dream-html` block writes against.
 *   - The app/v1 envelope (labAppRuntime.ts): the `__dreamLabApp` marker, the
 *     protocol version, a per-instance nonce, and `escapeForInlineScript` for
 *     every config value placed in a script.
 *
 * What it deliberately leaves out: the app runtime's height bridge (a block fills
 * its grid cell and scrolls inside it), `navigate` (a block has no pages), and
 * REACH_BRIDGE (app shortcuts do not reach into a focused block; noted in the plan).
 *
 * THE ALLOW-LIST. `lab.data(name)` is answered ONLY for a name the block declares
 * AND for which the host holds a frame (`BlockProps.inputs`, resolved on the server
 * from the hardened readers). Any other name gets an error result, never data:
 * a library body's author cannot reach inputs the card's author did not bind.
 *
 * GATE ORDER on every inbound message: `event.source` identity (never
 * `event.origin`, which is the string "null" for an opaque sandboxed frame), then
 * the envelope marker, then the nonce. A SECOND `load` on the iframe element can
 * only be the document navigating itself (the instance is pinned to one srcdoc;
 * edits remount it through its key), so it tears the bridge down for good.
 */

/** iframe -> host. */
export type HtmlBlockOutbound =
  | { type: 'ready' }
  | { type: 'data'; requestId: string; name: string };

/** host -> iframe. */
export type HtmlBlockInbound =
  | { type: 'dataResult'; requestId: string; ok: true; name: string; frame: Frame }
  | { type: 'dataResult'; requestId: string; ok: false; name: string; error: string }
  | { type: 'theme'; scheme: 'light' | 'dark'; tokens: Record<string, string> };

/**
 * The shim the block's srcdoc runs in its HEAD (before any author markup can
 * swallow it). `window.lab.inputs` lists the declared names; `lab.data(name)`
 * resolves to that input's frame or rejects with the host's error.
 */
export const HTML_BLOCK_RUNTIME_JS = `(function () {
  'use strict';
  var CFG = window.__LAB_BLOCK__ || {};
  var NONCE = CFG.nonce || '';
  var PROTOCOL = CFG.protocol || 1;
  var pending = {};
  var seq = 0;
  function post(type, extra) {
    var msg = { __dreamLabApp: 1, v: PROTOCOL, nonce: NONCE, type: type };
    for (var key in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, key)) msg[key] = extra[key];
    }
    parent.postMessage(msg, '*');
  }
  window.addEventListener('message', function (event) {
    if (event.source !== parent) return;
    var data = event.data;
    if (!data || typeof data !== 'object' || data.__dreamLabApp !== 1 || data.nonce !== NONCE) return;
    if (data.type === 'dataResult') {
      var cb = pending[data.requestId];
      if (!cb) return;
      delete pending[data.requestId];
      if (data.ok) cb.resolve(data.frame);
      else cb.reject(new Error(data.error || 'lab.data failed'));
      return;
    }
    if (data.type === 'theme') {
      var root = document.documentElement;
      if (data.scheme) root.style.colorScheme = data.scheme;
      if (data.tokens) {
        for (var token in data.tokens) {
          if (Object.prototype.hasOwnProperty.call(data.tokens, token)) root.style.setProperty(token, data.tokens[token]);
        }
      }
    }
  });
  window.lab = {
    inputs: (CFG.inputs || []).slice(),
    data: function (name) {
      var requestId = 'r' + (++seq);
      return new Promise(function (resolve, reject) {
        pending[requestId] = { resolve: resolve, reject: reject };
        post('data', { requestId: requestId, name: typeof name === 'string' ? name : '' });
      });
    }
  };
  post('ready', {});
})();`;

export interface HtmlBlockSrcdocInput {
  html: string;
  tokens: Record<string, string>;
  scheme: 'light' | 'dark';
  nonce: string;
  /** The declared input names, handed to the shim as `lab.inputs`. */
  inputs: readonly string[];
  /** The app locale, onto `<html lang>` (the dc- kit's uppercase labels are locale-sensitive). */
  lang?: string;
}

/** The complete srcdoc of one html block instance. */
export function buildHtmlBlockSrcdoc(input: HtmlBlockSrcdocInput): string {
  const { html, tokens, scheme, nonce, inputs, lang } = input;
  const config = { nonce, inputs: [...inputs], protocol: LAB_APP_PROTOCOL };
  const configScript = `window.__LAB_BLOCK__ = ${escapeForInlineScript(JSON.stringify(config))};`;
  const doc = buildSandboxSrcdoc({
    html,
    css: CHAT_HTML_KIT_CSS,
    tokens,
    scheme,
    headScript: `${configScript}\n${HTML_BLOCK_RUNTIME_JS}\n${KIT_BEHAVIOUR}`,
  });
  const langAttr = lang ? ` lang="${lang.replace(/[^a-zA-Z0-9-]/g, '')}"` : '';
  return doc.replace('<!doctype html><html>', `<!doctype html><html${langAttr} data-dc-mode="card">`);
}

// ─── Declared inputs ────────────────────────────────────────────────────────

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** An input name the engine accepts (block-library.ts `isSafeInputName`). */
export function isInputName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(name);
}

/**
 * The names a block declares. Inline html: the keys of `options.inputs`.
 * A library `ref`: the library entry's declared inputs (null until it loads =
 * nothing declared yet). The same rule the engine resolves frames by
 * (frames.ts `htmlBlockInputs`).
 */
export function declaredInputNames(block: Block, library: LibraryBlock | null): string[] {
  if (typeof block.options.ref === 'string' && block.options.ref) {
    return library ? library.inputs.map((i) => i.name).filter(isInputName) : [];
  }
  return Object.keys(asRecord(block.options.inputs) ?? {}).filter(isInputName);
}

// ─── Remount key ────────────────────────────────────────────────────────────

/** FNV-1a, 32-bit, hex. A change detector for React keys, not a security hash. */
export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function canonicalInputs(v: unknown): Array<[string, string]> {
  const r = asRecord(v) ?? {};
  return Object.keys(r).sort().map((k) => [k, typeof r[k] === 'string' ? (r[k] as string) : JSON.stringify(r[k] ?? null)]);
}

/** hash(html, inputs): the inline html (or the library body, once known), the ref and the bindings. */
export function htmlBlockHash(block: Block, resolvedHtml?: string | null): string {
  const html = typeof resolvedHtml === 'string'
    ? resolvedHtml
    : typeof block.options.html === 'string' ? block.options.html : '';
  const ref = typeof block.options.ref === 'string' ? block.options.ref : null;
  return hashString(JSON.stringify([html, ref, canonicalInputs(block.options.inputs)]));
}

/**
 * The React key an html block MUST be mounted under: card id + block path +
 * hash(html, inputs). Any edit to the markup or a binding, and any move in or
 * out of `tabs` (a new path), yields a new key, so the iframe remounts with a
 * fresh nonce and load counter; its `srcDoc` is never swapped in place.
 */
export function htmlBlockKey(cardId: string, path: readonly number[], block: Block): string {
  return `${cardId}:${path.join('.')}:html:${htmlBlockHash(block)}`;
}

/** The key for ANY block at a path: html blocks get {@link htmlBlockKey}, others card id + path + type. */
export function blockRenderKey(cardId: string, path: readonly number[], block: Block): string {
  return block.type === 'html' ? htmlBlockKey(cardId, path, block) : `${cardId}:${path.join('.')}:${block.type}`;
}

// ─── Host ───────────────────────────────────────────────────────────────────

/** The minimal window surface the host posts to (a real contentWindow, or a test double). */
export interface PostTarget {
  postMessage(message: unknown, targetOrigin: string): void;
}

export interface HtmlBlockHostOptions {
  nonce: string;
  /** The iframe's current contentWindow: the only source accepted, the only target posted to. */
  getFrameWindow: () => PostTarget | null | undefined;
  /** The declared names: the ONLY names `lab.data()` can ever answer. */
  getDeclared: () => readonly string[];
  /** The frames per declared input (BlockProps.inputs). */
  getInputs: () => Record<string, Frame> | undefined;
  /** Called once, when the document navigated itself. */
  onStop: (reason: string) => void;
}

export type HtmlBlockMessageOutcome = 'ignored' | 'ready' | 'answered' | 'refused';

export interface HtmlBlockHost {
  handleMessage(event: { source: unknown; data: unknown }): HtmlBlockMessageOutcome;
  handleLoad(): void;
  pushTheme(scheme: 'light' | 'dark', tokens: Record<string, string>): void;
  isTorn(): boolean;
}

/** The error text an iframe gets for a name it did not declare. */
export function undeclaredInputError(name: string): string {
  return `Input "${name}" is not declared by this block.`;
}

export function createHtmlBlockHost(opts: HtmlBlockHostOptions): HtmlBlockHost {
  let loads = 0;
  let torn = false;

  const post = (msg: HtmlBlockInbound): void => {
    if (torn) return;
    const target = opts.getFrameWindow();
    if (!target) return;
    target.postMessage({ ...msg, __dreamLabApp: 1, v: LAB_APP_PROTOCOL, nonce: opts.nonce }, '*');
  };

  return {
    handleMessage(event) {
      if (torn) return 'ignored';
      // GATE 1: identity. Only this instance's own frame, never anything else on the page.
      const own = opts.getFrameWindow();
      if (!own || event.source !== own) return 'ignored';
      // GATE 2: shape. GATE 3: this instance's nonce.
      if (!isLabAppEnvelope(event.data)) return 'ignored';
      if (event.data.nonce !== opts.nonce) return 'ignored';
      const msg = event.data as unknown as HtmlBlockOutbound;
      if (msg.type === 'ready') return 'ready';
      if (msg.type !== 'data' || typeof msg.requestId !== 'string') return 'ignored';
      const name = typeof msg.name === 'string' ? msg.name : '';
      const inputs = opts.getInputs() ?? {};
      const declared = opts.getDeclared().includes(name);
      if (!declared || !Object.prototype.hasOwnProperty.call(inputs, name)) {
        post({
          type: 'dataResult', requestId: msg.requestId, ok: false, name,
          error: declared ? `No data for input "${name}".` : undeclaredInputError(name),
        });
        return 'refused';
      }
      post({ type: 'dataResult', requestId: msg.requestId, ok: true, name, frame: inputs[name] });
      return 'answered';
    },
    handleLoad() {
      if (torn) return;
      loads += 1;
      if (loads >= 2) {
        torn = true;
        opts.onStop('html block navigated away from its srcdoc and was stopped.');
      }
    },
    pushTheme(scheme, tokens) {
      post({ type: 'theme', scheme, tokens });
    },
    isTorn: () => torn,
  };
}
