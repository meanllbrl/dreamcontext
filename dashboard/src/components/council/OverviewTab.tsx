import { useMemo } from 'react';
import { marked } from 'marked';
import type { DebateDetail } from '../../hooks/useCouncil';
import { useI18n } from '../../context/I18nContext';
import { StatTile } from './StatTile';
import { PersonaAvatar } from './PersonaAvatar';
import { computeDebateStats, parseFinalReport } from './lib/councilStats';

interface Props {
  debate: DebateDetail;
  onCiteJump: (slug: string, round: number) => void;
  onAgentJump: (slug: string) => void;
}

export function OverviewTab({ debate, onCiteJump, onAgentJump }: Props) {
  const { t } = useI18n();
  const stats = useMemo(() => computeDebateStats(debate), [debate]);
  const parsed = debate.finalReport ? parseFinalReport(debate.finalReport.content) : null;
  const knownSlugs = debate.personas.map((p) => p.slug);

  const toneFor = (heading: string): string => {
    const h = heading.toLowerCase();
    if (/\b(risk|danger|warning|caveat)/.test(h)) return 'council-ov-card--risks';
    if (/\b(minority|dissent|objection)/.test(h)) return 'council-ov-card--minority';
    if (/^why\b/.test(h)) return 'council-ov-card--why';
    return '';
  };

  return (
    <div className="council-ov">
      <section className="council-ov-problem">
        <div className="council-ov-label">Problem</div>
        <h2 className="council-ov-topic">{debate.frontmatter.topic || debate.frontmatter.id}</h2>
        {debate.frontmatter.promoted_to_knowledge && (
          <div className="council-ov-promoted">
            <span>📜</span>
            <span>
              Promoted to knowledge: <code>{debate.frontmatter.promoted_to_knowledge}</code>
            </span>
          </div>
        )}
      </section>

      {!parsed && (
        <section className="council-ov-pending">
          <div className="council-ov-label">{t('council.verdict.awaitingSynthesis')}</div>
          <p>{t('council.verdict.synthPending')}</p>
          {debate.roundLog && (
            <div className="council-roundlog">
              <h4>Round log</h4>
              <div
                className="council-sheet-prose"
                dangerouslySetInnerHTML={{ __html: marked.parse(debate.roundLog) as string }}
              />
            </div>
          )}
        </section>
      )}

      {parsed && (
        <>
          <section className="council-ov-verdict">
            <div className="council-ov-label">Verdict</div>
            <div
              className="council-ov-verdict-text"
              dangerouslySetInnerHTML={{
                __html: marked.parse(parsed.verdict || '*No verdict section found.*') as string,
              }}
            />
          </section>

          <div className="council-ov-stats">
            <StatTile value={stats.rounds} label="rounds" />
            <StatTile value={stats.personas} label="personas" />
            <StatTile value={stats.pushbacks} label="pushbacks" />
            <StatTile value={stats.openRisks} label="open risks" tone="warning" />
            <StatTile value={stats.minorityViews} label="dissent" tone="dissent" />
          </div>

          {parsed.sections.length > 0 && (
            <div className="council-ov-sections">
              {parsed.sections.map((s) => (
                <section key={s.heading} className={`council-ov-card ${toneFor(s.heading)}`}>
                  <h3>{s.heading}</h3>
                  <CitationProse
                    text={s.body}
                    knownSlugs={knownSlugs}
                    onCiteJump={onCiteJump}
                    onAgentJump={onAgentJump}
                  />
                </section>
              ))}
            </div>
          )}

          {parsed.appendix && (
            <details className="council-ov-appendix">
              <summary>{parsed.appendix.heading}</summary>
              <div
                className="council-sheet-prose"
                dangerouslySetInnerHTML={{ __html: marked.parse(parsed.appendix.body) as string }}
              />
            </details>
          )}
        </>
      )}
    </div>
  );
}

function CitationProse({
  text,
  knownSlugs,
  onCiteJump,
  onAgentJump,
}: {
  text: string;
  knownSlugs: string[];
  onCiteJump: (slug: string, round: number) => void;
  onAgentJump: (slug: string) => void;
}) {
  // Replace "slug in RN" → CITE token.
  const tokens: { slug: string; round: number }[] = [];
  // Replace plain mention of known slugs (bold or bare) with AGENT token.
  const slugSet = new Set(knownSlugs);

  let tokenized = text.replace(/([a-z][a-z0-9-]+)\s+in\s+R(\d+)/g, (match, slug: string, n: string) => {
    if (!slugSet.has(slug)) return match;
    const idx = tokens.length;
    tokens.push({ slug, round: Number(n) });
    return `\u0000CITE${idx}\u0000`;
  });

  // Bold slug references like **slug**
  const boldAgents: string[] = [];
  tokenized = tokenized.replace(/\*\*([a-z][a-z0-9-]+)\*\*/g, (match, slug: string) => {
    if (!slugSet.has(slug)) return match;
    const idx = boldAgents.length;
    boldAgents.push(slug);
    return `\u0000AGENT${idx}\u0000`;
  });

  const html = marked.parse(tokenized) as string;
  const parts = html.split(/\u0000(CITE|AGENT)(\d+)\u0000/);

  const out: React.ReactNode[] = [];
  let i = 0;
  while (i < parts.length) {
    const seg = parts[i];
    if (i + 2 < parts.length && (parts[i + 1] === 'CITE' || parts[i + 1] === 'AGENT')) {
      out.push(<span key={`h-${i}`} dangerouslySetInnerHTML={{ __html: seg }} />);
      const kind = parts[i + 1];
      const idx = Number(parts[i + 2]);
      if (kind === 'CITE') {
        const tk = tokens[idx];
        out.push(
          <button
            key={`c-${i}`}
            type="button"
            className="council-cite-chip"
            onClick={() => onCiteJump(tk.slug, tk.round)}
          >
            <PersonaAvatar slug={tk.slug} size={14} />
            <span>{tk.slug}</span>
            <span className="council-cite-round">R{tk.round}</span>
          </button>,
        );
      } else {
        const slug = boldAgents[idx];
        out.push(
          <button
            key={`a-${i}`}
            type="button"
            className="council-inline-slug"
            onClick={() => onAgentJump(slug)}
          >
            {slug}
          </button>,
        );
      }
      i += 3;
    } else {
      out.push(<span key={`h-${i}`} dangerouslySetInnerHTML={{ __html: seg }} />);
      i += 1;
    }
  }

  return <div className="council-sheet-prose council-citation-prose">{out}</div>;
}
