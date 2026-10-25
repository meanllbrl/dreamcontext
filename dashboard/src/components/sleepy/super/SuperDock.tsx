import { useEffect, useRef, type ReactNode, type Ref, type RefObject } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { BrandMark } from '../../brand/BrandMark';
import { StagePill } from './OthersStack';
import type { SuperDockPill } from './superHandover';
import './SuperSurface.css';
import './superTone.css';
import './SuperDock.css';

/**
 * The Super dock (owner 2026-10-25): with Super Agent mode on, every screen but the Chat screen
 * holds ONE pill bottom-right in place of the session stack, and the pill opens THE Super chat as
 * a full-height column on the right without leaving the page. Presentational: every piece is an
 * existing one (the stage's Others pill as `StagePill`, the centre's head, the stage's question
 * band, the dock's session tile), and the chat itself is the Super session's own container, homed
 * into `[data-super-slot="dock"]` by AgentSurface's placement like the stage centre's.
 */
export function SuperDock({ pill, open, lift, head, band, rows, connecting, slotRef, pillRef, onOpen, onMinimize }: {
  pill: SuperDockPill;
  open: boolean;
  /** The page lifts the corner above its own bottom control (a board's zoom bar, AI Team's composer). */
  lift: 'board' | 'team' | null;
  /** The window's head (SuperCentreHead with its two buttons). */
  head: ReactNode;
  /** The question band (the stage's JobBar, as a row). */
  band: ReactNode;
  /** Sessions that ask but are not the Super's (DockChip rows). */
  rows: ReactNode;
  /** No live Super session yet: the head and one line until its container lands. */
  connecting: boolean;
  slotRef: Ref<HTMLDivElement>;
  pillRef: RefObject<HTMLButtonElement | null>;
  onOpen: () => void;
  onMinimize: () => void;
}) {
  const { t } = useI18n();
  const windowRef = useRef<HTMLElement | null>(null);
  const name = t('super.centre.name');

  // Escape minimizes, only when the keyboard is inside the window and not inside a question
  // card, a menu or a popover (those own their Escape).
  const minimizeRef = useRef(onMinimize);
  minimizeRef.current = onMinimize;
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const ae = document.activeElement as HTMLElement | null;
      if (!ae || !windowRef.current?.contains(ae)) return;
      if (ae.closest('[data-testid="super-question-card"], [role="menu"], [role="listbox"], .agent-composer-menu, .chat-cmp-menu, .chat-popover')) return;
      if (windowRef.current.querySelector('[role="menu"], [role="listbox"], .agent-composer-menu')) return;
      e.preventDefault();
      minimizeRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className="super-dock" data-testid="super-dock" data-open={open ? 'true' : undefined} data-lift={lift ?? undefined}>
      {open && (
        <section ref={windowRef} className="super-dock-window" data-testid="super-dock-window" role="dialog" aria-label={name}>
          <div className="super-centre-bg" aria-hidden />
          <div className="super-centre-clip">
            {head}
            {rows}
            {band}
            {connecting && <div className="super-dock-connecting" data-testid="super-dock-connecting">{t('super.dock.connecting')}</div>}
            <div ref={slotRef} className="super-slot" data-super-slot="dock" />
          </div>
        </section>
      )}
      {!open && (
        <StagePill
          buttonRef={pillRef}
          testId="super-dock-pill"
          lead={<span className="super-dock-logo" aria-hidden><BrandMark size={24} title="" /></span>}
          name={name}
          dots={pill.dots}
          count={pill.count}
          asking={pill.asking}
          news={pill.news}
          expanded={false}
          label={t('super.dock.label').replace('{name}', name).replace('{n}', String(pill.count))}
          onClick={onOpen}
          badge={pill.asking
            ? <span className="agent-dock-chip-q super-dock-q" data-testid="super-dock-q" aria-hidden>?</span>
            : pill.news ? <span className="agent-dock-anchor-badge super-dock-news" data-testid="super-dock-news" aria-hidden /> : null}
        />
      )}
    </div>
  );
}
