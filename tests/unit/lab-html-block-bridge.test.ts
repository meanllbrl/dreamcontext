/**
 * The board `html` block's bridge (plan D4). The host half is a plain state
 * machine (htmlBlockBridge.ts) so every security rule is driven here with
 * fake windows and messages; this repo runs no DOM harness. The component
 * (HtmlBlock.tsx) is pinned at source level for the attributes a runtime test
 * would otherwise have to read.
 *
 * Covered: an undeclared `lab.data()` name is refused with an error result and
 * never data; the `event.source` gate; the nonce gate; a second `load` tears
 * the bridge down for good; the remount key changes on html, inputs and path;
 * the srcdoc carries the CSP first, the full dc- kit, the shim in the head, an
 * escaped config, and neither a height bridge nor REACH_BRIDGE.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildHtmlBlockSrcdoc,
  blockRenderKey,
  createHtmlBlockHost,
  declaredInputNames,
  htmlBlockHash,
  htmlBlockKey,
  undeclaredInputError,
  HTML_BLOCK_RUNTIME_JS,
  type PostTarget,
} from '../../dashboard/src/components/lab/blocks/htmlBlockBridge.js';
import { SANDBOX_CSP } from '../../dashboard/src/lib/sandboxHtml.js';
import { CHAT_HTML_KIT_CSS, KIT_BEHAVIOUR, REACH_BRIDGE, HEIGHT_BRIDGE } from '../../dashboard/src/components/sleepy/chat/chatHtmlKit.js';
import type { Frame } from '../../dashboard/src/generated/frameOps.js';
import type { Block, LibraryBlock } from '../../dashboard/src/components/lab/board/boardTypes.js';

const NONCE = 'nonce-fixture-1';

const SIGNUPS: Frame = {
  kind: 'value', insight: 'daily-signups', value: 42, prev: 40, spark: [38, 40, 42], unit: null,
};

function fakeWindow(): PostTarget & { sent: any[] } {
  const sent: any[] = [];
  return { sent, postMessage(message: unknown) { sent.push(message); } };
}

function envelope(extra: Record<string, unknown>, nonce = NONCE) {
  return { __dreamLabApp: 1, v: 1, nonce, ...extra };
}

function makeHost(opts: { declared?: string[]; inputs?: Record<string, Frame> } = {}) {
  const win = fakeWindow();
  const onStop = vi.fn();
  const host = createHtmlBlockHost({
    nonce: NONCE,
    getFrameWindow: () => win,
    getDeclared: () => opts.declared ?? ['signups'],
    getInputs: () => opts.inputs ?? { signups: SIGNUPS },
    onStop,
  });
  return { host, win, onStop };
}

describe('lab.data(name): the declared-input allow-list', () => {
  it('answers a declared name with its frame, under the nonce', () => {
    const { host, win } = makeHost();
    expect(host.handleMessage({ source: win, data: envelope({ type: 'data', requestId: 'r1', name: 'signups' }) })).toBe('answered');
    expect(win.sent).toHaveLength(1);
    expect(win.sent[0]).toMatchObject({ __dreamLabApp: 1, nonce: NONCE, type: 'dataResult', requestId: 'r1', ok: true, name: 'signups', frame: SIGNUPS });
  });

  it('refuses an undeclared name with an error result and no data', () => {
    // The host HOLDS a frame for `revenue`, but the block never declared it.
    const { host, win } = makeHost({ declared: ['signups'], inputs: { signups: SIGNUPS, revenue: SIGNUPS } });
    expect(host.handleMessage({ source: win, data: envelope({ type: 'data', requestId: 'r2', name: 'revenue' }) })).toBe('refused');
    expect(win.sent[0]).toMatchObject({ type: 'dataResult', requestId: 'r2', ok: false, error: undeclaredInputError('revenue') });
    expect(win.sent[0].frame).toBeUndefined();
  });

  it('refuses prototype keys and a missing name', () => {
    const { host, win } = makeHost();
    for (const name of ['__proto__', 'constructor', 'toString', '', undefined]) {
      expect(host.handleMessage({ source: win, data: envelope({ type: 'data', requestId: 'rx', name }) })).toBe('refused');
    }
    expect(win.sent.every((m) => m.ok === false && m.frame === undefined)).toBe(true);
  });

  it('refuses a declared name the host has no frame for (never another input)', () => {
    const { host, win } = makeHost({ declared: ['signups', 'churn'], inputs: { signups: SIGNUPS } });
    expect(host.handleMessage({ source: win, data: envelope({ type: 'data', requestId: 'r3', name: 'churn' }) })).toBe('refused');
    expect(win.sent[0]).toMatchObject({ ok: false });
    expect(win.sent[0].frame).toBeUndefined();
  });
});

describe('inbound gates', () => {
  it('ignores a message from any window but its own frame (event.source, never origin)', () => {
    const { host, win } = makeHost();
    const other = fakeWindow();
    expect(host.handleMessage({ source: other, data: envelope({ type: 'data', requestId: 'r1', name: 'signups' }) })).toBe('ignored');
    expect(host.handleMessage({ source: null, data: envelope({ type: 'data', requestId: 'r1', name: 'signups' }) })).toBe('ignored');
    expect(win.sent).toHaveLength(0);
    expect(other.sent).toHaveLength(0);
  });

  it('ignores a wrong or missing nonce', () => {
    const { host, win } = makeHost();
    expect(host.handleMessage({ source: win, data: envelope({ type: 'data', requestId: 'r1', name: 'signups' }, 'stale-nonce') })).toBe('ignored');
    expect(host.handleMessage({ source: win, data: { __dreamLabApp: 1, type: 'data', requestId: 'r1', name: 'signups' } })).toBe('ignored');
    expect(win.sent).toHaveLength(0);
  });

  it('ignores anything that is not our envelope', () => {
    const { host, win } = makeHost();
    for (const data of [null, 'hello', { type: 'data', nonce: NONCE }, { __dreamLabApp: 2, type: 'data', nonce: NONCE }]) {
      expect(host.handleMessage({ source: win, data })).toBe('ignored');
    }
    expect(win.sent).toHaveLength(0);
  });

  it('accepts ready', () => {
    const { host, win } = makeHost();
    expect(host.handleMessage({ source: win, data: envelope({ type: 'ready' }) })).toBe('ready');
  });
});

describe('load-count teardown', () => {
  it('the first load is the srcdoc; a second one stops the bridge for good', () => {
    const { host, win, onStop } = makeHost();
    host.handleLoad();
    expect(host.isTorn()).toBe(false);
    host.handleLoad();
    expect(host.isTorn()).toBe(true);
    expect(onStop).toHaveBeenCalledTimes(1);
    // Nothing is answered or posted after teardown, not even to its own window.
    expect(host.handleMessage({ source: win, data: envelope({ type: 'data', requestId: 'r9', name: 'signups' }) })).toBe('ignored');
    host.pushTheme('dark', { '--color-text': 'white' });
    expect(win.sent).toHaveLength(0);
    host.handleLoad();
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('pushes theme changes over the bridge while alive', () => {
    const { host, win } = makeHost();
    host.pushTheme('dark', { '--color-text': 'white' });
    expect(win.sent[0]).toMatchObject({ type: 'theme', scheme: 'dark', nonce: NONCE });
  });
});

describe('remount key = card id + block path + hash(html, inputs)', () => {
  const base: Block = { type: 'html', options: { html: '<div class="dc-card">Hi</div>', inputs: { signups: 'daily-signups' } } };

  it('changes when the html changes', () => {
    const edited: Block = { ...base, options: { ...base.options, html: '<div class="dc-card">Hello</div>' } };
    expect(htmlBlockKey('c-1', [0], edited)).not.toBe(htmlBlockKey('c-1', [0], base));
  });

  it('changes when an input binding changes or is added', () => {
    const rebound: Block = { ...base, options: { ...base.options, inputs: { signups: 'weekly-signups' } } };
    const added: Block = { ...base, options: { ...base.options, inputs: { signups: 'daily-signups', churn: 'churn' } } };
    const keys = new Set([base, rebound, added].map((b) => htmlBlockKey('c-1', [0], b)));
    expect(keys.size).toBe(3);
  });

  it('changes with the block path (a move into or out of tabs) and the card', () => {
    expect(htmlBlockKey('c-1', [1, 0, 0], base)).not.toBe(htmlBlockKey('c-1', [1], base));
    expect(htmlBlockKey('c-2', [0], base)).not.toBe(htmlBlockKey('c-1', [0], base));
  });

  it('changes when the ref changes, and when the library body resolves differently', () => {
    const a: Block = { type: 'html', options: { ref: 'kpi-strip' } };
    const b: Block = { type: 'html', options: { ref: 'kpi-grid' } };
    expect(htmlBlockKey('c-1', [0], a)).not.toBe(htmlBlockKey('c-1', [0], b));
    expect(htmlBlockHash(a, '<p>v1</p>')).not.toBe(htmlBlockHash(a, '<p>v2</p>'));
  });

  it('is stable for the same content regardless of input key order', () => {
    const reordered: Block = { type: 'html', options: { inputs: { b: 'y', a: 'x' }, html: 'z' } };
    const ordered: Block = { type: 'html', options: { html: 'z', inputs: { a: 'x', b: 'y' } } };
    expect(htmlBlockKey('c', [0], reordered)).toBe(htmlBlockKey('c', [0], ordered));
  });

  it('blockRenderKey delegates to htmlBlockKey for html and stays path-based otherwise', () => {
    expect(blockRenderKey('c-1', [2], base)).toBe(htmlBlockKey('c-1', [2], base));
    expect(blockRenderKey('c-1', [2], { type: 'line', data: 'x', options: {} })).toBe('c-1:2:line');
  });
});

describe('declared names', () => {
  it('inline: the keys of options.inputs, unsafe names dropped', () => {
    const block: Block = { type: 'html', options: { html: 'x', inputs: { signups: 'a', 'bad name': 'b', '../x': 'c' } } };
    expect(declaredInputNames(block, null)).toEqual(['signups']);
  });

  it('ref: the library entry declares, not the card; nothing until it loads', () => {
    const block: Block = { type: 'html', options: { ref: 'kpi', inputs: { signups: 'a', extra: 'b' } } };
    const lib: LibraryBlock = { slug: 'kpi', title: 'KPI', description: null, inputs: [{ name: 'signups', kind: 'value' }], html: '<p/>', rev: 'r' };
    expect(declaredInputNames(block, null)).toEqual([]);
    expect(declaredInputNames(block, lib)).toEqual(['signups']);
  });
});

describe('srcdoc', () => {
  const doc = buildHtmlBlockSrcdoc({
    html: '<div class="dc-card">body</div>',
    tokens: { '--color-text': 'black' },
    scheme: 'light',
    nonce: NONCE,
    inputs: ['signups', '</script><script>alert(1)</script>'],
    lang: 'tr',
  });
  const head = doc.slice(0, doc.indexOf('<body>'));

  it('puts the CSP first and keeps the sandbox CSP unchanged', () => {
    expect(doc.indexOf('Content-Security-Policy')).toBeLessThan(doc.indexOf('<style>'));
    expect(doc).toContain(`content="${SANDBOX_CSP}"`);
  });

  it('carries the full dc- kit: the kit CSS and KIT_BEHAVIOUR', () => {
    expect(doc).toContain(CHAT_HTML_KIT_CSS);
    expect(head).toContain(KIT_BEHAVIOUR);
  });

  it('runs the config and the shim in the head, before any author markup', () => {
    expect(head).toContain('window.__LAB_BLOCK__ = ');
    expect(head).toContain(HTML_BLOCK_RUNTIME_JS);
    expect(head).toContain(NONCE);
    expect(doc.indexOf(HTML_BLOCK_RUNTIME_JS)).toBeLessThan(doc.indexOf('dc-card">body'));
  });

  it('escapes config values so an input name cannot close the script', () => {
    expect(head).not.toContain('</script><script>alert(1)');
    expect(head).toContain('\\u003C/script>');
  });

  it('has no height bridge and no REACH_BRIDGE (the block fills its cell)', () => {
    expect(doc).not.toContain(REACH_BRIDGE);
    expect(doc).not.toContain(HEIGHT_BRIDGE);
    expect(HTML_BLOCK_RUNTIME_JS).not.toMatch(/height/i);
  });

  it('marks the locale on <html>', () => {
    expect(doc.startsWith('<!doctype html><html lang="tr" data-dc-mode="card">')).toBe(true);
  });

  it('the shim gates on event.source === parent and the nonce', () => {
    expect(HTML_BLOCK_RUNTIME_JS).toContain('event.source !== parent');
    expect(HTML_BLOCK_RUNTIME_JS).toContain('data.nonce !== NONCE');
  });
});

describe('HtmlBlock.tsx (source)', () => {
  const src = readFileSync(join(import.meta.dirname, '../../dashboard/src/components/lab/blocks/HtmlBlock.tsx'), 'utf-8');

  it('draws the iframe with the shared sandbox grant and the empty permissions list', () => {
    expect(src).toContain('sandbox={SANDBOX_GRANT}');
    expect(src).toContain('allow={SANDBOX_ALLOW}');
    expect(src).not.toMatch(/allow-same-origin/);
  });

  it('pins nonce and srcdoc at mount, keys the frame by hash(html, inputs), and counts loads', () => {
    expect(src).toMatch(/const \[instance\] = useState\(\(\) => \{[\s\S]*mintAppNonce\(\)/);
    expect(src).toContain('key={`${htmlBlockHash(block, html)}');
    expect(src).toContain('onLoad={() => host.handleLoad()}');
    expect(src).not.toMatch(/REACH_BRIDGE|HEIGHT_BRIDGE/);
  });
});
