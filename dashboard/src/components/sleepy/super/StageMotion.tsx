import { Component, type ReactNode, type RefObject } from 'react';
import { isLightMode } from '../../../lib/lightMode';
import { planLayoutMotion, type Rect, type StageBox } from './handoverMotion';
import { prefersReducedMotion, runLayoutMotion, type LayoutRun } from './motionRunner';
import type { StagePlan } from './superLayout';

export const cssEsc = (v: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(v) : v.replace(/["\\]/g, ''));

// ─── The layout motion (F8, FE2-FE4, D1) ───────────────────────────────────────

interface StageMotionProps {
  plan: StagePlan;
  /** The card under the owner's hand: the motion never touches it. */
  dragId: string | null;
  /** Visible, and no hand-over flight running: changes animate; otherwise they snap. */
  animate: boolean;
  rootRef: RefObject<HTMLDivElement | null>;
  layerRef: RefObject<HTMLDivElement | null>;
  underRef: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}

type Snapshot = { snap: true } | { snap: false; before: Map<string, StageBox> };

const rectIn = (el: Element, origin: DOMRect): Rect => {
  const r = el.getBoundingClientRect();
  return { x: r.left - origin.left, y: r.top - origin.top, width: r.width, height: r.height };
};

const sameRect = (a: Rect, b: Rect) => Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;

/** Two plans that draw the same screen: a re-render that changed nothing on the stage (a POST's
 *  echo, a slot epoch) must not cancel and restart a motion that is running. */
export function samePlan(a: StagePlan, b: StagePlan): boolean {
  if (a.width !== b.width || a.height !== b.height || !sameRect(a.centre, b.centre)) return false;
  const ka = Object.keys(a.cards);
  if (ka.length !== Object.keys(b.cards).length) return false;
  for (const k of ka) {
    const x = a.cards[k];
    const y = b.cards[k];
    if (!y || x.where !== y.where || x.shape !== y.shape || x.z !== y.z || !sameRect(x.rect, y.rect)) return false;
  }
  return true;
}

/**
 * Animates every change of the plan (FE2): `getSnapshotBeforeUpdate` reads the centre's and
 * every card's rect BEFORE the commit touches the DOM (a running transform included, so an
 * interrupted motion starts where the card really is; a card flying as a stand-in is read off
 * its stand-in); `componentDidUpdate` (before paint) cancels what runs, swaps a dropped card's
 * lift for its settle in the same commit, takes the LAST rects from the plan (pure, never the
 * homed chat's DOM) and starts the motion. A change of the stage's size snaps (FE4), as does
 * anything while the surface is hidden or the hand-over flights run.
 */
export class StageMotion extends Component<StageMotionProps> {
  private run: LayoutRun | null = null;

  getSnapshotBeforeUpdate(prev: StageMotionProps): Snapshot | null {
    if (prev.dragId === this.props.dragId && (prev.plan === this.props.plan || samePlan(prev.plan, this.props.plan))) return null;
    const root = this.props.rootRef.current;
    if (!root || !this.props.animate || !prev.animate) return { snap: true };
    if (prev.plan.width !== this.props.plan.width || prev.plan.height !== this.props.plan.height) return { snap: true };
    const origin = root.getBoundingClientRect();
    const before = new Map<string, StageBox>();
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-stage-key]'))) {
      const key = el.dataset.stageKey ?? '';
      if (!key) continue;
      const where = key === 'centre' ? 'centre' : prev.plan.cards[key]?.where ?? 'float';
      before.set(key, { rect: this.run?.standInRect(key, origin) ?? rectIn(el, origin), where });
    }
    for (const id of prev.plan.others) before.set(id, { rect: prev.plan.othersRect, where: 'others' });
    return { snap: false, before };
  }

  componentDidUpdate(prev: StageMotionProps, _state: unknown, snap: Snapshot | null) {
    if (!snap) return;
    const root = this.props.rootRef.current;
    // A dropped (or cancelled) card loses its lift in this same commit (FE2).
    for (const el of Array.from(root?.querySelectorAll<HTMLElement>('[data-lifted]') ?? [])) {
      if (el.dataset.stageKey === this.props.dragId) continue;
      el.style.transform = '';
      delete el.dataset.lifted;
    }
    this.run?.cancel();
    this.run = null;
    if (snap.snap || !root) return;
    const p = this.props.plan;
    const after = new Map<string, StageBox>([['centre', { rect: p.centre, where: 'centre' }]]);
    for (const c of Object.values(p.cards)) after.set(c.id, { rect: c.rect, where: c.where });
    const reduced = prefersReducedMotion();
    const light = isLightMode();
    const skip = [this.props.dragId];
    // A drop settle snaps under reduced motion and Light mode (dragging itself follows the pointer).
    if ((reduced || light) && prev.dragId && !this.props.dragId) skip.push(prev.dragId);
    for (const k of skip) if (k) { snap.before.delete(k); after.delete(k); }
    const motion = planLayoutMotion(snap.before, after, { reduced, light, othersRect: p.othersRect });
    const layer = this.props.layerRef.current;
    const under = this.props.underRef.current;
    if (motion.kind === 'none' || !layer || !under) return;
    const run = runLayoutMotion(motion, {
      layer,
      under,
      elFor: (key) => root.querySelector<HTMLElement>(`[data-stage-key="${cssEsc(key)}"]`),
    });
    this.run = run;
    void run.finished.then(() => { if (this.run === run) this.run = null; });
  }

  componentWillUnmount() {
    this.run?.cancel();
    this.run = null;
  }

  render() {
    return this.props.children;
  }
}

