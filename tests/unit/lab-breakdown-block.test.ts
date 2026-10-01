/**
 * The explorer's `breakdown` block (blocks/BreakdownBlock.tsx): one chip row per
 * funnel dimension driven by `breakdownAxes`, "All traffic" clears, an unmeasured
 * combination is an aria-disabled chip whose reason is described (and floats on
 * hover and focus) and whose click changes nothing: never a 0. The lane box pins
 * the selection (at most 4, never an unmeasured or duplicate one). Script strings
 * render as text. Static markup through the dashboard's own React; click handlers
 * are called on the element tree a direct call returns (no DOM harness at the
 * root). Its stylesheet speaks only in tokens (the lab-board-tokens rules).
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, isValidElement, type ReactElement, type ReactNode } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';
import type { FunnelFrame } from '../../dashboard/src/generated/frameOps.js';
import type { Block, BlockProps } from '../../dashboard/src/components/lab/board/boardTypes.js';

const COPY: Record<string, string> = {
  'lab.blocks.breakdown.all': 'All traffic',
  'lab.blocks.breakdown.clear': 'Clear',
  'lab.blocks.breakdown.pin': 'Pin {sel} as a lane',
  'lab.blocks.breakdown.lanes': 'Lanes',
  'lab.blocks.breakdown.lanesHint0': 'HINT0',
  'lab.blocks.breakdown.lanesHint1': 'HINT1',
  'lab.blocks.breakdown.lanesHintN': 'HINTN {n}',
  'lab.blocks.breakdown.lanesFull': 'FULL',
  'lab.blocks.breakdown.removeLane': 'Remove lane {n}',
  'lab.blocks.breakdown.unmeasured': 'Not measured: {reason}',
  'lab.blocks.breakdown.noPath': 'No measured path for this combination.',
  'lab.blocks.breakdown.noDims': 'NO DIMS',
  'lab.blocks.breakdown.anyValue': '{dim}: all',
  'lab.blocks.breakdown.optionUnmeasured': '{value} (not measured)',
  'lab.blocks.explorer.unknownFunnel': 'Funnel {id} is not in the data. Showing {name}.',
  'lab.blocks.explorer.unknownMetrics': 'Not in the data: {keys}',
};

vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => {}, t: (key: string) => COPY[key] ?? key }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}));

/**
 * Direct calls (outside a React render) get slot-backed state (slot 0 = the chip tip, slot 1 =
 * the compact form) and no effects; renders keep React's own hooks.
 */
const H: { on: boolean; slots: unknown[]; i: number } = { on: false, slots: [], i: 0 };
vi.mock('../../dashboard/node_modules/react/index.js', async (orig) => {
  const real = (await orig()) as typeof import('react');
  return {
    ...real,
    useState: <T,>(init: T) => {
      if (!H.on) return real.useState(init);
      const k = H.i++;
      return [k < H.slots.length ? H.slots[k] : typeof init === 'function' ? (init as () => T)() : init, () => {}];
    },
    useId: () => (H.on ? 'uid' : real.useId()),
    useRef: <T,>(v: T) => (H.on ? { current: v } : real.useRef(v)),
    useEffect: (...a: Parameters<typeof real.useEffect>) => (H.on ? undefined : real.useEffect(...a)),
    useLayoutEffect: (...a: Parameters<typeof real.useLayoutEffect>) => (H.on ? undefined : real.useLayoutEffect(...a)),
  };
});

const { BreakdownBlock, selectionLabel, pickAxes, pinBlock, chipTipLeft, fitsAgain, overflows, MAX_LANES } = await import(
  '../../dashboard/src/components/lab/blocks/BreakdownBlock.js'
);

const STEPS = [
  { key: 'visit', label: 'Visit', users: 1000 },
  { key: 'lead', label: 'Lead', users: 400 },
];
const seg = (dims: Record<string, string>, users: number) => ({
  dims, users, measured: true, reason: null, steps: [{ key: 'visit', users }, { key: 'lead', users: Math.round(users / 2) }],
});

