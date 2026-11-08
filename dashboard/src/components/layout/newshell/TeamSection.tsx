import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { AgentAvatar } from '../../agents/AgentAvatar';
import { ekipApprovalCount, ekipAsking, ekipAskingCount, ekipUnreadCount, ekipWorkingCount, type EkipMember } from '../../aiteam/teamModel';
import { photoVaultOf } from './TeamList';
import { StatusMark, askRow, markWords, type MarkState } from './StatusMark';
import './TeamList.css';

/**
 * The Team row that opens IN PLACE (plan r4 D1-D5): a chevron, the label and ONE end mark (option A,
 * owner 2026-11-09: no faces, no ring); a click expands the member list right under it, no popover.
 * Folded means NO member row under it, whatever the members carry (owner 2026-11-08: "bu neden
 * kapanmıyor"): the row's own summed mark says a member has news (a question or an approval makes
 * the row the red asking row), and while a member's stage is open the folded row is the selected
 * one. On hover or focus a "⋯" offers Manage members and New member; no link under the list. Up to 8 members the list is plain; over 8 it is a box 8 rows tall that scrolls inside;
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

/** A member's mark: its approval and its question wait on the owner; its own work; its unread.
 *  "Super için" is no end mark: it sits on the face (`SuperBadge`), so the name keeps the row. */
export function memberMark(m: EkipMember): MarkState {
  return ekipMark([m]);
}

/** Members' summed mark, split by kind: approvals, and questions (the rest of what waits). */
function ekipMark(members: readonly EkipMember[]): MarkState {
  const asking = ekipAskingCount(members);
  const approvals = ekipApprovalCount(members);
  return { asking, approvals, questions: asking - approvals, working: ekipWorkingCount(members) > 0, unread: ekipUnreadCount(members) };
}

