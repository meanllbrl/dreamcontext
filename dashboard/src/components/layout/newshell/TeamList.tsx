import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { AgentAvatar } from '../../agents/AgentAvatar';
import { ekipFaces, ekipLine, ownerFacing, rosterTime, type EkipMember } from '../../aiteam/teamModel';
import './TeamList.css';

/**
 * The Ekip row and its list (plan-r10 1d, 1f; r8-05, r8-06, r8-12): ONE row per project (and one
 * Global ekip row at the very bottom), faces and ONE count, and the list it opens: a popover on
 * the desktop, a bottom sheet on a phone. The list is for SEEING, OPENING and TURNING ON/OFF only
 * (`wqt363`): a member's row opens its stage, its switch is `POST /api/agents/:slug/enabled`,
 * "Üyeleri yönet" (desktop only) opens the modal. Nothing here edits a member.
 */

/** A member's row in a list: a global one also names the project its newest owner-facing item
 *  is in ("Soru: ... · acme-storefront"). */
export type TeamListMember = EkipMember & { project?: string | null };

/** Up to three faces, the ones at work first. */
export function TeamFaces({ members, size = 16 }: { members: readonly EkipMember[]; size?: number }) {
  const faces = ekipFaces(members);
  return (
    <span className="ns-team-faces" aria-hidden="true">
      {faces.map((m) => (
        <span key={m.slug} className="ns-team-face" data-off={m.enabled ? undefined : 'true'}>
          <AgentAvatar of="agent" slug={m.slug} title={m.title} hasPhoto={m.hasPhoto} size={size} />
        </span>
      ))}
    </span>
  );
}

/** The row itself: faces, the label, one count in the question colour when one waits. */
export function TeamRowButton({ members, count, asking, label, selected = false, className = '', testid, vault, expanded, onClick }: {
  members: readonly EkipMember[];
  count: number;
  asking: boolean;
  label: string;
  selected?: boolean;
  className?: string;
  testid: string;
  vault?: string;
  expanded: boolean;
  onClick(e: MouseEvent<HTMLButtonElement>): void;
}) {
  const { t } = useI18n();
  const named = count > 0 ? `${label} (${t('drawer.team.count').replace('{n}', String(count))})` : label;
  return (
    <button type="button" className={`ns-team-row${selected ? ' is-sel' : ''} ${className}`.trim()} data-testid={testid}
      data-vault={vault} data-asking={asking ? 'true' : undefined} aria-haspopup="dialog" aria-expanded={expanded}
      aria-label={named} onClick={onClick}>
      <TeamFaces members={members} />
      <span className="ns-team-label">{label}</span>
      {count > 0 && <span className="ns-team-count" data-asking={asking ? 'true' : undefined}>{count}</span>}
    </button>
  );
}

export interface TeamListProps {
  /** "acme-storefront · Ekip", or "Global ekip · Tüm projeler". */
  title: string;
  members: readonly TeamListMember[];
  /** A phone: a bottom sheet, no "Üyeleri yönet". */
  sheet: boolean;
  testid: 'team-list' | 'global-team-list';
  /** Where the popover opens (the row's corner). */
  anchor: { x: number; y: number } | null;
  onOpen(m: TeamListMember): void;
  /** The switch. Resolves when the server took it; a refusal puts the switch back. */
  onSwitch(m: TeamListMember, enabled: boolean): Promise<unknown>;
  onManage?(): void;
  onClose(): void;
}

