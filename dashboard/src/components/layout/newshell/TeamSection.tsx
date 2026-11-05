import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { AgentAvatar } from '../../agents/AgentAvatar';
import { ProjectChipBubbles } from '../ProjectTabs';
import { ekipAsking, ekipCount, ekipPopOuts, ekipWorkingCount, type EkipMember } from '../../aiteam/teamModel';
import { TeamFaces, photoVaultOf } from './TeamList';
import './TeamList.css';

/**
 * The Team row that opens IN PLACE (plan r4 D1-D5): a chevron, the faces, the label and ONE end
 * mark; a click expands the member list right under it, no popover. Folded, members with news
 * for the owner (an approval card, a question, unread) pop out under it, at most 3, then "+N
 * daha". Up to 8 members the list is plain; over 8 it is a box 8 rows tall that scrolls inside;
 * over 12 a search field sits above it. Rows open the member's stage; no switch here (r3 R2: it
 * lives on the member's stage). The open state is remembered per project (and for Global).
 * The phone keeps its bottom sheet (`TeamList sheet`); this is the desktop's row.
 */

/** Rows before the list becomes its own scroll box. */
export const TEAM_BOX_ROWS = 8;
/** Members before a search field appears. */
export const TEAM_SEARCH_OVER = 12;

export const teamOpenKey = (kind: 'project' | 'global', vault: string | null | undefined): string =>
  kind === 'global' ? 'dc.drawer.team.global' : `dc.drawer.team.${vault ?? ''}`;

function readOpen(key: string): boolean {
  try { return window.localStorage.getItem(key) === '1'; } catch { return false; }
}
function writeOpen(key: string, open: boolean): void {
  try { if (open) window.localStorage.setItem(key, '1'); else window.localStorage.removeItem(key); } catch { /* a private window keeps it for the session only */ }
}

/** A name filter in the language's own case rules (Turkish İ/ı included). */
export function filterMembers<T extends Pick<EkipMember, 'title' | 'slug'>>(members: readonly T[], query: string, locale = 'tr'): T[] {
  const q = query.trim().toLocaleLowerCase(locale);
  if (!q) return [...members];
  return members.filter((m) => m.title.toLocaleLowerCase(locale).includes(q) || m.slug.toLowerCase().includes(q));
}

/** A member's ONE end mark, in the order of what the owner must do (D2). */
export function MemberMark({ m }: { m: EkipMember }) {
  const { t } = useI18n();
  if (m.approval) return <span className="ns-team-chip" data-kind="approval" data-testid="team-mark-approval">{t('drawer.team.approval')}</span>;
  if (!m.enabled) return null;
  if (!m.superOnly && m.ownerWorking > 0) {
    return <span data-testid="team-mark-working"><ProjectChipBubbles chip={{ live: m.ownerWorking, asking: 0, working: m.ownerWorking, idle: 0, flagged: 0 }} /></span>;
  }
  if (!m.superOnly && m.asking) return <span className="ns-team-chip" data-kind="question" data-testid="team-mark-question" aria-label={t('drawer.team.asks')}>?</span>;
  if (!m.superOnly && m.unread > 0) return <span className="ns-team-chip" data-kind="unread" data-testid="team-mark-unread">{m.unread}</span>;
  // "Super için" is no end mark: it sits on the face (`SuperBadge`), so the name keeps the row.
  return null;
}

/** Works for the Super only: a small glyph on the member's face corner, never a word at the row's
 *  end that takes the name's room (owner 2026-11-05: "Pacioli" read "P..."). Its own channel
 *  (shape on the face), apart from the end mark; the tooltip and label say "Super için". */
function SuperBadge({ m }: { m: EkipMember }) {
  const { t } = useI18n();
  if (!m.enabled || !m.superOnly || m.approval) return null;
  return (
    <span className="ns-team-super" data-testid="team-mark-super" role="img" aria-label={t('drawer.team.superOnly')} title={t('drawer.team.superOnly')}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5l1.6 4.9 4.9 1.6-4.9 1.6L8 14.5l-1.6-4.9L1.5 8l4.9-1.6z" /></svg>
    </span>
  );
}

function MemberRow({ m, vault, onOpen, popout = false, current = false }: { m: EkipMember; vault?: string | null; onOpen(m: EkipMember): void; popout?: boolean; current?: boolean }) {
  return (
    <li className="ns-team-mrow-li">
      <button type="button" className={`ns-team-mrow${popout ? ' is-pop' : ''}${current ? ' is-sel' : ''}`} aria-current={current ? 'page' : undefined} data-testid={popout ? 'team-popout' : 'team-list-member'} data-slug={m.slug}
        data-off={m.enabled ? undefined : 'true'} data-asking={m.enabled && m.asking && !m.superOnly ? 'true' : undefined}
        onClick={() => onOpen(m)}>
        <span className="ns-team-mface">
          <AgentAvatar of="agent" slug={m.slug} title={m.title} hasPhoto={m.hasPhoto} face={m.face ?? null} size={18} vault={photoVaultOf(m, vault)} />
          <SuperBadge m={m} />
        </span>
        <span className="ns-team-mname">{m.title}</span>
        <MemberMark m={m} />
      </button>
    </li>
  );
}

export interface TeamSectionProps {
  members: readonly EkipMember[];
  kind: 'project' | 'global';
  vault?: string | null;
  label: string;
  /** Slug of the member whose stage is on screen: its row is the selected one (the Team row itself never is). */
  openSlug?: string | null;
  className?: string;
  testid: string;
  onOpen(m: EkipMember): void;
  onManage?(): void;
}

