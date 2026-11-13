import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useAgentModelConfig, useAgentTools } from '../../../hooks/useAgentCapabilities';
import { FALLBACK_MODEL_CONFIG, effortLabel } from '../../../lib/agentComposer';
import { ModelPicker, ToolMark, type PickerTarget, type SettingsTarget } from '../../sleepy/chat/model-picker/ModelPicker';
import { claudeState, codexState, type PickerTool, type PickerToolState } from '../../sleepy/chat/model-picker/pickerModel';
import './ModelChip.css';

export interface ChipValue {
  tool: PickerTool;
  /** '' = the job has no choice of its own (the chip shows `fallback`, dimmed). */
  model: string;
  effort: string;
}

/** The composer picker's tools, read the same way the chat reads them (ChatPaneHost).
 *  `withAntigravity`: a job Antigravity can run (the whiteboard's quick edit) lists it too. */
export function usePickerTools(_model?: string, withAntigravity = false): PickerToolState[] {
  const modelConfig = useAgentModelConfig().data ?? FALLBACK_MODEL_CONFIG;
  const tools = useAgentTools().data;
  const codexInfo = tools?.find((t) => t.tool === 'codex');
  const antigravityInfo = withAntigravity ? tools?.find((t) => t.tool === 'antigravity') : undefined;
  return useMemo(
    () => [claudeState(modelConfig), ...(codexInfo ? [codexState(codexInfo)] : []), ...(antigravityInfo ? [codexState(antigravityInfo)] : [])],
    [modelConfig, codexInfo, antigravityInfo],
  );
}

function modelLabel(tools: PickerToolState[], tool: PickerTool, id: string): string {
  const t = tools.find((x) => x.tool === tool);
  const hit = t && [...t.current, ...t.legacy].find((m) => m.id === id);
  return hit?.label ?? (id ? id.charAt(0).toUpperCase() + id.slice(1) : '');
}

/**
 * One job's model and effort (Settings window, Models and every page that runs a model): the
 * composer's own picker behind a chip, in settings mode. A pick writes the job's saved default
 * only; an open chat keeps its model. Esc closes the picker, never the window.
 */
export function ModelChip({ value, fallback, inherited, target, onPick, onEffort, disabled, why, label, testId, onOpenTab, withAntigravity, className }: {
  value: ChipValue;
  /** What runs when `value.model` / `value.effort` is empty. */
  fallback?: { model: string; effort: string; text?: string };
  /** The value is followed from another line (a Sleep helper): drawn lighter. */
  inherited?: boolean;
  target?: PickerTarget;
  onPick: (tool: PickerTool, model: string) => void;
  onEffort: (effort: string) => void;
  /** Passive: the chip cannot open, and the row says why. */
  disabled?: boolean;
  why?: string;
  /** Accessible name: "Chat model and effort". */
  label: string;
  testId?: string;
  /** A locked tool's "Sign in" goes to that tool's tab. */
  onOpenTab?: (target: SettingsTarget) => void;
  /** List Antigravity's models too (a job it can run). */
  withAntigravity?: boolean;
  /** An extra class on the chip (a page's own size). */
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<CSSProperties>({ visibility: 'hidden' });
  const tools = usePickerTools(value.tool === 'claude' ? value.model : '', withAntigravity);

  const shownModel = value.model || fallback?.model || '';
  const shownEffort = value.effort || fallback?.effort || '';
  const dim = inherited || (!value.model && !value.effort);
  const name = fallback?.text && !value.model ? fallback.text : modelLabel(tools, value.tool, shownModel);

  // Anchored under the chip, right-aligned; above it when the window has no room below.
  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const r = chipRef.current?.getBoundingClientRect();
      const pop = popRef.current;
      if (!r || !pop) return;
      const h = pop.offsetHeight;
      const w = pop.offsetWidth;
      const below = window.innerHeight - r.bottom - 8;
      const top = below >= h || r.top < h + 8 ? Math.min(r.bottom + 6, Math.max(8, window.innerHeight - h - 8)) : r.top - h - 6;
      const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
      setPos({ top, left });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: PointerEvent) => {
      const el = e.target as Node;
      if (popRef.current?.contains(el) || chipRef.current?.contains(el)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      chipRef.current?.focus();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={chipRef}
        type="button"
        className={`sw-mdc${dim ? ' inh' : ''}${className ? ` ${className}` : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${label}: ${name}${shownEffort ? ` ${effortLabel(shownEffort)}` : ''}`}
        title={disabled ? why : undefined}
        disabled={disabled}
        data-testid={testId}
        onClick={() => { setPos({ visibility: 'hidden' }); setOpen((o) => !o); }}
      >
        <span className="sw-mdc-mark"><ToolMark tool={value.tool} /></span>
        <b>{name}</b>
        {shownEffort && <span className="dim">{effortLabel(shownEffort)}</span>}
        <svg className="sw-mdc-car" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 4 5 6.5 7.5 4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && createPortal(
        <div className="sw-popover" ref={popRef} style={pos} data-testid={testId ? `${testId}-picker` : undefined}>
          <ModelPicker
            tools={tools}
            currentTool={value.tool}
            model={shownModel}
            effort={shownEffort}
            onModelChange={(id) => onPick(value.tool, id)}
            onEffortChange={(lvl) => onEffort(lvl)}
            onCrossTool={(m) => onPick(m.tool, m.id)}
            accounts={[]}
            activeAccountId=""
            onOpenSettings={(t) => { onOpenTab?.(t); }}
            close={() => setOpen(false)}
            target={target ?? {}}
          />
        </div>,
        document.body,
      )}
    </>
  );
}
