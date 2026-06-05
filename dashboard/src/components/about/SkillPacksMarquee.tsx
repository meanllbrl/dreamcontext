import { useMemo } from 'react';
import {
  usePacks,
  type CatalogPack,
  type CatalogStandalone,
} from '../../hooks/usePacks';
import './SkillPacksMarquee.css';

type MarqueeItem = CatalogPack | CatalogStandalone;

/** Packs carry a `base`; standalone skills don't — that's how we tell them apart. */
function isPack(item: MarqueeItem): item is CatalogPack {
  return 'base' in item;
}

interface MarqueeCardProps {
  item: MarqueeItem;
}

function MarqueeCard({ item }: MarqueeCardProps) {
  const kind = isPack(item) ? 'pack' : 'standalone';
  // Prefer the kind chip; fall back to the first tag if you'd rather show topic.
  const chipLabel = kind === 'pack' ? 'pack' : item.tags[0] ?? 'standalone';

  return (
    <li className="marquee-card">
      <span className={`marquee-chip marquee-chip--${kind}`}>{chipLabel}</span>
      <span className="marquee-card-name">{item.name}</span>
      {item.description && (
        <p className="marquee-card-desc">{item.description}</p>
      )}
    </li>
  );
}

/**
 * Skill packs marquee — an infinite, auto-scrolling row of every pack and
 * standalone skill in the catalog. Cards are sourced live from `usePacks()`
 * (packs + standalone concatenated) so the marquee never drifts from the
 * catalog. The list is rendered twice back-to-back inside `.marquee-track`;
 * CSS slides the track by -50% on a linear infinite loop, so the duplicate
 * second copy makes the seam invisible. The duplicate is `aria-hidden` and
 * hidden outright under reduced motion (where the track becomes a normal
 * horizontally-scrollable row). Scroll duration scales with card count.
 */
export function SkillPacksMarquee() {
  const { data, isLoading, isError } = usePacks();

  const items = useMemo<MarqueeItem[]>(() => {
    if (!data) return [];
    return [...data.packs, ...data.standalone];
  }, [data]);

  // ~2.2s of travel per card, clamped so tiny/huge catalogs stay watchable.
  const durationSeconds = Math.min(60, Math.max(40, items.length * 2.2));

  const header = (
    <>
      <p className="about-kicker">Skill packs</p>
      <h2 className="about-h2">A growing library of expertise.</h2>
      <p className="about-section-lead">
        The agent loads the right pack for the task — and more are added all the time.
      </p>
    </>
  );

  if (isLoading) {
    return (
      <section className="about-section">
        {header}
        <div className="marquee-viewport marquee-viewport--static" aria-hidden="true">
          <ul className="marquee-track marquee-track--skeleton">
            {Array.from({ length: 6 }).map((_, i) => (
              <li key={i} className="marquee-card marquee-card--skeleton" />
            ))}
          </ul>
        </div>
        <p className="marquee-status">Loading packs…</p>
      </section>
    );
  }

  // On error or an empty catalog, render the header without a broken track.
  if (isError || items.length === 0) {
    return (
      <section className="about-section">
        {header}
      </section>
    );
  }

  return (
    <section className="about-section">
      {header}
      <div
        className="marquee-viewport"
        style={{ '--marquee-duration': `${durationSeconds}s` } as React.CSSProperties}
      >
        <ul className="marquee-track">
          {items.map((item) => (
            <MarqueeCard key={`a-${item.name}`} item={item} />
          ))}
        </ul>
        <ul className="marquee-track marquee-track--dup" aria-hidden="true">
          {items.map((item) => (
            <MarqueeCard key={`b-${item.name}`} item={item} />
          ))}
        </ul>
      </div>
    </section>
  );
}
