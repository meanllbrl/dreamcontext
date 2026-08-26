/**
 * T4 — the `app/v1` bridge: protocol, the runtime shim (mirror-drift pinned,
 * the `lab-html-kit.css` idiom), `buildAppSrcdoc`'s delegation to the SAME
 * `buildSandboxSrcdoc` the Lab's html/v1 card and Chat's dream-html block
 * use, the pure `appModel.ts` lookups, and the security invariants of
 * `LabAppFrame.tsx` (gate order, M1 load-count teardown, M2 nonce, the
 * datasets-prop-only scope of `lab.data()`).
 *
 * No jsdom/RTL harness exists at the repo root (see vitest.config.ts —
 * `environment` defaults to 'node', no `@vitejs/plugin-react`), so this
 * file cannot MOUNT `LabAppFrame` or simulate real `postMessage`/`load`
 * events. Pure, DOM-free exports (labAppRuntime.ts, appModel.ts) are
 * exercised directly; the component's message-handling invariants are
 * pinned by SOURCE-TEXT assertions — the exact idiom
 * tests/unit/lab-html-body.test.ts already uses for HtmlInsightBody.tsx/
 * InsightCard.tsx/InsightDetailPanel.tsx. The full behavioral proof (a real
 * self-navigation attempt actually gets stopped, a height message actually
 * resizes the card, a malicious `navigate` actually gets capped) is T8's
 * job, in real Chromium — not this file's.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LAB_APP_PROTOCOL,
  LAB_APP_MESSAGE_MARKER,
  LAB_APP_RUNTIME_JS,
  isLabAppEnvelope,
  mintAppNonce,
  buildAppSrcdoc,
  escapeForInlineScript,
} from '../../dashboard/src/components/lab/labAppRuntime.js';
import {
  findAppPage,
  appPageIds,
  findDataset,
  type AppSpec,
  type AppPage,
  type Dataset,
  type DatasetBundle,
} from '../../dashboard/src/components/lab/appModel.js';
import { LAB_HTML_KIT_CSS } from '../../dashboard/src/components/lab/labHtmlKit.js';
import { SANDBOX_CSP, SANDBOX_GRANT, buildSandboxSrcdoc } from '../../dashboard/src/lib/sandboxHtml.js';

const DASH = join(import.meta.dirname, '../../dashboard/src/components/lab');

function page(id: string, extra: Partial<AppPage> = {}): AppPage {
  return { id, title: id.toUpperCase(), html: `<div>${id}</div>`, ...extra };
}

function dataset(key: string, extra: Partial<Dataset> = {}): Dataset {
  return { key, dims: [{ key: 'x' }], rows: [{ d: { x: 'a' }, v: 1 }], ...extra };
}

describe('protocol envelope', () => {
  it('pins the protocol version and message marker', () => {
    expect(LAB_APP_PROTOCOL).toBe(1);
    expect(LAB_APP_MESSAGE_MARKER).toBe('__dreamLabApp');
  });

  it('isLabAppEnvelope requires the marker, a string type, and a string nonce', () => {
    expect(isLabAppEnvelope({ __dreamLabApp: 1, type: 'ready', nonce: 'n' })).toBe(true);
    expect(isLabAppEnvelope({ type: 'ready', nonce: 'n' })).toBe(false); // no marker
    expect(isLabAppEnvelope({ __dreamLabApp: 1, nonce: 'n' })).toBe(false); // no type
    expect(isLabAppEnvelope({ __dreamLabApp: 1, type: 'ready' })).toBe(false); // no nonce
    expect(isLabAppEnvelope({ __dreamLabApp: 2, type: 'ready', nonce: 'n' })).toBe(false); // wrong marker value
    expect(isLabAppEnvelope(null)).toBe(false);
    expect(isLabAppEnvelope('hello')).toBe(false);
    expect(isLabAppEnvelope([])).toBe(false);
  });

  it('mintAppNonce returns a non-empty string, fresh per call', () => {
    const a = mintAppNonce();
    const b = mintAppNonce();
    expect(typeof a).toBe('string');
    expect(a.length).toBeGreaterThan(0);
    expect(a).not.toBe(b);
  });

  it('escapeForInlineScript neutralizes every "<" so a literal </script> cannot terminate early', () => {
    const evil = '</script><script>alert(1)</script>';
    const escaped = escapeForInlineScript(JSON.stringify({ v: evil }));
    expect(escaped).not.toContain('</script>');
    expect(escaped).toContain('\\u003C');
  });
});

describe('the runtime shim (mirror drift guard — the lab-html-kit.css idiom)', () => {
  it('LAB_APP_RUNTIME_JS is lab-app-runtime.js, byte for byte', () => {
    const file = readFileSync(join(DASH, 'lab-app-runtime.js'), 'utf-8');
    expect(LAB_APP_RUNTIME_JS).toBe(file);
  });

  it('measures document.body, never documentElement (the height-loop lesson)', () => {
    expect(LAB_APP_RUNTIME_JS).toContain('document.body.getBoundingClientRect()');
    expect(LAB_APP_RUNTIME_JS).not.toContain('document.documentElement.getBoundingClientRect()');
  });

  it('every outbound post carries the envelope fields', () => {
    expect(LAB_APP_RUNTIME_JS).toContain('__dreamLabApp: 1, v: PROTOCOL, nonce: NONCE, type: type');
  });

  it('every inbound message is checked against the marker AND the nonce before acting', () => {
    expect(LAB_APP_RUNTIME_JS).toContain("if (data.__dreamLabApp !== 1) return;");
    expect(LAB_APP_RUNTIME_JS).toContain('if (data.nonce !== NONCE) return;');
  });

  it('exposes window.lab.navigate/data/onRoute, page and params', () => {
    expect(LAB_APP_RUNTIME_JS).toContain('window.lab = {');
    expect(LAB_APP_RUNTIME_JS).toContain('navigate: function');
    expect(LAB_APP_RUNTIME_JS).toContain('data: function');
    expect(LAB_APP_RUNTIME_JS).toContain('onRoute: function');
  });
});

describe('buildAppSrcdoc — delegates to buildSandboxSrcdoc, never re-implements it', () => {
  const input = {
    page: page('a', { html: '<div class="lk-value">1</div>' }),
    pages: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }],
    tokens: { '--chart-1': '#123456' },
    scheme: 'dark' as const,
    params: { tab: 'x' },
    nonce: 'test-nonce-123',
  };

  it('produces EXACTLY what calling buildSandboxSrcdoc directly with the same html would', () => {
    // The shim is PREPENDED into `html`, never routed through `bodyScript` —
    // `buildSandboxSrcdoc` always places `bodyScript` AFTER `html`, but the
    // author's own inline script (inside `page.html`) calls `lab.data()`/
    // `lab.navigate()` SYNCHRONOUSLY as the first thing it does, so
    // `window.lab` must exist before `page.html` is even parsed.
    const config = { nonce: input.nonce, page: input.page.id, params: input.params, pages: input.pages, protocol: LAB_APP_PROTOCOL };
    const configScript = `window.__LAB_APP__ = ${escapeForInlineScript(JSON.stringify(config))};`;
    const preScript = [configScript, LAB_APP_RUNTIME_JS].join('\n');
    const expected = buildSandboxSrcdoc({
      html: `<script>${preScript}</script>${input.page.html}`,
      css: LAB_HTML_KIT_CSS,
      tokens: input.tokens,
      scheme: input.scheme,
      overrideCss: undefined,
    });
    expect(buildAppSrcdoc(input)).toBe(expected);
  });

  it('the runtime shim (and window.lab) is defined BEFORE the page html it precedes — the actual bug this shape once had', () => {
    const withPageScript = {
      ...input,
      page: page('a', { html: '<script>window.__authorCalledLabSync = typeof window.lab;</script>' }),
    };
    const doc = buildAppSrcdoc(withPageScript);
    const shimAt = doc.indexOf('window.lab = {');
    const pageScriptAt = doc.indexOf('window.__authorCalledLabSync');
    expect(shimAt).toBeGreaterThan(-1);
    expect(pageScriptAt).toBeGreaterThan(shimAt);
  });

  it('the CSP meta precedes any <style> tag, and is the SAME constant html/v1 uses', () => {
    const doc = buildAppSrcdoc(input);
    const cspAt = doc.indexOf('Content-Security-Policy');
    expect(cspAt).toBeGreaterThan(-1);
    expect(cspAt).toBeLessThan(doc.indexOf('<style>'));
    expect(doc).toContain(SANDBOX_CSP);
  });

  it('embeds resolved tokens, the lk- kit, and the page html', () => {
    const doc = buildAppSrcdoc(input);
    expect(doc).toContain('--chart-1: #123456;');
    expect(doc).toContain('.lk-table'); // the kit really is embedded
    expect(doc).toContain('<div class="lk-value">1</div>');
    expect(doc).toContain('color-scheme: dark;');
  });

  it('embeds a per-instance config assignment before the runtime shim', () => {
    const doc = buildAppSrcdoc(input);
    const cfgAt = doc.indexOf('window.__LAB_APP__');
    const shimAt = doc.indexOf('window.lab = {');
    expect(cfgAt).toBeGreaterThan(-1);
    expect(shimAt).toBeGreaterThan(cfgAt);
    expect(doc).toContain('"nonce":"test-nonce-123"');
    expect(doc).toContain('"page":"a"');
  });

  it('appends the author shell.script AFTER the runtime shim, and shell.style as the override', () => {
    const withShell = { ...input, shell: { style: '.x{color:red}', script: 'window.__authorRan = true;' } };
    const doc = buildAppSrcdoc(withShell);
    expect(doc.indexOf('window.lab = {')).toBeLessThan(doc.indexOf('window.__authorRan'));
    expect(doc).toContain('.x{color:red}');
  });

  it('escapes a </script> hiding inside a param value so it cannot break out of the config script', () => {
    const hostile = { ...input, params: { evil: '</script><script>alert(1)</script>' } };
    const doc = buildAppSrcdoc(hostile);
    expect(doc).not.toContain('</script><script>alert(1)</script>');
    expect(doc).toContain('\\u003C/script');
  });
});

describe('appModel — pure lookups (the ONLY route the bridge has to spec/data)', () => {
  const spec: AppSpec = {
    kind: 'app/v1',
    entry: 'overview',
    pages: [page('overview'), page('steps'), page('detail')],
  };

  it('findAppPage: an explicit id resolves to that page', () => {
    expect(findAppPage(spec, 'steps')?.id).toBe('steps');
  });

  it('findAppPage: null/undefined resolves to entry', () => {
    expect(findAppPage(spec, null)?.id).toBe('overview');
    expect(findAppPage(spec, undefined)?.id).toBe('overview');
  });

  it('findAppPage: an unknown id falls back to entry, never blanks', () => {
    expect(findAppPage(spec, 'nonexistent')?.id).toBe('overview');
  });

  it('findAppPage: entry missing from pages falls back to the first page', () => {
    const broken: AppSpec = { kind: 'app/v1', entry: 'ghost', pages: [page('only')] };
    expect(findAppPage(broken, null)?.id).toBe('only');
  });

  it('findAppPage: zero pages resolves to null', () => {
    const empty: AppSpec = { kind: 'app/v1', entry: 'x', pages: [] };
    expect(findAppPage(empty, null)).toBeNull();
  });

  it('appPageIds: every declared id, in author order', () => {
    expect(appPageIds(spec)).toEqual(['overview', 'steps', 'detail']);
  });

  it('findDataset: an explicit key resolves to that dataset', () => {
    const bundle: DatasetBundle = { kind: 'dataset/v1', datasets: [dataset('a'), dataset('b')] };
    expect(findDataset(bundle, 'b')?.key).toBe('b');
  });

  it('findDataset: no key falls back to bundle.primary', () => {
    const bundle: DatasetBundle = { kind: 'dataset/v1', primary: 'b', datasets: [dataset('a'), dataset('b')] };
    expect(findDataset(bundle, null)?.key).toBe('b');
  });

  it("findDataset: no key and no primary falls back to the literal 'series' (seriesToDatasetBundle's pin)", () => {
    const bundle: DatasetBundle = { kind: 'dataset/v1', datasets: [dataset('series'), dataset('other')] };
    expect(findDataset(bundle, null)?.key).toBe('series');
  });

  it('findDataset: no matching key/primary/series falls back to the first dataset', () => {
    const bundle: DatasetBundle = { kind: 'dataset/v1', datasets: [dataset('funnel'), dataset('language')] };
    expect(findDataset(bundle, null)?.key).toBe('funnel');
    expect(findDataset(bundle, 'unknown-key')?.key).toBe('funnel');
  });

  it('findDataset: an empty or absent bundle resolves to null — never throws', () => {
    expect(findDataset(null, 'x')).toBeNull();
    expect(findDataset(undefined, 'x')).toBeNull();
    expect(findDataset({ kind: 'dataset/v1', datasets: [] }, 'x')).toBeNull();
  });
});

describe('LabAppFrame.tsx (security pins — source-text, no jsdom harness in this repo)', () => {
  const source = readFileSync(join(DASH, 'LabAppFrame.tsx'), 'utf-8');

  it('imports the sandbox grant and CSP builder UNCHANGED from lib/sandboxHtml — never re-declares them', () => {
    expect(source).toContain("import { SANDBOX_GRANT } from '../../lib/sandboxHtml'");
    expect(source).toContain('sandbox={SANDBOX_GRANT}');
    expect(source).not.toMatch(/sandbox=\{?["'][^"'}]*allow-same-origin/);
  });

  it('never authenticates by comparing event.origin — a sandboxed frame\'s origin is the string "null"', () => {
    // Prose may (and does) explain WHY origin is never checked; the code
    // itself must never compare it. No `event.origin` next to `===`/`!==`.
    expect(source).not.toMatch(/event\.origin\s*[!=]==/);
    expect(source).not.toMatch(/[!=]==\s*event\.origin/);
  });

  it('gate order is source identity -> envelope shape -> nonce, in that exact order', () => {
    const gate1 = source.indexOf('event.source !== frameRef.current?.contentWindow');
    const gate2 = source.indexOf('isLabAppEnvelope(event.data)');
    const gate3 = source.indexOf('event.data.nonce !== instance.nonce');
    expect(gate1).toBeGreaterThan(-1);
    expect(gate2).toBeGreaterThan(gate1);
    expect(gate3).toBeGreaterThan(gate2);
  });

  it('M1 — a second load event tears the instance down permanently', () => {
    expect(source).toContain('loadCountRef.current += 1');
    expect(source).toContain('loadCountRef.current >= 2');
    expect(source).toContain("stop('app body navigated away from its srcdoc and was stopped.')");
    // Once torn, it never re-arms: every entry point re-checks tornRef first.
    expect(source).toContain('if (tornRef.current) return;');
  });

  it('M1 — teardown stops outbound AND inbound, and forces a fresh key (discards the live document)', () => {
    expect(source).toContain('tornRef.current = true');
    expect(source).toContain('setInstanceKey((k) => k + 1)');
    // postToFrame refuses to send once torn — checked BEFORE it touches the frame.
    const postFn = source.slice(source.indexOf('const postToFrame ='), source.indexOf('const postToFrame =') + 300);
    expect(postFn).toContain('if (tornRef.current) return;');
  });

  it('M2 — a fresh nonce is minted per mounted instance, inside the once-per-mount initializer', () => {
    const initBlock = source.slice(source.indexOf('const [instance] = useState'), source.indexOf('return { page, nonce, srcDoc };'));
    expect(initBlock).toContain('mintAppNonce()');
  });

  it('lab.data resolves from the datasets PROP (via its ref) and nothing else reachable', () => {
    // Exactly one call site answers a `data` request, and it takes its
    // dataset from `datasetsRef.current` (which mirrors the `datasets`
    // prop) plus the requested key — nothing else.
    const occurrences = source.split('findDataset(').length - 1;
    expect(occurrences).toBe(1);
    expect(source).toContain('findDataset(datasetsRef.current, msg.dataset ?? null)');
    // No import or prop gives this component a route to credentials, the
    // manifest, or another insight's cache — the only data-shaped import is
    // appModel's own findDataset/findAppPage/appPageIds.
    expect(source).not.toMatch(/from ['"].*\/(credentials|store|sync)\.js['"]/);
    expect(source).not.toMatch(/\bprops\.credentials\b|\bmanifest\.source\b/);
  });

  it('the srcdoc is built exactly ONCE per mount — never rebuilt on a theme or param change', () => {
    const occurrences = source.split('buildAppSrcdoc(').length - 1;
    expect(occurrences).toBe(1);
    const onceSite = source.slice(source.indexOf('const [instance] = useState'), source.indexOf('buildAppSrcdoc(') + 20);
    expect(onceSite).toContain('useState(() => {');
  });

  it('theme flips over the bridge (a postToFrame theme message), not a srcdoc rebuild', () => {
    expect(source).toMatch(/postToFrame\(\{\s*type: 'theme'/);
  });

  it('card mode is a preview, not an interactive surface — pointerEvents none, height clamped 120-320', () => {
    expect(source).toContain('const CARD_MIN_HEIGHT = 120;');
    expect(source).toContain('const CARD_MAX_HEIGHT = 320;');
    expect(source).toContain("pointerEvents: mode === 'card' ? 'none' : 'auto'");
  });

  it('page/full height clamps to 200-20000, and full mode ignores height messages entirely', () => {
    expect(source).toContain('const PAGE_MIN_HEIGHT = 200;');
    expect(source).toContain('const PAGE_MAX_HEIGHT = 20000;');
    expect(source).toContain("if (mode === 'full') return;");
  });

  it('an unknown navigate target is dropped, never forwarded to the host router', () => {
    expect(source).toContain('appPageIds(spec).includes(msg.page)');
    expect(source).toMatch(/console\.warn\(`\[lab-app\] \$\{slug\}: navigate to unknown page/);
  });
});