/** Synthetic Acme explorer: platform x language, lookup mode, one intersection not measured. */
function frame(): FunnelFrame {
  return {
    kind: 'funnel',
    insight: 'acme-funnel-explorer',
    segmentMode: 'lookup',
    dimensions: [
      { key: 'platform', label: 'Platform', values: ['Meta Ads', 'TikTok Ads'] },
      { key: 'language', label: 'Language', values: ['EN', 'ES'] },
    ],
    funnels: [
      {
        id: 'quiz',
        name: 'Quiz checkout (v2)',
        steps: STEPS,
        segments: [
          seg({ platform: 'Meta Ads' }, 600),
          seg({ platform: 'TikTok Ads' }, 400),
          seg({ language: 'EN' }, 700),
          seg({ language: 'ES' }, 300),
          seg({ platform: 'Meta Ads', language: 'EN' }, 420),
          seg({ platform: 'Meta Ads', language: 'ES' }, 180),
          seg({ platform: 'TikTok Ads', language: 'EN' }, 280),
          { dims: { platform: 'TikTok Ads', language: 'ES' }, users: 120, steps: [], measured: false, reason: 'fewer than 300 users in the window' },
        ],
      },
      { id: 'ladder', name: 'Activation ladder', steps: STEPS },
    ],
  };
}

type Props = Partial<BlockProps>;
const BLOCK: Block = { type: 'funnel', data: 'acme-funnel-explorer', options: {} };

function props(p: Props): BlockProps & { block: Block } {
  return { frame: frame(), options: {}, block: BLOCK, ...p } as BlockProps & { block: Block };
}
const html = (p: Props) => renderToStaticMarkup(createElement(BreakdownBlock as never, props(p) as never) as ReactElement);

/** The element tree a direct call returns (child components are not expanded); `compact` = the small-cell form. */
function tree(p: Props, compact = false): ReactElement {
  Object.assign(H, { on: true, i: 0, slots: [null, compact] });
  try {
    return (BreakdownBlock as (x: unknown) => ReactElement)(props(p));
  } finally {
    H.on = false;
  }
}
function findAll(node: ReactNode, pred: (el: ReactElement<Record<string, unknown>>) => boolean): ReactElement<Record<string, unknown>>[] {
  const out: ReactElement<Record<string, unknown>>[] = [];
  const walk = (n: ReactNode) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!isValidElement(n)) return;
    const el = n as ReactElement<Record<string, unknown>>;
    if (pred(el)) out.push(el);
    walk(el.props.children as ReactNode);
  };
  walk(node);
  return out;
}
const chip = (root: ReactNode, dim: string, value: string) =>
  findAll(root, (e) => e.props['data-lab-breakdown-dim'] === dim)
    .flatMap((row) => findAll(row, (e) => e.props['data-lab-breakdown-chip'] === value))[0];
const click = (el: ReactElement<Record<string, unknown>>) => (el.props.onClick as () => void)();

