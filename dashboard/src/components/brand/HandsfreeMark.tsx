import { createElement, useId, type ReactNode } from 'react';
import {
  handsfreeDecorTree, handsfreeMarkTree, hfIds, hfPaintClass,
  HF_DECOR_VIEWBOX, HF_MARK_VIEWBOX, type HfNode,
} from './handsfreeMarkGeometry';
import './handsfreeMark.css';

/** Markup attribute → React prop (the few the tree uses). */
const PROP: Record<string, string> = {
  'clip-path': 'clipPath',
  'stroke-width': 'strokeWidth',
  'stroke-linecap': 'strokeLinecap',
  'stroke-linejoin': 'strokeLinejoin',
};

function render(n: HfNode, key: number, extraClass?: string): ReactNode {
  const props: Record<string, string | number> = { key };
  for (const [k, v] of Object.entries(n.attrs)) props[PROP[k] ?? k] = v;
  const classes = [n.paint ? hfPaintClass(n.paint.kind, n.paint.role) : '', extraClass ?? ''].filter(Boolean);
  if (classes.length) props.className = classes.join(' ');
  return createElement(n.tag, props, ...(n.children ?? []).map((c, i) => render(c, i)));
}

/**
 * The hands-free mark: the dream gem with two sound waves ("dreamcontext you talk to"). Drawn
 * from `handsfreeMarkGeometry.ts` (the one description the icons and the phone's sign-in page are made
 * from too) and painted by the `--gem-*` tokens. `height` in px; the width follows the mark.
 * Decorative unless it is given a `title`.
 */
export function HandsfreeMark({ height = 24, title, className }: { height?: number; title?: string; className?: string }) {
  // Ids are per instance: two marks on one page must not share a clip path or gradient.
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const a11y = title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true, focusable: false };
  return (
    <svg
      className={['hfm', className].filter(Boolean).join(' ')}
      viewBox={HF_MARK_VIEWBOX}
      height={height}
      data-testid="handsfree-mark"
      {...a11y}
    >
      {handsfreeMarkTree(hfIds(`hfm-${uid}`)).map((n, i) => render(n, i))}
    </svg>
  );
}

/**
 * The faint gem outlines in a hands-free page's corners: decoration only (aria-hidden, no
 * pointer events), behind the page's content. The page positions it (`hfm-backdrop`).
 */
export function HandsfreeBackdrop() {
  const tree = handsfreeDecorTree();
  return (
    <div className="hfm-backdrop" aria-hidden="true" data-testid="handsfree-backdrop">
      {(['a', 'b'] as const).map((corner) => (
        <svg key={corner} className={`hfm-decor hfm-decor--${corner}`} viewBox={HF_DECOR_VIEWBOX} focusable="false">
          {tree.map((n, i) => render(n, i, 'hfm-decor-line'))}
        </svg>
      ))}
    </div>
  );
}
