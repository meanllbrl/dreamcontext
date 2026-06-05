import { useId, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import { FlowDiagram } from './FlowDiagram';
import { FEATURES } from './features.data';
import './FeaturesShowcase.css';

/**
 * "Everything inside" — a cinematic SPOTLIGHT of the feature catalogue.
 *
 * Left: a vertical rail of the signature (core) faculties as a real WAI-ARIA
 * tablist — click or arrow-key to select. Right: a large stage that shows the
 * selected faculty's title, description and its full-size living diagram, so the
 * section reveals one capability at a time instead of dumping 26 cards at once.
 * Below the spotlight, the long tail is a compact, scannable grid.
 *
 * This replaces the old all-open accordion wall: density is handled (one diagram
 * on screen), hierarchy is explicit (spotlight vs tail), alignment is uniform.
 */
const CORE = FEATURES.filter((f) => f.defaultOpen);
const MORE = FEATURES.filter((f) => !f.defaultOpen);

export function FeaturesShowcase(): JSX.Element {
  const [active, setActive] = useState(0);
  const baseId = useId();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const current = CORE[active];

  const tabId = (i: number) => `${baseId}-tab-${i}`;
  const panelId = `${baseId}-panel`;

  // Roving-focus keyboard nav across the vertical tablist.
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    let next = active;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = (active + 1) % CORE.length;
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = (active - 1 + CORE.length) % CORE.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = CORE.length - 1;
    else return;
    e.preventDefault();
    setActive(next);
    tabRefs.current[next]?.focus();
  }

  return (
    <section className="about-section feat-section">
      <p className="about-kicker">Everything inside</p>
      <h2 className="about-h2">One brain, many faculties.</h2>
      <p className="about-section-lead">
        Every capability dreamcontext gives your agents — <em>pick one to see how it works.</em>
      </p>

      <div className="feat-spotlight">
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
                aria-controls={panelId}
                tabIndex={selected ? 0 : -1}
                className={`feat-rail-item${selected ? ' feat-rail-item--active' : ''}`}
                onClick={() => setActive(i)}
              >
                <span className="feat-rail-title">{item.title}</span>
                {item.tag && <span className="feat-rail-tag">{item.tag}</span>}
              </button>
            );
          })}
        </div>

        {/* `key` re-mounts the stage on switch so the diagram + entrance replay. */}
        <div
          key={current.id}
          className="feat-stage"
          role="tabpanel"
          id={panelId}
          aria-labelledby={tabId(active)}
          tabIndex={0}
        >
          <div className="feat-stage-head">
            {current.tag && <span className="feat-stage-chip">{current.tag}</span>}
            <h3 className="feat-stage-title">{current.title}</h3>
          </div>
          <p className="feat-stage-body">{current.body}</p>
          {current.flow && <FlowDiagram spec={current.flow} className="feat-stage-flow" />}
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