describe('chips: one row per dimension, driven by breakdownAxes', () => {
  it('draws a labelled chip row per dim with pressed state from the selection', () => {
    const out = html({ selection: { platform: 'Meta Ads' } });
    expect(out.match(/data-lab-breakdown-dim="/g)).toHaveLength(2);
    expect(out).toContain('data-lab-breakdown-dim="platform"');
    expect(out).toMatch(/data-lab-breakdown-chip="Meta Ads"[^>]*aria-pressed="true"/);
    expect(out).toMatch(/data-lab-breakdown-chip="TikTok Ads"[^>]*aria-pressed="false"/);
    expect(out).toMatch(/data-lab-breakdown-all=""[^>]*aria-pressed="false"/);
    expect(html({})).toMatch(/data-lab-breakdown-all=""[^>]*aria-pressed="true"/);
  });

  it('a chip click toggles its value; the active chip clears; All traffic clears everything', () => {
    const onSelection = vi.fn();
    const root = tree({ selection: { platform: 'Meta Ads' }, onSelection });
    click(chip(root, 'language', 'EN'));
    expect(onSelection).toHaveBeenLastCalledWith({ platform: 'Meta Ads', language: 'EN' });
    click(chip(root, 'platform', 'Meta Ads'));
    expect(onSelection).toHaveBeenLastCalledWith({});
    click(chip(root, 'platform', 'TikTok Ads'));
    expect(onSelection).toHaveBeenLastCalledWith({ platform: 'TikTok Ads' });
    click(findAll(root, (e) => e.props['data-lab-breakdown-all'] === '')[0]);
    expect(onSelection).toHaveBeenLastCalledWith({});
  });

  it('`dims` picks and orders the rows; an unknown dim is named, never silently dropped', () => {
    const out = html({ options: { dims: ['language', 'nope'] } });
    expect(out).not.toContain('data-lab-breakdown-dim="platform"');
    expect(out).toContain('data-lab-breakdown-dim="language"');
    expect(out).toContain('Not in the data: nope');
    expect(pickAxes([{ key: 'a', label: 'A', chips: [] }, { key: 'b', label: 'B', chips: [] }], ['b', 'a']).axes.map((a) => a.key))
      .toEqual(['b', 'a']);
  });

  it('an unknown funnel pick falls back to the first funnel and says so', () => {
    const out = html({ options: { funnel: 'gone' } });
    expect(out).toContain('data-lab-unknown-funnel');
    expect(out).toContain('Funnel gone is not in the data. Showing Quiz checkout (v2).');
    expect(html({ options: { funnel: 'quiz' } })).not.toContain('data-lab-unknown-funnel');
  });

  it('a frame without dimensions says so; a non-funnel frame is the shared empty state', () => {
    expect(html({ frame: { ...frame(), dimensions: [] } })).toContain('NO DIMS');
    expect(html({ frame: { kind: 'empty', reason: 'no-cache', ref: null } })).toContain('data-empty-reason="no-cache"');
  });
});

describe('Not measured is not zero at the chip level', () => {
  it('the unmeasured combination is aria-disabled, described by its reason, and shows no count', () => {
    const out = html({ selection: { platform: 'TikTok Ads' }, options: { counts: true } });
    const es = out.match(/<button[^>]*data-lab-breakdown-chip="ES"[\s\S]*?<\/button>/)?.[0] ?? '';
    expect(es).toContain('aria-disabled="true"');
    expect(es).toContain('aria-describedby=');
    expect(es).toContain('Not measured: fewer than 300 users in the window');
    expect(es).not.toContain('data-lab-chip-users');
    expect(es).not.toMatch(/>0</);
    // Still focusable (no `disabled` attribute), so the reason can show on focus.
    expect(es).not.toMatch(/\sdisabled=""/);
    const en = out.match(/<button[^>]*data-lab-breakdown-chip="EN"[\s\S]*?<\/button>/)?.[0] ?? '';
    expect(en).not.toContain('aria-disabled');
    expect(en).toContain('data-lab-chip-users="280"');
  });

  it('clicking the unmeasured chip changes nothing', () => {
    const onSelection = vi.fn();
    click(chip(tree({ selection: { platform: 'TikTok Ads' }, onSelection }), 'language', 'ES'));
    expect(onSelection).not.toHaveBeenCalled();
  });

  it('hover AND focus open the reason tooltip; leaving and blurring close it', () => {
    const es = chip(tree({ selection: { platform: 'TikTok Ads' } }), 'language', 'ES');
    for (const on of ['onMouseEnter', 'onFocus', 'onMouseLeave', 'onBlur']) expect(typeof es.props[on]).toBe('function');
    const src = readFileSync(join(import.meta.dirname, '../../dashboard/src/components/lab/blocks/BreakdownBlock.tsx'), 'utf8');
    expect(src).toContain('data-lab-chip-reason={tip.title}');
    expect(src).toContain('role="tooltip"');
    expect(src).toMatch(/createPortal\(el, document\.body\)/);
  });

  it('a chip with no reason still reads as not measured, never as 0', () => {
    const f = frame();
    f.funnels[0].segments = f.funnels[0].segments!.filter((s) => !(s.dims.platform === 'TikTok Ads' && s.dims.language === 'ES'));
    const out = html({ frame: f, selection: { platform: 'TikTok Ads' }, options: { counts: true } });
    expect(out).toContain('Not measured: No measured path for this combination.');
  });

  it('the tip is kept inside the viewport', () => {
    expect(chipTipLeft({ left: 100, width: 40 }, 60, 800)).toBe(90);
    expect(chipTipLeft({ left: 0, width: 20 }, 200, 800)).toBe(0);
    expect(chipTipLeft({ left: 780, width: 20 }, 200, 800)).toBe(600);
  });
});

describe('counts', () => {
  it('off by default; on shows each measured chip its users', () => {
    expect(html({})).not.toContain('data-lab-chip-users');
    const out = html({ options: { counts: true } });
    expect(out).toContain('data-lab-chip-users="600"');
    expect(out).toContain('>600<');
  });
});

describe('lanes: pin up to 4 selections', () => {
  const lanes = (n: number) => [{ platform: 'Meta Ads' }, { platform: 'TikTok Ads' }, { language: 'EN' }, { language: 'ES' }].slice(0, n);

  it('the hint follows the count: none, one, several, full', () => {
    expect(html({ lanes: [] })).toContain('HINT0');
    expect(html({ lanes: lanes(1) })).toContain('HINT1');
    expect(html({ lanes: lanes(3) })).toContain('HINTN 3');
    expect(html({ lanes: lanes(4) })).toContain('FULL');
  });

  it('numbered badges each with a remove button; remove drops only that lane', () => {
    const out = html({ lanes: lanes(2) });
    expect(out).toContain('data-lab-lane="1"');
    expect(out).toContain('data-lab-lane="2"');
    expect(out).toContain('aria-label="Remove lane 2"');
    const onLanes = vi.fn();
    click(findAll(tree({ lanes: lanes(2), onLanes }), (e) => e.props['data-lab-lane-remove'] === 1)[0]);
    expect(onLanes).toHaveBeenLastCalledWith([{ platform: 'TikTok Ads' }]);
  });

  it('pin adds the current selection, labelled by its values', () => {
    const onLanes = vi.fn();
    const sel = { platform: 'Meta Ads', language: 'EN' };
    expect(html({ selection: sel })).toContain('Pin &#x27;Meta Ads · EN&#x27; as a lane');
    click(findAll(tree({ selection: sel, lanes: lanes(1), onLanes }), (e) => e.props['data-lab-lane-pin'] === '')[0]);
    expect(onLanes).toHaveBeenLastCalledWith([{ platform: 'Meta Ads' }, sel]);
  });

  it('pin is disabled at 4, for a duplicate, and for an unmeasured selection', () => {
    expect(html({ lanes: lanes(4), selection: { platform: 'Meta Ads', language: 'EN' } })).toMatch(/data-lab-lane-pin=""[^>]*data-blocked="full"[^>]*disabled/);
    expect(html({ lanes: lanes(1), selection: { platform: 'Meta Ads' } })).toMatch(/data-blocked="duplicate"/);
    expect(html({ selection: { platform: 'TikTok Ads', language: 'ES' } })).toMatch(/data-blocked="unmeasured"/);
    expect(html({ selection: { platform: 'Meta Ads' } })).not.toContain('data-blocked');
    expect(MAX_LANES).toBe(4);
    expect(pinBlock({ a: '1' }, [{ a: '1' }], true)).toBe('duplicate');
    expect(pinBlock({}, [], false)).toBe('unmeasured');
  });

  it('`lanes: false` hides the lane box', () => {
    expect(html({ options: { lanes: false } })).not.toContain('data-lab-breakdown-lanes');
  });

  it('selectionLabel reads in dimension order', () => {
    expect(selectionLabel({ language: 'EN', platform: 'Meta Ads' }, ['platform', 'language'])).toBe('Meta Ads · EN');
    expect(selectionLabel({}, ['platform'])).toBeNull();
  });
});

describe('script strings render as text, never HTML', () => {
  it('a dim label, a value and a reason carrying markup are escaped', () => {
    const f = frame();
    f.dimensions![0] = { key: 'platform', label: '<b>Plat</b>', values: ['<img src=x onerror=alert(1)>', 'TikTok Ads'] };
    f.funnels[0].segments!.push({ dims: { platform: '<img src=x onerror=alert(1)>' }, users: 5, steps: [], measured: false, reason: '<script>x()</script>' });
    const out = html({ frame: f });
    expect(out).not.toContain('<img src=x');
    expect(out).not.toContain('<b>Plat');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(out).toContain('&lt;script&gt;x()&lt;/script&gt;');
  });
});

describe('breakdown.css speaks only in tokens', () => {
  const css = readFileSync(join(import.meta.dirname, '../../dashboard/src/components/lab/blocks/breakdown.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const decls: { prop: string; value: string }[] = [];
  const re = /(^|[;{\s])(-?[a-z-]+)\s*:\s*([^;{}]+)(?=[;}])/g;
  for (let m = re.exec(css); m; m = re.exec(css)) if (!m[2].startsWith('--')) decls.push({ prop: m[2], value: m[3].trim() });

  it('no literal colour, off-ladder size or weight, literal duration or curve', () => {
    expect(decls.length).toBeGreaterThan(50);
    const bad = decls.filter(({ prop, value }) =>
      /#[0-9a-f]{3,8}\b/i.test(value)
      || /\b(rgba?|hsla?)\(/i.test(value)
      || /cubic-bezier\(/i.test(value)
      || (prop === 'font-size' && !/^(inherit|var\(--font-size-(xs|sm)\))$/.test(value))
      || (prop === 'font-weight' && !/^(400|600|inherit|var\(--font-weight-(normal|semibold)\))$/.test(value))
      || (/^(transition|animation)/.test(prop) && (value.match(/(?<![\w-])\d*\.?\d+m?s\b/g) ?? []).some((x) => parseFloat(x) !== 0)));
    expect(bad).toEqual([]);
  });
});

describe('W5: the active chip reads >= 4.5:1 in both themes', () => {
  const css = readFileSync(join(import.meta.dirname, '../../dashboard/src/components/lab/blocks/breakdown.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const tokens = readFileSync(join(import.meta.dirname, '../../dashboard/src/styles/tokens.css'), 'utf8');
  const darkAt = tokens.indexOf("[data-theme='dark']");
  const light = tokens.slice(0, darkAt);
  const dark = tokens.slice(darkAt);
  const raw = (part: string, name: string) => new RegExp(`${name}:\\s*([^;]+);`).exec(part)?.[1].trim() ?? null;
  /** A token in a theme: its own value, else the light one; `var(--x)` resolved the same way. */
  const tok = (part: string, name: string): string => {
    const v = raw(part, name) ?? raw(light, name);
    if (!v) throw new Error(`no ${name}`);
    const ref = /^var\((--[a-z-]+)\)$/.exec(v);
    return ref ? tok(part, ref[1]) : v;
  };
  const rgba = (v: string): [number, number, number, number] => {
    const hex = /^#([0-9a-f]{6})$/i.exec(v);
    if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)).concat(1) as [number, number, number, number];
    const m = /rgba?\(([^)]+)\)/.exec(v);
    if (!m) throw new Error(`colour ${v}`);
    const [r, g, b, a = '1'] = m[1].split(',').map((x) => x.trim());
    return [Number(r), Number(g), Number(b), Number(a)];
  };
  const lum = ([r, g, b]: number[]) => {
    const c = [r, g, b].map((x) => { const s = x / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const contrast = (part: string) => {
    const [tr, tg, tb, ta] = rgba(tok(part, '--color-accent-soft'));
    const base = rgba(tok(part, '--color-bg'));
    const bg = [tr, tg, tb].map((x, i) => x * ta + base[i] * (1 - ta));
    const [l1, l2] = [lum(rgba(tok(part, '--color-accent-ink'))), lum(bg)].sort((a, b) => b - a);
    return (l1 + 0.05) / (l2 + 0.05);
  };

  it('the pressed chip (All traffic too) and a chosen compact select wear accent ink on the tint over the canvas', () => {
    for (const sel of [".lab-breakdown-chip[aria-pressed='true'] {", ".lab-breakdown-select[data-active='true'] select {"]) {
      const rule = css.slice(css.indexOf(sel), css.indexOf('}', css.indexOf(sel)));
      expect(rule, sel).toContain('color: var(--color-accent-ink)');
      expect(rule, sel).toContain('background: linear-gradient(var(--color-accent-soft), var(--color-accent-soft)), var(--color-bg)');
      expect(rule, sel).not.toContain('--color-accent-text');
    }
  });

  it('measured from the tokens: light and dark both clear AA', () => {
    expect(contrast(light)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(dark)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('W5: the breakdown takes its content height, the tabs take the rest', () => {
  const board = readFileSync(join(import.meta.dirname, '../../dashboard/src/components/lab/board/board.css'), 'utf8');
  it('breakdown joins the content-height blocks (text, filter) in a card and inside tabs', () => {
    const m = /([^}]*\[data-lab-block='breakdown'\][^{]*)\{\s*flex: 0 1 auto;\s*\}/.exec(board);
    expect(m).not.toBeNull();
    expect(m![1]).toContain('.board-card-block:is(');
    expect(m![1]).toContain('.board-block-child:is(');
    // Every other block keeps the flexible share, so the tabs panel grows into the room.
    expect(board).toMatch(/\.board-card-block,\s*\.board-block-child \{\s*flex: 1 1 0;/);
  });
});

describe('W5: the small-cell form cuts nothing', () => {
  const small = (p: Props) => renderToStaticMarkup(tree(p, true));

  it('full chips by default; the compact form is one labelled select per dim, no chip rows', () => {
    expect(html({})).not.toContain('data-compact');
    const out = small({ options: { counts: true } });
    expect(out).toContain('data-compact="true"');
    expect(out).not.toContain('data-lab-breakdown-chip=');
    expect(out.match(/data-lab-breakdown-select="/g)).toHaveLength(2);
    expect(out).toContain('aria-label="Platform"');
    expect(out).toMatch(/<option value=""[^>]*>Platform: all<\/option>/);
    expect(out).toContain('Meta Ads · 600');
  });

  it('an unmeasured value is a disabled option saying so, with its reason, never a count', () => {
    const out = small({ selection: { platform: 'TikTok Ads' }, options: { counts: true } });
    const es = out.match(/<option[^>]*data-lab-breakdown-option="ES"[^>]*>[^<]*<\/option>/)?.[0] ?? '';
    expect(es).toContain('disabled=""');
    expect(es).toContain('title="Not measured: fewer than 300 users in the window"');
    expect(es).toContain('>ES (not measured)<');
    expect(out).toMatch(/data-active="true"[^>]*><select[^>]*data-lab-breakdown-select="platform"/);
  });

  it('a select sets its dim, and its "all" option clears only that dim', () => {
    const onSelection = vi.fn();
    const root = tree({ selection: { platform: 'Meta Ads' }, onSelection }, true);
    const select = (dim: string) => findAll(root, (e) => e.props['data-lab-breakdown-select'] === dim)[0];
    (select('language').props.onChange as (e: unknown) => void)({ target: { value: 'EN' } });
    expect(onSelection).toHaveBeenLastCalledWith({ platform: 'Meta Ads', language: 'EN' });
    (select('platform').props.onChange as (e: unknown) => void)({ target: { value: '' } });
    expect(onSelection).toHaveBeenLastCalledWith({});
  });

  it('lanes stay usable: numbered badges and an icon pin named by its action', () => {
    const onLanes = vi.fn();
    const out = small({ selection: { platform: 'Meta Ads' }, lanes: [{ language: 'EN' }] });
    expect(out).toContain('data-lab-lane="1"');
    expect(out).toContain('aria-label="Pin &#x27;Meta Ads&#x27; as a lane"');
    expect(out).not.toContain('data-lab-lanes-hint');
    click(findAll(tree({ selection: { platform: 'Meta Ads' }, lanes: [], onLanes }, true), (e) => e.props['data-lab-lane-pin'] === '')[0]);
    expect(onLanes).toHaveBeenLastCalledWith([{ platform: 'Meta Ads' }]);
  });

  it('the fit decision: compact when clipped, back only when the room it lacked returns or the width changes', () => {
    expect(overflows(180, 104)).toBe(true);
    expect(overflows(104.5, 104)).toBe(false);
    const memo = { need: 180, room: 104, outer: 120, cross: 300 };
    expect(fitsAgain(memo, 150, 300)).toBe(false);
    expect(fitsAgain(memo, 196, 300)).toBe(true);
    expect(fitsAgain(memo, 120, 640)).toBe(true);
  });
});
