import { useEffect, useMemo, useRef } from 'react';
import { marked } from 'marked';
import type { DebateDetail, ParsedRound, PersonaDetail } from '../../hooks/useCouncil';
import { PersonaAvatar } from './PersonaAvatar';
import { ModelBadge } from './ModelBadge';
import {
  categorizePosition,
  countOpenQuestions,
  countReactions,
  extractPositionChip,
  extractReactionTargets,
  findRound,
} from './lib/councilStats';

interface Props {
  debate: DebateDetail;
  query: string;
  onQueryChange: (q: string) => void;
  selected: { slug: string; round: number } | null;
  onSelectCell: (slug: string, round: number) => void;
  onClearSelection: () => void;
}

function cellMatches(data: ParsedRound | null, query: string): boolean {
  if (!query.trim()) return true;
  if (!data) return false;
  const hay = [data.executiveSummary, data.position, data.reasoning]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
  return hay.includes(query.trim().toLowerCase());
}

export function ArenaMatrix({
  debate,
  query,
  onQueryChange,
  selected,
  onSelectCell,
  onClearSelection,
}: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const rounds = useMemo(
    () => Array.from({ length: Math.max(1, debate.frontmatter.rounds_planned) }, (_, i) => i + 1),
    [debate.frontmatter.rounds_planned],
  );
  const knownSlugs = useMemo(() => debate.personas.map((p) => p.slug), [debate.personas]);

  const matchCount = useMemo(() => {
    if (!query.trim()) return null;
    let n = 0;
    for (const p of debate.personas) for (const r of rounds) if (cellMatches(findRound(p, r), query)) n++;
    return n;
  }, [query, debate, rounds]);

  // Keyboard nav across cells when one is selected
  useEffect(() => {
    if (!selected) return;
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return;
      if (e.key === 'Escape') {
        onClearSelection();
        return;
      }
      const idx = debate.personas.findIndex((p) => p.slug === selected.slug);
      if (idx === -1) return;
      const roundsCount = debate.frontmatter.rounds_planned;
      if (e.key === 'ArrowRight' && selected.round < roundsCount) {
        e.preventDefault();
        onSelectCell(selected.slug, selected.round + 1);
      } else if (e.key === 'ArrowLeft' && selected.round > 1) {
        e.preventDefault();
        onSelectCell(selected.slug, selected.round - 1);
      } else if (e.key === 'ArrowDown' && idx < debate.personas.length - 1) {
        e.preventDefault();
        onSelectCell(debate.personas[idx + 1].slug, selected.round);
      } else if (e.key === 'ArrowUp' && idx > 0) {
        e.preventDefault();
        onSelectCell(debate.personas[idx - 1].slug, selected.round);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selected, debate, onClearSelection, onSelectCell]);

  // Scroll selected cell into view
  useEffect(() => {
    if (!selected || !rootRef.current) return;
    const el = rootRef.current.querySelector(
      `[data-persona="${selected.slug}"][data-round="${selected.round}"]`,
    ) as HTMLElement | null;
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [selected]);

  return (
    <div className="council-matrix">
      <div className="council-matrix-bar">
        <label className="council-matrix-search-input">
          <span className="council-matrix-search-icon" aria-hidden>🔍</span>
          <input
            type="search"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Filter cells by text…"
          />
          {query && (
            <button type="button" className="council-matrix-search-clear" onClick={() => onQueryChange('')}>×</button>
          )}
        </label>
        {matchCount != null && (
          <span className="council-matrix-count">{matchCount} match{matchCount === 1 ? '' : 'es'}</span>
        )}
      </div>

      <div className="council-matrix-scroll" ref={rootRef}>
        <div
          className="council-matrix-grid"
          style={{ gridTemplateColumns: `180px repeat(${rounds.length}, minmax(220px, 1fr))` }}
        >
          <div className="council-matrix-corner" aria-hidden />
          {rounds.map((round) => {
            const isRunning = debate.frontmatter.status === `round_${round}_running`;
            const isComplete = debate.frontmatter.current_round >= round && !isRunning;
            return (
              <div
                key={`h-${round}`}
                className={`council-round-head ${isRunning ? 'is-running' : ''} ${isComplete ? 'is-done' : ''}`}
              >
                Round {round}
              </div>
            );
          })}

          {debate.personas.map((persona) => (
            <ArenaRow
              key={persona.slug}
              persona={persona}
              rounds={rounds}
              debate={debate}
              query={query}
              selected={selected}
              knownSlugs={knownSlugs}
              onSelectCell={onSelectCell}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function ArenaRow({
  persona,
  rounds,
  debate,
  query,
  selected,
  knownSlugs,
  onSelectCell,
}: {
  persona: PersonaDetail;
  rounds: number[];
  debate: DebateDetail;
  query: string;
  selected: { slug: string; round: number } | null;
  knownSlugs: string[];
  onSelectCell: (slug: string, round: number) => void;
}) {
  return (
    <>
      <aside className="council-matrix-row-head">
        <PersonaAvatar slug={persona.slug} size={22} />
        <div className="council-matrix-row-id">
          <div className="council-matrix-row-name">{persona.slug}</div>
          <ModelBadge model={persona.frontmatter.model} />
        </div>
      </aside>
      {rounds.map((round) => {
        const data = findRound(persona, round);
        const isRunning = debate.frontmatter.status === `round_${round}_running`;
        const active = !!selected && selected.slug === persona.slug && selected.round === round;
        const matches = cellMatches(data, query);
        const dimmed = !!query.trim() && !matches;
        return (
          <MatrixCell
            key={round}
            personaSlug={persona.slug}
            round={round}
            data={data}
            isRunning={isRunning}
            active={active}
            dimmed={dimmed}
            knownSlugs={knownSlugs}
            onSelect={onSelectCell}
          />
        );
      })}
    </>
  );
}

function MatrixCell({
  personaSlug,
  round,
  data,
  isRunning,
  active,
  dimmed,
  knownSlugs,
  onSelect,
}: {
  personaSlug: string;
  round: number;
  data: ParsedRound | null;
  isRunning: boolean;
  active: boolean;
  dimmed: boolean;
  knownSlugs: string[];
  onSelect: (slug: string, round: number) => void;
}) {
  if (!data) {
    return (
      <div
        className={`council-cell council-cell--empty ${isRunning ? 'council-cell--pending' : ''} ${dimmed ? 'is-dimmed' : ''}`}
        data-persona={personaSlug}
        data-round={round}
      >
        <span className="council-cell-empty-label">{isRunning ? 'awaiting…' : '— silent —'}</span>
      </div>
    );
  }

  const chip = extractPositionChip(data.position);
  const cat = categorizePosition(data.position);
  const reactions = countReactions(data);
  const questions = countOpenQuestions(data);
  const reactionTargets = extractReactionTargets(data, knownSlugs);

  return (
    <button
      type="button"
      className={`council-cell council-cell--${cat} ${active ? 'is-active' : ''} ${dimmed ? 'is-dimmed' : ''}`}
      data-persona={personaSlug}
      data-round={round}
      onClick={() => onSelect(personaSlug, round)}
    >
      <div className="council-cell-top">
        {chip && <span className={`council-chip-pos council-chip-pos--${cat}`}>{chip}</span>}
        {(reactions > 0 || questions > 0) && (
          <span className="council-cell-meta">
            {reactions > 0 && <>↯ {reactions}</>}
            {reactions > 0 && questions > 0 && <span> · </span>}
            {questions > 0 && <>? {questions}</>}
          </span>
        )}
      </div>

      {!active && data.executiveSummary && (
        <p className="council-cell-exec">{data.executiveSummary}</p>
      )}

      {active && (
        <div className="council-cell-full">
          {data.executiveSummary && (
            <Sub title="Executive summary">
              <p>{data.executiveSummary}</p>
            </Sub>
          )}
          {data.position && (
            <Sub title="Position">
              <div dangerouslySetInnerHTML={{ __html: marked.parse(data.position) as string }} />
            </Sub>
          )}
          {data.reasoning && (
            <Sub title="Reasoning">
              <div dangerouslySetInnerHTML={{ __html: marked.parse(data.reasoning) as string }} />
            </Sub>
          )}
          {data.reactions && (
            <Sub title="Reactions to peers">
              <div dangerouslySetInnerHTML={{ __html: marked.parse(data.reactions) as string }} />
              {reactionTargets.length > 0 && (
                <div className="council-cell-react-chips">
                  {reactionTargets.map((s) => (
                    <span key={s} className="council-cell-react-chip">
                      <PersonaAvatar slug={s} size={14} />
                      <span>{s}</span>
                    </span>
                  ))}
                </div>
              )}
            </Sub>
          )}
          {data.openQuestions && (
            <Sub title="Open questions">
              <div dangerouslySetInnerHTML={{ __html: marked.parse(data.openQuestions) as string }} />
            </Sub>
          )}
        </div>
      )}
    </button>
  );
}

function Sub({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="council-cell-sub">
      <h5>{title}</h5>
      <div className="council-cell-sub-body">{children}</div>
    </section>
  );
}
