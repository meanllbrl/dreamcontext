import { useState } from 'react';
import { useTaxonomy } from '../hooks/useTaxonomy';
import { useI18n } from '../context/I18nContext';
import { tagHue } from '../lib/tagColor';
import './TaxonomyPage.css';

const FACET_LABELS: Record<string, string> = {
  domain: 'Domain',
  layer: 'Layer',
  kind: 'Kind',
  topic: 'Topic',
};

interface TagChipProps {
  tag: string;
  count: number;
  dimmed?: boolean;
}

function TagChip({ tag, count, dimmed }: TagChipProps) {
  return (
    <span
      className={`taxonomy-chip${dimmed ? ' taxonomy-chip--dim' : ''}`}
      data-hue={tagHue(tag)}
      title={count > 0 ? `${count} use${count === 1 ? '' : 's'}` : 'unused'}
    >
      <span className="taxonomy-chip-label">{tag}</span>
      {count > 0 && <span className="taxonomy-chip-count">{count}</span>}
    </span>
  );
}

interface ExpandableSectionProps {
  label: string;
  count: number;
  children: React.ReactNode;
  defaultOpen?: boolean;
}

function ExpandableSection({ label, count, children, defaultOpen = false }: ExpandableSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  if (count === 0) return null;
  return (
    <div className="taxonomy-expandable">
      <button
        className="taxonomy-expandable-header"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="taxonomy-expandable-chevron">{open ? '▾' : '▸'}</span>
        <span className="taxonomy-expandable-label">{label}</span>
        <span className="taxonomy-expandable-badge">{count}</span>
      </button>
      {open && <div className="taxonomy-expandable-body">{children}</div>}
    </div>
  );
}

export function TaxonomyPage() {
  const { t } = useI18n();
  const { data, isLoading, isError, error } = useTaxonomy();

  if (isLoading) return <div className="loading">{t('common.loading')}</div>;
  if (isError) return <div className="error-state">Failed to load taxonomy. {error?.message}</div>;
  if (!data) return null;

  const { vocabulary, usage, audit } = data;

  const facets = ['domain', 'layer', 'kind', 'topic'] as const;

  // Determine overall health: no untagged, no nonCanonical, no orphans, no nearDups
  const isHealthy =
    audit.untagged.length === 0 &&
    audit.nonCanonical.length === 0 &&
    audit.orphan.length === 0 &&
    audit.nearDups.length === 0;

  return (
    <div className="taxonomy-page">
      {/* ── Facet groups ── */}
      <section className="taxonomy-section">
        <h2 className="taxonomy-section-heading">Faceted Tags</h2>
        <div className="taxonomy-facets">
          {facets.map((facet) => {
            const tags = vocabulary.facetTags[facet] ?? [];
            if (tags.length === 0) return null;
            return (
              <div key={facet} className="taxonomy-facet-group">
                <span className="taxonomy-facet-label">{FACET_LABELS[facet] ?? facet}</span>
                <div className="taxonomy-chip-cluster">
                  {tags.map((tag) => {
                    const count = usage[tag] ?? 0;
                    return <TagChip key={tag} tag={tag} count={count} dimmed={count === 0} />;
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* ── Bare / legacy tags ── */}
      {vocabulary.bareTags.length > 0 && (
        <section className="taxonomy-section">
          <h2 className="taxonomy-section-heading">Bare Tags</h2>
          <div className="taxonomy-chip-cluster">
            {vocabulary.bareTags.map((tag) => {
              const count = usage[tag] ?? 0;
              return <TagChip key={tag} tag={tag} count={count} dimmed={count === 0} />;
            })}
          </div>
        </section>
      )}

      {/* ── Aliases ── */}
      {Object.keys(vocabulary.aliases).length > 0 && (
        <section className="taxonomy-section">
          <h2 className="taxonomy-section-heading">Aliases</h2>
          <div className="taxonomy-alias-list">
            {Object.entries(vocabulary.aliases).map(([alias, canonical]) => (
              <div key={alias} className="taxonomy-alias-pair">
                <span className="taxonomy-chip taxonomy-chip--alias" data-hue={tagHue(alias)}>
                  <span className="taxonomy-chip-label">{alias}</span>
                </span>
                <span className="taxonomy-alias-arrow" aria-hidden="true">→</span>
                <span className="taxonomy-chip" data-hue={tagHue(canonical)}>
                  <span className="taxonomy-chip-label">{canonical}</span>
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Drift / Audit panel ── */}
      <section className="taxonomy-section">
        <h2 className="taxonomy-section-heading">Drift Audit</h2>
        {isHealthy ? (
          <div className="taxonomy-healthy">
            <span className="taxonomy-healthy-icon">✓</span>
            <span>Taxonomy healthy — no drift detected.</span>
          </div>
        ) : (
          <div className="taxonomy-audit-panel">
            <ExpandableSection label="Untagged docs" count={audit.untagged.length} defaultOpen={audit.untagged.length > 0}>
              <ul className="taxonomy-audit-list">
                {audit.untagged.map((slug) => (
                  <li key={slug} className="taxonomy-audit-item">
                    <code>{slug}</code>
                  </li>
                ))}
              </ul>
            </ExpandableSection>

            <ExpandableSection label="Non-canonical tags" count={audit.nonCanonical.length} defaultOpen={audit.nonCanonical.length > 0}>
              <ul className="taxonomy-audit-list">
                {audit.nonCanonical.map((item, i) => (
                  <li key={i} className="taxonomy-audit-item taxonomy-audit-item--suggest">
                    <code className="taxonomy-audit-doc">{item.doc}</code>
                    <span className="taxonomy-audit-tag">{item.tag}</span>
                    {item.suggestion !== item.tag && (
                      <>
                        <span className="taxonomy-alias-arrow" aria-hidden="true">→</span>
                        <span className="taxonomy-audit-suggestion">{item.suggestion}</span>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </ExpandableSection>

            <ExpandableSection label="Orphan tags" count={audit.orphan.length} defaultOpen={audit.orphan.length > 0}>
              <ul className="taxonomy-audit-list">
                {audit.orphan.map((tag) => (
                  <li key={tag} className="taxonomy-audit-item">
                    <span className="taxonomy-audit-tag">{tag}</span>
                  </li>
                ))}
              </ul>
            </ExpandableSection>

            <ExpandableSection label="Near-duplicates" count={audit.nearDups.length} defaultOpen={audit.nearDups.length > 0}>
              <ul className="taxonomy-audit-list">
                {audit.nearDups.map(([a, b], i) => (
                  <li key={i} className="taxonomy-audit-item taxonomy-audit-item--pair">
                    <span className="taxonomy-audit-tag">{a}</span>
                    <span className="taxonomy-alias-arrow" aria-hidden="true">≈</span>
                    <span className="taxonomy-audit-tag">{b}</span>
                  </li>
                ))}
              </ul>
            </ExpandableSection>
          </div>
        )}
      </section>
    </div>
  );
}