/** A member's ONE end mark, in the order of what the owner must do (D2, option A). */
export function MemberMark({ m }: { m: EkipMember }) {
  return <StatusMark {...memberMark(m)} />;
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

function MemberRow({ m, vault, onOpen, current = false }: { m: EkipMember; vault?: string | null; onOpen(m: EkipMember): void; current?: boolean }) {
  const { t } = useI18n();
  const mark = memberMark(m);
  const words = markWords(t, mark);
  return (
    <li className="ns-team-mrow-li">
      <button type="button" className={`ns-team-mrow${current ? ' is-sel' : ''}`} aria-current={current ? 'page' : undefined} data-testid="team-list-member" data-slug={m.slug}
        data-off={m.enabled ? undefined : 'true'} data-asking={m.enabled && m.asking && !m.superOnly ? 'true' : undefined} {...askRow(mark.asking)}
        title={words ? `${m.title} (${words})` : undefined} aria-label={words ? `${m.title} (${words})` : undefined}
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
  /** "Üyeleri yönet" (the row's "⋯"); an empty team's row opens it to make the first member. */
  onManage?(): void;
  /** "Yeni üye" (the row's "⋯"): the members flow on its create step. */
  onNewMember?(): void;
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
  const asking = ekipAsking(p.members);
  const mark = ekipMark(p.members);
  /** The summed mark is the folded row's only: open, each member row carries its own. */
  const folded = !open && !empty;
  const shownMark: MarkState = folded ? mark : { asking: 0, working: false, unread: 0 };
  const searchable = p.members.length > TEAM_SEARCH_OVER;
  const boxed = p.members.length > TEAM_BOX_ROWS;
  const shown = useMemo(() => (searchable ? filterMembers(p.members, query, locale ?? 'tr') : [...p.members]), [p.members, query, searchable, locale]);

  /** Folded with a member's stage on screen: the Team row itself is the selected one (where the owner is), never a member row under it. */
  const holdsOpen = !open && !empty && !!p.openSlug && p.members.some((m) => m.slug === p.openSlug);

  const named = markWords(t, shownMark);

  /** The "⋯" menu: Manage members, New member. */
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const hasMore = !empty && (!!p.onManage || !!p.onNewMember);
  const closeMenu = (refocus: boolean) => { setMenu(null); if (refocus) requestAnimationFrame(() => moreRef.current?.focus()); };
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!menu || !el) return;
    // Pulled back inside the window, then focus on its first item.
    const r = el.getBoundingClientRect();
    const x = Math.max(8, Math.min(menu.x, window.innerWidth - r.width - 8));
    const y = Math.max(8, Math.min(menu.y, window.innerHeight - r.height - 8));
    if (x !== menu.x || y !== menu.y) { setMenu({ x, y }); return; }
    if (!el.contains(document.activeElement)) el.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [menu]);
  useEffect(() => {
    if (!menu) return undefined;
    // A press on the "⋯" itself is its own toggle (its click closes the menu), not an outside press.
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Node && (menuRef.current?.contains(e.target) || moreRef.current?.contains(e.target))) return;
      closeMenu(false);
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [menu]);
  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' || e.key === 'Tab') { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); } closeMenu(e.key === 'Escape'); return; }
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'ArrowDown' ? (at + 1) % items.length : e.key === 'ArrowUp' ? (at - 1 + items.length) % items.length : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : -1;
    if (next < 0 || !items.length) return;
    e.preventDefault();
    items[next].focus();
  };

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
      <div className="ns-team-sec-head" data-more={hasMore ? 'true' : undefined} data-menu-open={menu ? 'true' : undefined}>
        <button ref={rowRef} type="button" className={`ns-team-row ns-team-sec-row ${p.className ?? ''}${holdsOpen ? ' is-sel' : ''}`.trim()}
          aria-current={holdsOpen ? 'page' : undefined}
          data-testid={p.testid} data-vault={p.vault ?? undefined} data-asking={folded && asking ? 'true' : undefined} data-empty={empty ? 'true' : undefined}
          {...askRow(shownMark.asking)}
          aria-expanded={empty ? undefined : open} aria-haspopup={empty ? 'dialog' : undefined}
          aria-label={empty ? `${p.label} (${t('drawer.team.addFirst')})` : named ? `${p.label} (${named})` : p.label}
          title={named ? `${p.label} (${named})` : undefined}
          onClick={() => (empty ? p.onManage?.() : toggle())}
          onKeyDown={(e) => { if (e.key === 'Escape' && open) { e.preventDefault(); toggle(false); } else if (e.key === 'ArrowDown' && open) onListKey(e); }}>
          <svg className={`ns-team-chev${open && !empty ? ' is-open' : ''}`} viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4" /></svg>
          <span className="ns-team-label">{p.label}</span>
          {empty
            ? <span className="ns-team-setup" data-testid="team-empty-slot" aria-hidden="true">{t('drawer.team.setup')}</span>
            : <span className="ns-team-end" data-testid="team-row-mark"><StatusMark {...shownMark} /></span>}
        </button>
        {hasMore && (
          <button ref={moreRef} type="button" className="ns-team-more" data-testid="team-more" aria-haspopup="menu" aria-expanded={!!menu}
            aria-label={`${t('drawer.team.more')}: ${p.label}`} title={t('drawer.team.more')}
            onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); if (menu) closeMenu(false); else setMenu({ x: r.right - 160, y: r.bottom + 4 }); }}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r="1.2" /><circle cx="8" cy="8" r="1.2" /><circle cx="12.5" cy="8" r="1.2" /></svg>
          </button>
        )}
      </div>
      {menu && (
        <div ref={menuRef} className="ns-team-menu" role="menu" aria-label={t('drawer.team.more')} data-testid="team-more-menu"
          style={{ left: menu.x, top: menu.y }} onKeyDown={onMenuKey}>
          {p.onManage && (
            <button type="button" role="menuitem" className="ns-team-menu-item" data-testid="team-manage" onClick={() => { closeMenu(false); p.onManage?.(); }}>
              {t('drawer.team.manage')}
            </button>
          )}
          {p.onNewMember && (
            <button type="button" role="menuitem" className="ns-team-menu-item" data-testid="team-new-member" onClick={() => { closeMenu(false); p.onNewMember?.(); }}>
              {t('drawer.team.newMember')}
            </button>
          )}
        </div>
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
        </div>
      )}
    </div>
  );
}
