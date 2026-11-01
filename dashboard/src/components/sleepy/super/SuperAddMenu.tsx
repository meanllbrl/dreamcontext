import { useEffect, useRef, useState, type MutableRefObject, type RefObject } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { isDesktop, pickFile, pickerError, pickerOpen } from '../../../lib/desktop';
import { MAX_CONTAINERS, MAX_FLOAT } from '../../../lib/superTypes';
import type { WidgetPayload } from '../../../lib/whiteboardWidgets';
import { InsightPicker, PagePicker, TaskPicker, WebPicker, WhiteboardPicker } from '../../whiteboard/WidgetPickers';
import { clampMenu, knowledgeOpen, payloadToOpen, refusalKey } from './superAddMenuModel';
import type { SuperOpenBody } from './superApi';

type Stage = 'menu' | 'web' | 'file' | 'knowledge' | 'task' | 'insight' | 'whiteboard';
const ITEMS: readonly Exclude<Stage, 'menu'>[] = ['web', 'file', 'knowledge', 'task', 'insight', 'whiteboard'];
const FILE_FILTER = { source: 'file', kind: ['pdf', 'html'] } as const;
const KNOWLEDGE_FILTER = { source: 'knowledge' } as const;

/**
 * The owner opens a card on the stage himself: the whiteboard's add palette, for the cards the agent
 * can open, by the same rules (POST /api/super/open). It stays open until the card is opened or the
 * owner leaves it: a refusal is written here, never lost with the menu.
 *
 * The press that shows a picker's sheet takes the window's focus, and a request has an answer still
 * to write here, so neither closes the menu. A click on a web card's page reaches only the frame:
 * the window's blur, with the frame now focused, is what tells this menu about it. Any other blur
 * is the owner leaving for another app, to copy an address, and comes back to what he typed.
 */
export function SuperAddMenu({ at, stage: box, toggleRef, busy, onOpen, onClose }: {
  at: { x: number; y: number };
  /** The stage's size: the menu stays inside it as the window changes. */
  stage: { width: number; height: number };
  /** `+ Add`: its own click toggles the menu, so a press on it must not close it first. */
  toggleRef: RefObject<HTMLElement | null>;
  /** A request is out: shared with `+ Add`, whose own press must not close the menu either. */
  busy: MutableRefObject<boolean>;
  onOpen: (body: SuperOpenBody) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState<Stage>('menu');
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const live = useRef({ stage, onClose });
  live.current = { stage, onClose };

  const go = (next: Stage) => { setError(null); setStage(next); };

  const open = (body: SuperOpenBody | null) => {
    if (!body || busy.current) return;
    busy.current = true;
    setError(null);
    onOpen(body).then(
      () => { busy.current = false; live.current.onClose(); },
      (err: unknown) => {
        busy.current = false;
        setError(t(refusalKey((err as { code?: unknown } | null)?.code)).replace('{stage}', String(MAX_FLOAT)).replace('{record}', String(MAX_CONTAINERS)));
      },
    );
  };
  const openPick = (p: WidgetPayload) => open(payloadToOpen(p));

  const chooseFile = () => {
    if (pickerOpen()) return;
    setError(null);
    setPicking(true);
    void pickFile().then((path) => {
      setPicking(false);
      if (path) open({ path });
      else if (pickerError()) setError(t('super.add.file.pickerFailed'));
    });
  };

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('input, .wb-palette-item')?.focus();
  }, [stage]);

  useEffect(() => {
    const held = () => pickerOpen() || busy.current;
    // On `document`, after the two `window` listeners that yield to this menu by its presence
    // (AgentSurface's fold, the stage's presentation keys).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      if (held()) return;
      if (live.current.stage === 'menu') live.current.onClose(); else { setError(null); setStage('menu'); }
    };
    const onDown = (e: PointerEvent) => {
      const el = e.target as Node | null;
      if (ref.current?.contains(el) || (el && toggleRef.current?.contains(el)) || held()) return;
      live.current.onClose();
    };
    const onBlur = () => { if (!held() && document.activeElement?.tagName === 'IFRAME') live.current.onClose(); };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [toggleRef, busy]);

  const place = clampMenu(at, box);
  return (
    <div
      ref={ref}
      className="wb-palette super-add-menu"
      data-testid="super-add-menu"
      data-stage={stage}
      role={stage === 'menu' ? 'menu' : 'dialog'}
      aria-label={t('super.add.label')}
      style={{ left: place.left, top: place.top, width: place.width, maxHeight: place.maxHeight }}
    >
      {stage === 'menu' ? (
        <>
          <p className="wb-palette-heading">{t('super.add.label')}</p>
          {ITEMS.map((item) => (
            <button key={item} type="button" role="menuitem" className="wb-palette-item" data-testid={`super-add-${item}`} onClick={() => go(item)}>
              {t(`super.add.${item}`)}
            </button>
          ))}
        </>
      ) : (
        <>
          <button type="button" className="wb-palette-back" data-testid="super-add-back" onClick={() => go('menu')}>
            ‹ {t('super.add.back')}
          </button>
          {stage === 'web' && <WebPicker noFile submitLabel={t('super.add.open')} onPick={openPick} />}
          {stage === 'file' && (
            <>
              <PagePicker filter={FILE_FILTER} onPick={(p) => open({ path: p.ref })} />
              {isDesktop() && (
                <div className="wb-picker-actions">
                  <button type="button" className="wb-palette-btn" data-testid="super-add-pick" disabled={picking} onClick={chooseFile}>
                    {t('super.add.pick')}
                  </button>
                </div>
              )}
            </>
          )}
          {stage === 'knowledge' && <PagePicker filter={KNOWLEDGE_FILTER} onPick={(p) => open(knowledgeOpen(p.ref))} />}
          {stage === 'task' && <TaskPicker onPick={openPick} />}
          {stage === 'insight' && <InsightPicker onPick={openPick} />}
          {stage === 'whiteboard' && <WhiteboardPicker onPick={(slug) => open({ kind: 'whiteboard', ref: slug })} />}
        </>
      )}
      {error && <p className="wb-picker-error" role="alert" data-testid="super-add-error">{error}</p>}
    </div>
  );
}
