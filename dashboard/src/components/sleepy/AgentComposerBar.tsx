import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { pushOverlay, popOverlay, isTopOverlay } from '../../lib/overlayStack';
import {
  SKILL_GROUPS, effortLabel, fmtTokens, fmtCost,
  type ModelOption, type SessionStats, type SkillTrigger,
} from '../../lib/agentComposer';

/**
 * The strip pinned to the bottom of each pane, styled as the terminal's OWN status line
 * (see AgentTerminal.css — same canvas, same mono grid, `·`-separated hint-row segments).
 * It has NO text field of its own — the terminal's OWN input line is the text field. It only:
 *   • @ Files             — native multi-select picker; the chosen paths drop into the
 *                           focused terminal's input line.
 *   • ✦ Dreamcontext Skills — a two-pane popover of our signature capabilities: chips on the
 *                           left, a live "what it is / how it works" detail card on the right
 *                           that follows hover/focus. Picking one types its trigger into the
 *                           terminal's input line.
 *   • model ▾ / effort ▾  — the FOCUSED agent's live model + effort (from the Claude CLI);
 *                           changing either fires `/model` or `/effort` at that agent.
 *
 * Purely presentational + a self-contained popover; all injection/switching lives in
 * {@link AgentSurface}.
 */

// ── A tiny popover: a trigger button + a menu that closes on outside-click / Esc ──────
// The menu PORTALS to <body>: each pane clips its children (overflow:hidden) and its
// `container: agentpane` makes it the containing block even for position:fixed, so a menu
// rendered in-pane can never out-grow a narrow or right-edge pane. From <body> it is placed
// above the trigger and clamped to the viewport, so it always fits — in any pane, any split.
function Popover({
  trigger, align = 'right', children,
}: {
  trigger: (open: boolean, toggle: () => void) => React.ReactNode;
  /** Which trigger edge the menu prefers to grow from (it clamps to the viewport either way). */
  align?: 'left' | 'right';
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Stable per-instance id on the app's overlay stack (⌘K palette, ⌘P switcher, …):
  // the portaled menu is a global overlay, so its Esc must arbitrate LIFO like the rest —
  // never swallow an Esc meant for a surface stacked on top, never lose one to a
  // background panel's earlier-registered listener.
  const overlayId = useId();

  useEffect(() => {
    if (!open) return;
    pushOverlay(overlayId);
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!anchorRef.current?.contains(t) && !menuRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !isTopOverlay(overlayId)) return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      popOverlay(overlayId);
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, overlayId]);

  // Place the menu above the trigger, clamped inside the viewport. Anchoring via `bottom`
  // keeps the trigger edge fixed; menus are fixed-height while open (see
  // .agent-skill-browser) so content changes never move what's under the cursor.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const a = anchorRef.current?.getBoundingClientRect();
      const m = menuRef.current;
      if (!a || !m) return;
      const PAD = 8;
      const w = m.offsetWidth;
      let left = align === 'left' ? a.left : a.right - w;
      left = Math.max(PAD, Math.min(left, window.innerWidth - w - PAD));
      const bottom = window.innerHeight - a.top + 6;
      m.style.left = `${Math.round(left)}px`;
      m.style.bottom = `${Math.round(bottom)}px`;
      m.style.maxHeight = `${Math.max(120, window.innerHeight - bottom - PAD)}px`;
      m.style.visibility = 'visible';
    };
    place();
    // The trigger can move without any window resize/scroll event: ⌘D pane splits, the
    // overlay's `left` transition on sidebar toggle, tab reflows — and xterm viewports
    // fire captured scrolls constantly while streaming, which made a scroll listener
    // both leaky (misses the above) and busy (re-placing on every output chunk). One
    // rAF watcher covers everything: a single getBoundingClientRect read per frame,
    // style writes only when the anchor actually moved.
    let last: DOMRect | undefined;
    let raf = requestAnimationFrame(function watch() {
      const a = anchorRef.current?.getBoundingClientRect();
      if (a && last && (a.left !== last.left || a.top !== last.top || a.width !== last.width)) place();
      last = a ?? last;
      raf = requestAnimationFrame(watch);
    });
    window.addEventListener('resize', place);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', place);
    };
  }, [open, align]);

  return (
    <div className="agent-composer-pop" ref={anchorRef}>
      {trigger(open, () => setOpen((v) => !v))}
      {open && createPortal(
        // Hidden until the layout effect measures + places it — no first-frame flash at 0,0.
        <div className="agent-composer-menu" role="menu" ref={menuRef} style={{ visibility: 'hidden' }}>
          {children(() => setOpen(false))}
        </div>,
        document.body,
      )}
    </div>
  );
}