export function TeamList(p: TeamListProps) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState(p.anchor);
  /** The switch moves at once; the server's answer settles it. */
  const [flipped, setFlipped] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  // Pulled back inside the window, like the drawer's menus.
  useLayoutEffect(() => {
    const el = ref.current;
    if (p.sheet || !el || !p.anchor) return;
    const r = el.getBoundingClientRect();
    const pad = 8;
    const x = Math.max(pad, Math.min(p.anchor.x, window.innerWidth - r.width - pad));
    const y = Math.max(pad, Math.min(p.anchor.y, window.innerHeight - r.height - pad));
    setPos({ x, y });
  }, [p.anchor, p.sheet]);

  // Esc and a press outside close it; focus goes to its first row, and back to the row that
  // opened it on close. Its Esc closes only itself: one another layer already took is left alone,
  // and the one it takes reaches nobody else.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.querySelector<HTMLElement>('button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      p.onClose();
    };
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Node && ref.current?.contains(e.target)) return;
      p.onClose();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onDown, true);
      // Back to the row, unless the list's own action moved focus on (a member's stage, the modal).
      const now = document.activeElement;
      if (opener?.isConnected && (!now || now === document.body || !now.isConnected)) opener.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flip = (m: TeamListMember, enabled: boolean) => {
    setFlipped((f) => ({ ...f, [m.slug]: enabled }));
    setBusy((b) => ({ ...b, [m.slug]: true }));
    void p.onSwitch(m, enabled).then(
      () => setBusy((b) => ({ ...b, [m.slug]: false })),
      () => {
        setBusy((b) => ({ ...b, [m.slug]: false }));
        setFlipped((f) => { const { [m.slug]: _gone, ...rest } = f; return rest; });
      },
    );
  };

  const lineOf = (m: TeamListMember): string => {
    const l = ekipLine(m);
    let text: string;
    if (l.key === 'drawer.team.question') text = t('drawer.team.question').replace('{text}', () => l.text);
    else if (l.key === 'drawer.member.working') {
      const line = t('drawer.member.working').replace('{n}', String(l.n));
      // Nothing of the owner's waits (q 0): the "{q} sırada" half is dropped, never "0 sırada".
      text = l.q > 0 ? line.replace('{q}', String(l.q)) : line.replace(/,?\s*\{q\}[^,]*$/, '');
    }
    else if (l.key === 'drawer.member.idle') {
      const when = l.when > 0 ? rosterTime(new Date(l.when).toISOString(), new Date(), t) : '';
      text = when ? t('drawer.member.idle').replace('{when}', () => when) : t('drawer.member.idle').replace(/\s*·\s*\{when\}/, '').replace('{when}', '');
    } else text = t(l.key);
    return m.project ? `${text} · ${m.project}` : text;
  };

  const style = p.sheet ? undefined : { left: pos?.x ?? 0, top: pos?.y ?? 0 };
  return (
    <>
      {p.sheet && <div className="ns-team-scrim" aria-hidden="true" />}
      <div ref={ref} className={`ns-team-list${p.sheet ? ' is-sheet' : ''}`} role="dialog" aria-label={p.title} style={style}
        data-testid={p.sheet ? 'phone-team-sheet' : p.testid} data-list={p.testid}>
        {p.sheet && <span className="ns-team-grip" aria-hidden="true" />}
        <div className="ns-team-head">{p.title}</div>
        <ul className="ns-team-rows" data-testid={p.sheet ? p.testid : undefined}>
          {p.members.map((m) => {
            const enabled = flipped[m.slug] ?? m.enabled;
            const facing = ownerFacing(m) && enabled;
            return (
              <li key={m.slug} className="ns-team-item" data-facing={facing ? 'true' : undefined} data-off={enabled ? undefined : 'true'}>
                <button type="button" className="ns-team-open" data-testid="team-list-member" data-slug={m.slug}
                  onClick={() => p.onOpen(m)}>
                  <AgentAvatar of="agent" slug={m.slug} title={m.title} hasPhoto={m.hasPhoto} size={24} />
                  <span className="ns-team-text">
                    <span className="ns-team-name">{m.title}</span>
                    <span className="ns-team-line">{lineOf(m)}</span>
                  </span>
                  {enabled && m.superOnly && !m.approval && <span className="ns-team-tag">{t('drawer.team.superOnly')}</span>}
                  {m.approval && <span className="ns-team-chip" data-kind="approval">{t('drawer.team.approval')}</span>}
                  {enabled && !m.superOnly && m.asking && <span className="ns-team-chip" data-kind="question" aria-hidden="true">?</span>}
                  {enabled && !m.superOnly && !m.asking && m.unread > 0 && <span className="ns-team-chip" data-kind="unread">{m.unread}</span>}
                </button>
                <button type="button" role="switch" aria-checked={enabled} className="ns-team-switch"
                  data-testid="team-member-switch" data-slug={m.slug} disabled={!!busy[m.slug]}
                  aria-label={`${t('drawer.team.toggle')}: ${m.title}`}
                  onClick={() => flip(m, !enabled)}>
                  <span className="ns-team-knob" aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
        {!p.sheet && p.onManage && (
          <button type="button" className="ns-team-manage" data-testid="team-manage" onClick={() => { p.onClose(); p.onManage?.(); }}>
            {t('drawer.team.manage')}
          </button>
        )}
      </div>
    </>
  );
}
