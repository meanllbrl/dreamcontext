import { useEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import type { DebateDetail, PersonaDetail, ParsedRound } from '../../hooks/useCouncil';
import { useI18n } from '../../context/I18nContext';
import { PersonaAvatar } from './PersonaAvatar';
import { ModelBadge } from './ModelBadge';
import { extractPositionChip } from './lib/councilStats';

interface Props {
  debate: DebateDetail;
  focusSlug?: string | null;
}

function personaMatchesQuery(persona: PersonaDetail, query: string): boolean {
  if (!query.trim()) return true;
  const q = query.trim().toLowerCase();
  if (persona.slug.toLowerCase().includes(q)) return true;
  for (const r of persona.rounds) {
    const hay = [r.executiveSummary, r.position, r.reasoning, r.reactions, r.openQuestions]
      .filter(Boolean)
      .join('\n')
      .toLowerCase();
    if (hay.includes(q)) return true;
  }
  return false;
}

function highlight(text: string, query: string): string {
  if (!query.trim()) return text;
  const q = query.trim();
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`(${escaped})`, 'gi'), '<mark>$1</mark>');
}

export function TranscriptView({ debate, focusSlug }: Props) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const rootRef = useRef<HTMLDivElement | null>(null);

  const filtered = useMemo(
    () => debate.personas.filter((p) => personaMatchesQuery(p, query)),
    [debate.personas, query],
  );

  // Expand + scroll to the focused persona when requested
  useEffect(() => {
    if (!focusSlug) return;
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.delete(focusSlug);
      return next;
    });
    const t = setTimeout(() => {
      const el = rootRef.current?.querySelector(`[data-agent="${focusSlug}"]`) as HTMLElement | null;
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 30);
    return () => clearTimeout(t);
  }, [focusSlug]);

  const toggle = (slug: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  };

  return (
    <div className="council-transcript" ref={rootRef}>
      <div className="council-transcript-searchbar">
        <label className="council-transcript-search">
          <span aria-hidden>🔍</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('council.search.transcript')}
          />
        </label>
        <span className="council-transcript-count">
          {filtered.length} of {debate.personas.length} persona{debate.personas.length === 1 ? '' : 's'}
        </span>
      </div>

      <div className="council-transcript-body">
        {filtered.length === 0 && (
          <div className="council-empty">No personas match this search.</div>
        )}
        {filtered.map((persona) => (
          <PersonaBlock
            key={persona.slug}
            persona={persona}
            query={query}
            collapsed={collapsed.has(persona.slug)}
            highlighted={focusSlug === persona.slug}
            onToggle={() => toggle(persona.slug)}
          />
        ))}
      </div>
    </div>
  );
}

function PersonaBlock({
  persona,
  query,
  collapsed,
  highlighted,
  onToggle,
}: {
  persona: PersonaDetail;
  query: string;
  collapsed: boolean;
  highlighted: boolean;
  onToggle: () => void;
}) {
  return (
    <article
      className={`council-transcript-block ${highlighted ? 'is-highlighted' : ''}`}
      data-agent={persona.slug}
    >
      <header className="council-transcript-block-head" onClick={onToggle}>
        <div className="council-transcript-block-title">
          <PersonaAvatar slug={persona.slug} size={24} />
          <div>
            <h3 className="council-transcript-block-name">{persona.slug}</h3>
            <div className="council-transcript-block-meta">
              <ModelBadge model={persona.frontmatter.model} />
              {persona.frontmatter.aspects.slice(0, 4).map((a) => (
                <span key={a} className="council-aspect">{a}</span>
              ))}
            </div>
          </div>
        </div>
        <span className={`council-transcript-chev ${collapsed ? '' : 'is-open'}`} aria-hidden>▸</span>
      </header>

      {!collapsed && (
        <div className="council-transcript-block-body">
          {persona.persona && (
            <section className="council-sheet-section">
              <h4>Persona prompt</h4>
              <div
                className="council-sheet-prose"
                dangerouslySetInnerHTML={{ __html: highlight(marked.parse(persona.persona) as string, query) }}
              />
            </section>
          )}
          {persona.rounds.length === 0 && (
            <div className="council-sheet-empty">No rounds submitted.</div>
          )}
          {persona.rounds
            .slice()
            .sort((a, b) => b.round - a.round)
            .map((r) => (
              <RoundSection
                key={r.round}
                round={r}
                crossContext={persona.crossContext[r.round] ?? null}
                query={query}
              />
            ))}

          {persona.researches.length > 0 && (
            <section className="council-sheet-section">
              <h4>Research notes</h4>
              <ul className="council-research-list">
                {persona.researches.map((r) => (
                  <li key={r.slug}>
                    <span className="council-research-topic">{r.topic}</span>
                    <span className="council-research-date">{r.added_at}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </article>
  );
}

function RoundSection({
  round,
  crossContext,
  query,
}: {
  round: ParsedRound;
  crossContext: string | null;
  query: string;
}) {
  const chip = extractPositionChip(round.position);
  return (
    <section className="council-round-panel">
      <header className="council-round-panel-head">
        <h4 className="council-round-panel-title">Round {round.round}</h4>
        {chip && <span className="council-chip-pos">{chip}</span>}
      </header>
      {crossContext && (
        <blockquote className="council-crosscontext">
          <strong>Cross-context loaded</strong>
          <div
            className="council-sheet-prose"
            dangerouslySetInnerHTML={{ __html: highlight(marked.parse(crossContext) as string, query) }}
          />
        </blockquote>
      )}
      {round.executiveSummary && <Sub title="Executive summary" body={round.executiveSummary} query={query} />}
      {round.position && <Sub title="Position" body={round.position} query={query} />}
      {round.reasoning && <Sub title="Reasoning" body={round.reasoning} query={query} />}
      {round.reactions && <Sub title="Reactions to peers" body={round.reactions} query={query} />}
      {round.openQuestions && <Sub title="Open questions" body={round.openQuestions} query={query} />}
    </section>
  );
}

function Sub({ title, body, query }: { title: string; body: string; query: string }) {
  const html = highlight(marked.parse(body) as string, query);
  return (
    <div className="council-round-sub">
      <h5 className="council-round-sub-title">{title}</h5>
      <div className="council-sheet-prose" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
