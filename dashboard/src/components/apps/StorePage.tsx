import type { ReactNode } from 'react';
import { useI18n } from '../../context/I18nContext';
import { AppIcon } from './AppIcon';

/**
 * The store page's pieces (app-paylasim-magaza r2 section 1), shared by the install sheet and an
 * app's own page: the app itself first (icon, name, publisher, one line, one button), four facts
 * in a strip, then pictures, what it can do, what is new, and safety last.
 */

export interface CanLine { kind: 'action' | 'schedule' | 'settings' | 'agent'; text: string }
export interface StoreEntry { version: string; date: string | null; notes: string[] }

const CAN_MARK: Record<CanLine['kind'], string> = { action: '▶', schedule: '⏱', settings: '⚙', agent: '◎' };

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function ProductTop({ icon, name, slug, by, tagline, running, actions, note }: { icon: string | null; name: string; slug: string; by: ReactNode; tagline?: string | null; running?: boolean; actions?: ReactNode; note?: ReactNode }) {
  return (
    <div className="pp-top">
      <AppIcon src={icon} name={name} slug={slug} size={128} running={running} className="pp-top__icon" />
      <div className="pp-id">
        <h2 className="pp-name">{name}</h2>
        <span className="pp-pub">{by}</span>
        {tagline && <p className="pp-tag">{tagline}</p>}
        {actions && <div className="pp-act">{actions}</div>}
        {note}
      </div>
    </div>
  );
}

export function FactStrip({ facts }: { facts: Array<{ value: string; label: string }> }) {
  if (!facts.length) return null;
  return (
    <dl className="pp-facts" style={{ gridTemplateColumns: `repeat(${facts.length}, minmax(0, 1fr))` }}>
      {facts.map((f) => <div key={f.label}><dd>{f.value}</dd><dt>{f.label}</dt></div>)}
    </dl>
  );
}

export function PageSection({ title, sub, children, label }: { title: string; sub?: string; children: ReactNode; label?: string }) {
  return (
    <section className="pp-sec" aria-label={label ?? title}>
      <h3>{title}{sub && <small>{sub}</small>}</h3>
      {children}
    </section>
  );
}

export function Shots({ shots, sub }: { shots: Array<{ alt: string; src: string }>; sub?: string }) {
  const { t } = useI18n();
  if (!shots.length) return null;
  return (
    <PageSection title={t('store.shots')} sub={sub}>
      <div className="pp-shots">{shots.map((s, i) => <img key={i} src={s.src} alt={s.alt || t('store.shotAlt')} />)}</div>
    </PageSection>
  );
}

export function About({ text }: { text: string | null | undefined }) {
  const { t } = useI18n();
  if (!text) return null;
  return (
    <PageSection title={t('store.about')}>
      {text.split(/\n{2,}/).map((p, i) => <p key={i} className="pp-p">{p.replace(/\n/g, ' ')}</p>)}
    </PageSection>
  );
}

export function CanList({ lines, extra }: { lines: CanLine[]; extra?: ReactNode }) {
  const { t } = useI18n();
  if (!lines.length && !extra) return null;
  return (
    <PageSection title={t('store.can')}>
      <ul className="pp-can">
        {lines.map((l, i) => (
          <li key={i}><span className="pp-can__k" aria-hidden>{CAN_MARK[l.kind]}</span><span className="pp-can__v">{l.kind === 'settings' ? `${t('store.can.asks')} ${l.text}` : l.text}</span><span className="pp-can__m">{t(`store.can.${l.kind}`)}</span></li>
        ))}
      </ul>
      {extra}
    </PageSection>
  );
}

export function WhatsNew({ entry }: { entry: StoreEntry | null | undefined }) {
  const { t } = useI18n();
  if (!entry) return null;
  return (
    <PageSection title={t('store.new')}>
      <div className="pp-news"><span className="pp-news__ver">{t('store.version').replace('{v}', entry.version)}</span>{entry.date && <span className="pp-news__when">{shortDate(entry.date)}</span>}</div>
      {entry.notes.length === 1 ? <p className="pp-p">{entry.notes[0]}</p> : <ul className="pp-notes">{entry.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
    </PageSection>
  );
}
