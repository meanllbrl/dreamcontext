import { useEffect, useRef, useState, type PointerEvent, type RefObject } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { fill } from '../../../lib/fill';
import type { ContainerKind } from '../../../lib/superTypes';
import { KIND_GLYPH } from './SuperContainer';
import type { Rect } from './superLayout';

export interface OthersItem {
  id: string;
  title: string;
  kind: ContainerKind;
  /** A chat's glow state, so an asking child in the stack is still obvious at a glance. */
  status?: 'working' | 'asking' | 'idle';
}

/**
 * The "Others" stack in the bottom-right corner (plan-r8 F4, owner decisions O4-O6): every card
 * the owner (or the agent) put aside, and every card the stage could not fit. A small stack;
 * clicking it (or Enter) fans out a real list of buttons above it. Clicking a card there shows
 * it side by side; a card can be dragged out of the fan onto the stage or onto the centre.
 * Escape closes the fan and gives focus back to the stack.
 */
export function OthersStack({ items, rect, onOpen, onPressItem, stackRef }: {
  items: readonly OthersItem[];
  rect: Rect;
  onOpen: (id: string) => void;
  onPressItem: (e: PointerEvent<HTMLButtonElement>, id: string) => void;
  stackRef: RefObject<HTMLButtonElement | null>;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    // Focus the first card in the fan; Escape or a press outside closes it.
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLButtonElement>('button')?.focus());
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
      stackRef.current?.focus();
    };
    const onDown = (e: Event) => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('keydown', onKey, { capture: true });
    window.addEventListener('pointerdown', onDown, { capture: true });
    return () => {
      window.removeEventListener('keydown', onKey, { capture: true });
      window.removeEventListener('pointerdown', onDown, { capture: true });
    };
  }, [open, stackRef]);

  useEffect(() => { if (!items.length) setOpen(false); }, [items.length]);
  if (!items.length) return null;
  const asking = items.some((i) => i.status === 'asking');
  return (
    <div
      ref={rootRef}
      className="super-others"
      data-testid="super-others"
      data-open={open ? 'true' : undefined}
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
    >
      <button
        ref={stackRef}
        type="button"
        className="super-others-stack"
        data-testid="super-others-stack"
        data-asking={asking ? 'true' : undefined}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={fill(t('super.others.label'), { n: String(items.length) })}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="super-others-sheets" aria-hidden>
          <span /><span /><span />
        </span>
        <span className="super-others-name">{t('super.others.name')}</span>
        <span className="super-others-count">{items.length}</span>
      </button>
      {open && (
        <ul ref={listRef} className="super-others-fan" data-testid="super-others-fan" aria-label={t('super.others.name')}>
          {items.map((it) => (
            <li key={it.id}>
              <button
                type="button"
                className="super-others-item"
                data-testid="super-others-item"
                data-container-id={it.id}
                data-status={it.status}
                onPointerDown={(e) => onPressItem(e, it.id)}
                onClick={() => { setOpen(false); onOpen(it.id); }}
                title={t('super.card.sideBySide')}
              >
                <span className="super-others-glyph" aria-hidden>{KIND_GLYPH[it.kind]}</span>
                <span className="super-others-title">{it.title}</span>
                {it.status && it.status !== 'idle' && <span className="super-others-dot" data-status={it.status} aria-hidden />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
