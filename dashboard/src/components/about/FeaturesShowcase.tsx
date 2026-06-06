import {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from 'react';
import { FlowDiagram } from './FlowDiagram';
import { FEATURES } from './features.data';
import './FeaturesShowcase.css';

/**
 * "One brain, many faculties" — a PINNED, scroll-SCRUBBED spotlight.
 *
 * The header + spotlight pin to the top of the scroll container while a tall
 * track scrolls past. Every faculty panel is stacked in the stage; a per-frame
 * handler maps the continuous scroll progress to each panel's opacity + slide,
 * so the page-change is *scrubbed by scroll* (the outgoing faculty fades/slides
 * out while the incoming one fades/slides in, tracking the scroll) rather than a
 * discrete swap with a canned entrance. The scrub is imperative (writes styles on
 * refs) so it never re-renders React per frame; React state only changes when the
 * centred faculty changes (rail highlight, counter, ARIA, diagram-animation gate).
 *
 * Stays a real WAI-ARIA tablist: click / arrow-key scrolls to that faculty's
 * point on the track, so scroll position is the single source of truth.
 *
 * Degradation: no scroll container (tests/SSR) or narrow screens disable the pin
 * (track height → auto, sticky → static) and it reads as a normal tablist showing
 * one panel at a time; reduced-motion drops the slide (opacity only).
 */
const CORE = FEATURES.filter((f) => f.defaultOpen);
const MORE = FEATURES.filter((f) => !f.defaultOpen);
const N = CORE.length;
const STICKY_TOP = 16; // px — must track the `top` on .feat-sticky (var(--space-4))
const STEP_VH = 62; // viewport-height of scroll allotted per faculty
const FADE = 0.72; // index-distance at which a panel is fully faded
const SLIDE = 40; // px a panel travels across one index-unit of scroll
const SETTLE_MS = 140; // scroll-idle delay before snapping to the nearest faculty
const SNAP_EPS = 8; // px tolerance — within this of a faculty centre, don't snap

export function FeaturesShowcase(): JSX.Element {
  const [active, setActive] = useState(0);
  const baseId = useId();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const panelRefs = useRef<(HTMLDivElement | null)[]>([]);
  const nearState = useRef<boolean[]>([]);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const stickyRef = useRef<HTMLDivElement | null>(null);
  const progressRef = useRef<HTMLSpanElement | null>(null);
  const reducedRef = useRef(false);
  const activeRef = useRef(0);

  const tabId = (i: number) => `${baseId}-tab-${i}`;
  const panelId = (i: number) => `${baseId}-panel-${i}`;

  const commitActive = useCallback((next: number) => {
    const clamped = Math.max(0, Math.min(N - 1, next));
    if (clamped === activeRef.current) return;
    activeRef.current = clamped;
    setActive(clamped);
  }, []);

  // Scroll-scrubbed transition + active tracking. useLayoutEffect so the first
  // paint already has the panels positioned (no flash of all-stacked panels).
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const sticky = stickyRef.current;
    if (!scroller || !sticky) return;
    reducedRef.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const container = (scroller.closest('.shell-main') as HTMLElement | null) ?? null;
    const source: HTMLElement | Window = container ?? window;
    let raf = 0;

    const measure = () => {
      raf = 0;
      const scRect = scroller.getBoundingClientRect();
      const contTop = container ? container.getBoundingClientRect().top : 0;
      const total = scRect.height - sticky.offsetHeight;
      if (total <= 0) return; // pin disabled (mobile / no room) — CSS shows active panel
      const progress = Math.max(0, Math.min(1, (contTop + STICKY_TOP - scRect.top) / total));
      if (progressRef.current) progressRef.current.style.transform = `scaleX(${progress})`;
      const center = progress * (N - 1);
      for (let i = 0; i < N; i++) {
        const el = panelRefs.current[i];
        if (!el) continue;
        const rel = i - center;
        const dist = Math.abs(rel);
        el.style.opacity = String(Math.max(0, 1 - dist / FADE));
        el.style.transform = reducedRef.current ? 'none' : `translate3d(0, ${rel * SLIDE}px, 0)`;
        const front = dist < 0.5;
        el.style.zIndex = front ? '2' : '1';
        el.style.pointerEvents = front ? 'auto' : 'none';
        const near = dist < 1.05; // gate diagram animation to visible panels only
        if (nearState.current[i] !== near) {
          nearState.current[i] = near;
          el.classList.toggle('feat-panel--near', near);
        }
      }
      commitActive(Math.round(center));
    };
    // When scrolling stops, settle to the nearest faculty so it never rests in a
    // half-cross-faded "intermediate form". Debounced on scroll-idle; the smooth
    // scroll it triggers re-fires this but then lands within SNAP_EPS → no-op (no
    // loop). Skipped at the very ends so the user can scroll into / out of the
    // section freely. Container-only (no snap in the window/test fallback).
    let settleTimer = 0;
    const settle = () => {
      if (!container) return;
      const scRect = scroller.getBoundingClientRect();
      const total = scRect.height - sticky.offsetHeight;
      if (total <= 0) return;
      const progress = (container.getBoundingClientRect().top + STICKY_TOP - scRect.top) / total;
      if (progress <= 0.012 || progress >= 0.988) return; // at the ends — let them leave
      const nearest = Math.round(progress * (N - 1));
      const deltaPx = (nearest / (N - 1) - progress) * total;
      if (Math.abs(deltaPx) < SNAP_EPS) return; // already settled
      container.scrollTo({ top: container.scrollTop + deltaPx, behavior: reducedRef.current ? 'auto' : 'smooth' });
    };

    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(measure);
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = window.setTimeout(settle, SETTLE_MS);
    };

    source.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    measure();
    return () => {
      source.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (raf) cancelAnimationFrame(raf);
      if (settleTimer) clearTimeout(settleTimer);
    };
  }, [commitActive]);

  // Click / keyboard → scroll to that faculty's point on the track so the scrub
  // and scroll position stay in sync (the scroll handler then commits + scrubs).
  const scrollToIndex = useCallback((i: number) => {
    const scroller = scrollerRef.current;
    const sticky = stickyRef.current;
    const container = scroller?.closest('.shell-main') as HTMLElement | null;
    if (!scroller || !sticky || !container) {
      commitActive(i);
      return;
    }
    const scRect = scroller.getBoundingClientRect();
    const total = scRect.height - sticky.offsetHeight;
    if (total <= 0) {
      commitActive(i);
      return;
    }
    const targetProgress = i / (N - 1);
    const delta =
      targetProgress * total - (container.getBoundingClientRect().top + STICKY_TOP - scRect.top);
    container.scrollTo({
      top: container.scrollTop + delta,
      behavior: reducedRef.current ? 'auto' : 'smooth',
    });
  }, [commitActive]);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    let next = activeRef.current;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = (activeRef.current + 1) % N;
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = (activeRef.current - 1 + N) % N;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = N - 1;
    else return;
    e.preventDefault();
    commitActive(next);
    tabRefs.current[next]?.focus();
    scrollToIndex(next);
  }

  return (
    <section className="about-section feat-section">
      <div
        className="feat-scroller"
        ref={scrollerRef}
        style={{ ['--feat-track-h' as string]: `${N * STEP_VH}vh` }}
      >
        <div className="feat-sticky" ref={stickyRef}>
          <p className="about-kicker">Everything inside</p>
          <h2 className="about-h2">One brain, many faculties.</h2>
          <p className="about-section-lead">
            Every capability dreamcontext gives your agents — <em>scroll to move through them, or pick one.</em>
          </p>

          <div className="feat-spotlight">
            <div className="feat-rail-wrap">
              <div className="feat-rail-head" aria-hidden="true">
                <span className="feat-rail-step">
                  {String(active + 1).padStart(2, '0')} <i>/ {String(N).padStart(2, '0')}</i>
                </span>
                <div className="feat-rail-track">
                  <span className="feat-rail-fill" ref={progressRef} />
                </div>
              </div>
              <div
                className="feat-rail"
                role="tablist"
                aria-orientation="vertical"
                aria-label="Core faculties"
                onKeyDown={onKeyDown}
              >
                {CORE.map((item, i) => {
                  const selected = i === active;
                  return (
                    <button
                      key={item.id}
                      ref={(el) => {
                        tabRefs.current[i] = el;
                      }}
                      id={tabId(i)}
                      role="tab"
                      type="button"
                      aria-selected={selected}
                      aria-controls={panelId(i)}
                      tabIndex={selected ? 0 : -1}
                      className={`feat-rail-item${selected ? ' feat-rail-item--active' : ''}`}
                      onClick={() => {
                        commitActive(i);
                        scrollToIndex(i);
                      }}
                    >
                      <span className="feat-rail-title">{item.title}</span>
                      {item.tag && <span className="feat-rail-tag">{item.tag}</span>}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* The stage: all faculty panels stacked, scrubbed by scroll. */}
            <div className="feat-stage">
              {CORE.map((item, i) => (
                <div
                  key={item.id}
                  ref={(el) => {
                    panelRefs.current[i] = el;
                  }}
                  className="feat-panel"
                  role="tabpanel"
                  id={panelId(i)}
                  aria-labelledby={tabId(i)}
                  aria-hidden={i !== active}
                  tabIndex={i === active ? 0 : -1}
                >
                  <div className="feat-stage-head">
                    {item.tag && <span className="feat-stage-chip">{item.tag}</span>}
                    <h3 className="feat-stage-title">{item.title}</h3>
                  </div>
                  <p className="feat-stage-body">{item.body}</p>
                  {item.flow && <FlowDiagram spec={item.flow} className="feat-stage-flow" />}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="feat-more">
        <div className="feat-more-head">
          <span className="feat-more-label">Everything else</span>
          <span className="feat-more-count">{MORE.length}</span>
        </div>
        <div className="feat-more-grid">
          {MORE.map((item) => (
            <div className="feat-more-card" key={item.id}>
              <span className="feat-more-glyph" aria-hidden="true">
                {item.glyph ?? '✦'}
              </span>
              <div className="feat-more-meta">
                <span className="feat-more-title">{item.title}</span>
                <span className="feat-more-tagline">{item.tagline}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