export function TeamSection(p: TeamSectionProps) {
  const { t, locale } = useI18n();
  const key = teamOpenKey(p.kind, p.vault);
  const [open, setOpen] = useState(() => readOpen(key));
  const [query, setQuery] = useState('');
  const listRef = useRef<HTMLUListElement | null>(null);
  const rowRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { setOpen(readOpen(key)); }, [key]);

  const toggle = (next = !open) => { setOpen(next); writeOpen(key, next); if (!next) setQuery(''); };

  /** No member yet (owner 2026-11-03): the row opens the members flow to make the first. */
  const empty = p.members.length === 0 && !!p.onManage;
  const count = ekipCount(p.members);
  const asking = ekipAsking(p.members);
  const working = ekipWorkingCount(p.members);
  const pop = useMemo(() => ekipPopOuts(p.members), [p.members]);
  const searchable = p.members.length > TEAM_SEARCH_OVER;
  const boxed = p.members.length > TEAM_BOX_ROWS;
  const shown = useMemo(() => (searchable ? filterMembers(p.members, query, locale ?? 'tr') : [...p.members]), [p.members, query, searchable, locale]);

  /** Folded, the open member still shows under the row: it is how the owner sees where they are. */
  const foldedCurrent = p.openSlug ? p.members.find((m) => m.slug === p.openSlug) : undefined;

  const named = [
    asking ? t('drawer.team.asks') : '',
    working > 0 ? t('shell.drawer.superWorking').replace('{n}', String(working)) : '',
    count > 0 ? t('drawer.team.count').replace('{n}', String(count)) : '',
  ].filter(Boolean).join(', ');

  /** Arrows move within the list; Esc folds it and puts focus back on the row. */
  const onListKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); toggle(false); rowRef.current?.focus(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('button.ns-team-mrow') ?? [])];
    if (!items.length) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'ArrowDown' ? (at < 0 ? 0 : Math.min(items.length - 1, at + 1)) : (at <= 0 ? 0 : at - 1);
    items[next].focus();
    items[next].scrollIntoView?.({ block: 'nearest' });
  };

  return (
    <div className={`ns-team-sec${open ? ' is-open' : ''}`} data-testid={`${p.testid}-section`} data-open={open ? 'true' : 'false'}>
      <button ref={rowRef} type="button" className={`ns-team-row ns-team-sec-row ${p.className ?? ''}`.trim()}
        data-testid={p.testid} data-vault={p.vault ?? undefined} data-asking={asking ? 'true' : undefined} data-empty={empty ? 'true' : undefined}
        aria-expanded={empty ? undefined : open} aria-haspopup={empty ? 'dialog' : undefined}
        aria-label={empty ? `${p.label} (${t('drawer.team.addFirst')})` : named ? `${p.label} (${named})` : p.label}
        onClick={() => (empty ? p.onManage?.() : toggle())}
        onKeyDown={(e) => { if (e.key === 'Escape' && open) { e.preventDefault(); toggle(false); } else if (e.key === 'ArrowDown' && open) onListKey(e); }}>
        <svg className={`ns-team-chev${open && !empty ? ' is-open' : ''}`} viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4" /></svg>
        {empty ? <span className="ns-team-faces" aria-hidden="true"><span className="ns-team-face ns-team-face--empty" data-testid="team-empty-slot" /></span> : <TeamFaces members={p.members} vault={p.vault} />}
        <span className="ns-team-label">{p.label}</span>
        {working > 0
          ? <span data-testid="team-row-ring"><ProjectChipBubbles chip={{ live: working, asking: 0, working, idle: 0, flagged: 0 }} /></span>
          : count > 0 && <span className="ns-team-count" data-asking={asking ? 'true' : undefined} data-testid="team-row-count">{count}</span>}
      </button>

      {!open && (pop.shown.length > 0 || foldedCurrent) && (
        <ul className="ns-team-mlist" data-testid="team-popouts">
          {foldedCurrent && <MemberRow key={`cur-${foldedCurrent.slug}`} m={foldedCurrent} vault={p.vault} onOpen={p.onOpen} current />}
          {pop.shown.filter((m) => m.slug !== p.openSlug).map((m) => <MemberRow key={m.slug} m={m} vault={p.vault} onOpen={p.onOpen} popout />)}
          {pop.more > 0 && (
            <li className="ns-team-mrow-li">
              <button type="button" className="ns-team-more" data-testid="team-popout-more" onClick={() => toggle(true)}>
                {t('drawer.team.more').replace('{n}', String(pop.more))}
              </button>
            </li>
          )}
        </ul>
      )}

      {open && !empty && (
        <div className="ns-team-open-list" onKeyDown={onListKey}>
          {searchable && (
            <input type="search" className="ns-team-search" data-testid="team-search" value={query}
              placeholder={t('drawer.team.search').replace('{n}', String(p.members.length))}
              aria-label={t('drawer.team.search').replace('{n}', String(p.members.length))}
              onChange={(e) => setQuery(e.target.value)} />
          )}
          <ul ref={listRef} className={`ns-team-mlist${boxed ? ' is-box' : ''}`} data-testid={p.kind === 'global' ? 'global-team-list' : 'team-list'}
            data-boxed={boxed ? 'true' : undefined} style={boxed ? { maxHeight: `calc(${TEAM_BOX_ROWS} * var(--ns-team-mrow-h))` } : undefined}>
            {shown.map((m) => <MemberRow key={m.slug} m={m} vault={p.vault} onOpen={p.onOpen} current={m.slug === p.openSlug} />)}
            {shown.length === 0 && <li className="ns-team-empty">{t('drawer.team.noMatch')}</li>}
          </ul>
          {p.onManage && (
            <button type="button" className="ns-team-manage ns-team-sec-manage" data-testid="team-manage" onClick={() => p.onManage?.()}>
              {t('drawer.team.manage')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