// ── The Skills popover body: a two-pane "skill browser" ──────────────────────────────
// Left: our capability chips, grouped. Right: a live detail card that spells out WHAT the
// hovered/focused skill is and HOW it works (its phase flow + the sub-agents it dispatches).
// Clicking a chip drops its trigger into the terminal and closes the popover.
function SkillBrowser({ onInsert, close }: { onInsert: (snippet: string) => void; close: () => void }) {
  // Default the detail card to the very first skill so the panel is never empty.
  const [active, setActive] = useState<SkillTrigger>(SKILL_GROUPS[0].triggers[0]);
  // The detail card scrolls internally (its height is FIXED so hover never resizes the
  // popover — see .agent-skill-browser); start each skill's card from the top.
  const detailRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { detailRef.current?.scrollTo(0, 0); }, [active]);

  return (
    <div className="agent-skill-browser">
      <div className="agent-skill-list">
        {SKILL_GROUPS.map((group) => (
          <div className="agent-skill-group" key={group.id}>
            <span className="agent-skill-group-label">{group.label}</span>
            <div className="agent-skill-chips">
              {group.triggers.map((t) => (
                <button
                  key={t.insert}
                  type="button"
                  className={`agent-skill-chip${t.insert === active.insert ? ' on' : ''}`}
                  title={t.hint}
                  onMouseEnter={() => setActive(t)}
                  onFocus={() => setActive(t)}
                  onClick={() => { onInsert(t.insert); close(); }}
                >{t.label}</button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Live detail — the "very clearly convey what it is and how it works" panel. */}
      <div className="agent-skill-detail" aria-live="polite" ref={detailRef}>
        <div className="agent-skill-detail-head">
          <span className="agent-skill-detail-title">{active.label}</span>
          <code className="agent-skill-detail-trigger">{active.insert.trim()}</code>
        </div>
        <p className="agent-skill-detail-what">{active.what}</p>

        <span className="agent-skill-detail-h">How it works</span>
        <ol className="agent-skill-detail-flow">
          {active.how.map((step, i) => (
            <li key={i}><span className="agent-skill-detail-step-n">{i + 1}</span>{step}</li>
          ))}
        </ol>

        {active.agents && active.agents.length > 0 && (
          <>
            <span className="agent-skill-detail-h">Dispatches {active.agents.length} sub-agents</span>
            <div className="agent-skill-detail-agents">
              {active.agents.map((a) => (
                <span className="agent-skill-detail-agent" key={a}>{a}</span>
              ))}
            </div>
          </>
        )}

        <p className="agent-skill-detail-foot">Click to drop <code>{active.insert.trim()}</code> into the terminal — you finish the prompt.</p>
      </div>
    </div>
  );
}

export function AgentComposerBar({
  onInsert, onPickFiles, models, efforts, model, effort, onModelChange, onEffortChange, disabled, skillsDisabled = false, stats,
}: {
  /** Type a skill trigger into the focused terminal's input line. */
  onInsert: (snippet: string) => void;
  /** Open the native multi-file picker and drop the chosen paths into the terminal. */
  onPickFiles: () => void;
  /** Model options the CLI offers, and effort levels from `claude --help`. */
  models: ModelOption[];
  efforts: string[];
  /** The focused agent's current model alias + effort level. */
  model: string;
  effort: string;
  onModelChange: (id: string) => void;
  onEffortChange: (level: string) => void;
  /** No live agent focused → the model/effort pickers can't target anything. */
  disabled: boolean;
  /** This pane is a plain SHELL, not a Claude agent → our skill triggers (slash commands)
   *  don't apply, so the Skills picker is disabled (Files still works for a shell). */
  skillsDisabled?: boolean;
  /** This agent's live context-window footprint + API-rate cost estimate (null until the
   *  first turn writes usage, or omitted entirely for a shell). */
  stats?: SessionStats | null;
}) {
  const modelLabel = models.find((m) => m.id === model)?.label ?? (model || '—');
  const ctx = stats?.contextTokens != null && stats.contextLimit
    ? { used: stats.contextTokens, limit: stats.contextLimit, pct: Math.min(100, Math.round((stats.contextTokens / stats.contextLimit) * 100)) }
    : null;
  const showStats = !!ctx || (stats?.costUsd != null && stats.costUsd > 0);

  return (
    <div className="agent-composer">
      {/* Files */}
      <button
        type="button"
        className="agent-composer-btn"
        title="Attach files (multi-select) — drops into the terminal input"
        aria-label="Attach files"
        onClick={onPickFiles}
      >
        <span className="agent-composer-glyph" aria-hidden>@</span>
        <span className="agent-composer-btn-label">Files</span>
      </button>

      <span className="agent-composer-sep" aria-hidden>·</span>

      {/* Dreamcontext Skills */}
      <Popover
        align="left"
        trigger={(open, toggle) => (
          <button
            type="button"
            className={`agent-composer-btn${open ? ' open' : ''}`}
            title={skillsDisabled ? 'Skills apply to Claude agents, not a plain terminal' : 'Insert one of our skills into the terminal input'}
            aria-haspopup="menu"
            aria-expanded={open}
            disabled={skillsDisabled}
            onClick={toggle}
          >
            <span className="agent-composer-glyph" aria-hidden>✦</span>
            <span className="agent-composer-btn-label">Dreamcontext Skills</span>
            <span className="agent-composer-caret" aria-hidden>▾</span>
          </button>
        )}
      >
        {(close) => <SkillBrowser onInsert={onInsert} close={close} />}
      </Popover>

      {/* Spacer pushes the live readout + model/effort pickers to the right edge */}
      <div className="agent-composer-spacer" />

      {/* Live context-window footprint + API-rate cost estimate (this agent's own). */}
      {showStats && (
        <div
          className="agent-composer-stats"
          title={
            `${ctx ? `Context window: ${fmtTokens(ctx.used)} of ${fmtTokens(ctx.limit)} used (${ctx.pct}%)\n` : ''}` +
            `${stats?.costUsd != null ? `Estimated cost at public API rates: ${fmtCost(stats.costUsd)} (a Max/Pro plan is flat-rate — this is a what-if)` : ''}`
          }
        >
          {ctx && (
            <span className="agent-composer-stat" data-hot={ctx.pct >= 85}>
              <span className="agent-composer-stat-glyph" aria-hidden>◔</span>
              <span className="agent-composer-stat-val">{fmtTokens(ctx.used)}<span className="agent-composer-stat-dim">/{fmtTokens(ctx.limit)}</span></span>
            </span>
          )}
          {stats?.costUsd != null && (
            <span className="agent-composer-stat">
              <span className="agent-composer-stat-val">{fmtCost(stats.costUsd)}</span>
            </span>
          )}
        </div>
      )}
      {/* The `·` after the readout is its DOM sibling so the ≤420px container query can
          hide both together (an orphan dot otherwise). */}
      {showStats && <span className="agent-composer-sep" aria-hidden>·</span>}

      {/* Model — the focused agent's live model */}
      <Popover
        trigger={(open, toggle) => (
          <button
            type="button"
            className={`agent-composer-select${open ? ' open' : ''}`}
            title={disabled ? 'Focus an agent to change its model' : 'Model of the focused agent'}
            aria-haspopup="menu"
            aria-expanded={open}
            disabled={disabled}
            onClick={toggle}
          >
            <span className="agent-composer-glyph" aria-hidden>⬡</span>
            <span className="agent-composer-select-label">{modelLabel}</span>
            <span className="agent-composer-caret" aria-hidden>▾</span>
          </button>
        )}
      >
        {(close) => (
          <div className="agent-model-list">
            {models.map((m) => (
              <button
                key={m.id}
                type="button"
                className={`agent-model-row${m.id === model ? ' on' : ''}`}
                role="menuitemradio"
                aria-checked={m.id === model}
                onClick={() => { onModelChange(m.id); close(); }}
              >
                <span className="agent-model-row-label">{m.label}</span>
              </button>
            ))}
          </div>
        )}
      </Popover>

      <span className="agent-composer-sep" aria-hidden>·</span>

      {/* Effort — the focused agent's live reasoning effort */}
      <Popover
        trigger={(open, toggle) => (
          <button
            type="button"
            className={`agent-composer-select${open ? ' open' : ''}`}
            title={disabled ? 'Focus an agent to change its effort' : 'Reasoning effort of the focused agent'}
            aria-haspopup="menu"
            aria-expanded={open}
            disabled={disabled}
            onClick={toggle}
          >
            <span className="agent-composer-glyph" aria-hidden>▚</span>
            <span className="agent-composer-select-label">{effort ? effortLabel(effort) : '—'}</span>
            <span className="agent-composer-caret" aria-hidden>▾</span>
          </button>
        )}
      >
        {(close) => (
          <div className="agent-model-list">
            {efforts.map((lvl) => (
              <button
                key={lvl}
                type="button"
                className={`agent-model-row${lvl === effort ? ' on' : ''}`}
                role="menuitemradio"
                aria-checked={lvl === effort}
                onClick={() => { onEffortChange(lvl); close(); }}
              >
                <span className="agent-model-row-label">{effortLabel(lvl)}</span>
              </button>
            ))}
          </div>
        )}
      </Popover>
    </div>
  );
}
