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
  'lab.blocks.explorer.unknownFunnel': 'Funnel {id} is not in the data. Showing {name}.',
  'lab.blocks.explorer.unknownMetrics': 'Not in the data: {keys}',
};

vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => {}, t: (key: string) => COPY[key] ?? key }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}));

/** Direct calls (outside a React render) get stateless hooks; renders keep the real ones. */
const H = { on: false };
vi.mock('../../dashboard/node_modules/react/index.js', async (orig) => {
  const real = (await orig()) as typeof import('react');
  return {
    ...real,
    useState: <T,>(init: T) => (H.on ? [typeof init === 'function' ? (init as () => T)() : init, () => {}] : real.useState(init)),
    useId: () => (H.on ? 'uid' : real.useId()),
    useRef: <T,>(v: T) => (H.on ? { current: v } : real.useRef(v)),
  };
});

const { BreakdownBlock, selectionLabel, pickAxes, pinBlock, chipTipLeft, MAX_LANES } = await import(
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

/** The element tree a direct call returns (child components are not expanded). */
function tree(p: Props): ReactElement {
  H.on = true;
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
