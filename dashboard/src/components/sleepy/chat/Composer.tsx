import { useEffect, useRef, useState } from 'react';
import { pickFiles, pickFolders } from '../../../lib/desktop';
import { useAgentSessionStats } from '../../../hooks/useAgentCapabilities';
import {
  effortLabel, fmtTokens, fmtCost, modelLabelFor, quotePath, CONTEXT_TIGHT_PCT,
  slashQueryAt, filterSlashCommands, applySlashCommand, type ModelConfig,
} from '../../../lib/agentComposer';
import { Popover, SkillBrowser } from '../SkillPickerPopover';
import { PermissionModeMenu } from './PermissionModeMenu';
import type { ChatSession } from '../chatSession';
import './composer.css';

/**
 * The redesigned Agent Chat (beta) composer (task T6, plan rev.3) — replaced the inline
 * `ChatComposer` and is mounted by the `ChatPane` orchestrator against the pinned
 * contract C8.
 *
 * ── Draft discipline (preserved EXACTLY from the current `ChatComposer`) ────────────
 * The textarea's text is LOCAL React state, not derived from `session.getModel().draft`
 * on every render — safe because the pane never unmounts while its session is alive (see
 * chatSession.ts's header). `syncDraft` mirrors every keystroke into the model so an
 * EXTERNAL `sendText` (file drop routed by AgentSurface, a page-level skill insert) can
 * append to an accurate draft; its `draftEpoch` bump is what tells this composer to ADOPT
 * that appended value instead of clobbering free typing. `setFocusTarget` registers the
 * textarea so `session.focus()` (click-to-focus on the transcript, etc.) has a target.
 *
 * ── What's new vs the old composer (state 7/8/11, plan rev.3) ──────────────────────
 * Attachments (file/folder picks, pasted images) and a picked skill are held as SEPARATE
 * local-state "chips" above the textarea rather than being merged into the draft text
 * character-by-character — they're folded into the outgoing message only at submit time.
 * This is a deliberate departure from the old composer's `insert()` (which spliced skill/
 * path text directly into the draft): the redesign brief asks for a distinct attachments
 * row + an accent skill chip, and since this pane never unmounts while its session lives,
 * plain local state survives minimize/restore exactly like the draft does.
 */

interface Attachment {
  id: string;
  kind: 'image' | 'file' | 'folder';
  name: string;
  /** Image attachments only — an object URL for a paste/drag `File` blob; revoked on
   *  removal and on unmount. There is no upload channel for raw image bytes over the
   *  text-only chat protocol, so an image attachment is a visual-only preview in this
   *  beta and is dropped (not embedded) from the outgoing message text. */
  url?: string;
  /** File/folder attachments only — a real path from the native picker (`pickFiles`/
   *  `pickFolders`), quoted into the outgoing message text on submit. */
  path?: string;
}

const MIN_COMPOSER_H = 88;
const DEFAULT_COMPOSER_H = 118;

function basenameOf(path: string): string {
  const clean = path.replace(/\/+$/, '');
  const i = clean.lastIndexOf('/');
  return i === -1 ? clean : clean.slice(i + 1);
}

function truncateQuote(text: string): string {
  return text.length > 140 ? `${text.slice(0, 140)}…` : text;
}

/** Drawn rather than typed as "+": a text plus inherits the label's font weight and optical
 *  size, so it sat heavier than the ✦ beside it. This one is stroked to match. */
function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
      <path d="M6 1.5v9M1.5 6h9" />
    </svg>
  );
}

export function Composer({
  session, model, effort, modelConfig, onModelChange, onEffortChange, busy, connected,
  quote, onClearQuote, onOpenTaskPicker, permissionMode, onPermissionModeChange,
}: {
  session: ChatSession;
  model: string;
  effort: string;
  modelConfig: ModelConfig;
  onModelChange: (id: string) => void;
  onEffortChange: (level: string) => void;
  busy: boolean;
  connected: boolean;
  /** The REMEMBERED permission-mode default — rendered as the toolbar's leading `bypass`
   *  checkbox-dropdown (owner reference 07-25 moved it here from the pane's top-right
   *  corner). Owned by `ChatPane`; this composer only renders it and reports a change. */
  permissionMode: 'auto' | 'bypass';
  onPermissionModeChange: (mode: 'auto' | 'bypass') => void;
  /** The quoted-reply text (state 11's ↩ Quote-reply), or `null` when nothing is queued.
   *  Owned by the orchestrator (`ChatPane`, wave 4) — this composer only renders/consumes it. */
  quote: string | null;
  /** Dismiss the queued quote WITHOUT sending (the chip's ✕). Also called by this
   *  composer itself right after a successful submit, since sending consumes the quote. */
  onClearQuote: () => void;
  /** Open the task picker (state 7's "📋 Task" attachment). The picker itself, and how a
   *  chosen task reaches this composer as an attachment chip, is a later wave's concern —
   *  no such channel exists yet, so this composer only ever fires the request to open one. */
  onOpenTaskPicker: () => void;
}) {
  const [draft, setDraft] = useState(() => session.getModel().draft);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // ── Preserved verbatim: focus-target registration ────────────────────────────────
  useEffect(() => {
    session.setFocusTarget(taRef.current);
    return () => session.setFocusTarget(null);
  }, [session]);

  // ── Preserved verbatim: draftEpoch adoption (rewind prefill / external sendText) ──
  const draftEpoch = session.getModel().draftEpoch;
  useEffect(() => {
    if (draftEpoch > 0) {
      setDraft(session.getModel().draft);
      taRef.current?.focus();
    }
  }, [session, draftEpoch]);

  // ── Attachments (state 7) — local-only chips, folded into the message at submit ──
  const attSeqRef = useRef(0);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  // Revoke every still-live object URL on unmount — the pane can unmount for real when
  // its session is disposed (tab closed), unlike the draft/focus mechanics above which
  // only need to survive minimize/restore.
  useEffect(() => () => {
    attachmentsRef.current.forEach((a) => { if (a.kind === 'image' && a.url) URL.revokeObjectURL(a.url); });
  }, []);

  const removeAttachment = (id: string) => {
    setAttachments((prev) => {
      const found = prev.find((a) => a.id === id);
      if (found?.kind === 'image' && found.url) URL.revokeObjectURL(found.url);
      return prev.filter((a) => a.id !== id);
    });
  };

  const pickPaths = async (kind: 'files' | 'folders', close: () => void) => {
    const paths = kind === 'folders' ? await pickFolders() : await pickFiles();
    close();
    if (!paths.length) return;
    const attKind: Attachment['kind'] = kind === 'folders' ? 'folder' : 'file';
    setAttachments((prev) => [
      ...prev,
      ...paths.map((p): Attachment => ({
        id: `att-${++attSeqRef.current}`,
        kind: attKind,
        path: p,
        name: basenameOf(p),
      })),
    ]);
  };

  // Clipboard-paste image capture (drag/drop of real files is handled at the surface
  // level — see composer.css's header note — so only paste needs a local handler here).
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    let addedImage = false;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
      const file = item.getAsFile();
      if (!file) continue;
      const url = URL.createObjectURL(file);
      setAttachments((prev) => [
        ...prev,
        { id: `att-${++attSeqRef.current}`, kind: 'image', url, name: file.name || 'Pasted image' },
      ]);
      addedImage = true;
    }
    if (addedImage) e.preventDefault(); // don't also paste raw image bytes as garbage text
  };

  // ── Skill chip (state 8) — reuses the terminal's SkillBrowser; picking one sets an
  //    accent chip instead of splicing text into the draft (see file header note). ────
  const [skillChip, setSkillChip] = useState<string | null>(null);

  // ── Slash-command autocomplete ───────────────────────────────────────────────────
  // Typing `/` opens the same menu the CLI's own TUI offers, from the SAME list: the
  // command names `system:init` reported for this session (built-ins + this project's
  // `.claude/commands/` + plugin/skill commands). The query is derived from the caret on
  // every keystroke rather than held in state, so it can never disagree with the textarea.
  const commands = session.getModel().slashCommands ?? [];
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const slashMatches = slashQuery === null ? [] : filterSlashCommands(commands, slashQuery);
  const slashOpen = slashQuery !== null && slashMatches.length > 0;
  const slashListRef = useRef<HTMLDivElement | null>(null);

  /** Re-derive the open/closed state from wherever the caret now is. */
  const syncSlash = (text: string, caret: number) => {
    const q = slashQueryAt(text, caret);
    setSlashQuery(q);
    setSlashIndex(0);
  };

  // Keep the active row in view when arrowing past the visible window.
  useEffect(() => {
    if (!slashOpen) return;
    slashListRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [slashOpen, slashIndex]);

  const acceptSlash = (command: string) => {
    const ta = taRef.current;
    const caret = ta?.selectionStart ?? draft.length;
    const next = applySlashCommand(draft, caret, command);
    setDraft(next.text);
    session.syncDraft(next.text);
    setSlashQuery(null);
    // Put the caret after the inserted "/command " so arguments can be typed straight away.
    requestAnimationFrame(() => {
      ta?.focus();
      ta?.setSelectionRange(next.caret, next.caret);
    });
  };

  // ── Resizable composer (state 7) — top drag handle, up to 50% of the pane's height ─
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [bodyHeight, setBodyHeight] = useState(DEFAULT_COMPOSER_H);
  const dragRef = useRef<{ startY: number; startH: number; max: number } | null>(null);

  const beginResize = (clientY: number, pointerId: number, target: Element) => {
    const paneEl = rootRef.current?.closest('.chat-pane') as HTMLElement | null;
    const paneH = paneEl?.getBoundingClientRect().height ?? window.innerHeight;
    const max = Math.max(MIN_COMPOSER_H, Math.round(paneH * 0.5));
    dragRef.current = { startY: clientY, startH: bodyHeight, max };
    try { (target as Element & { setPointerCapture?: (id: number) => void }).setPointerCapture?.(pointerId); } catch { /* not a pointer target */ }
  };
  const onHandlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    beginResize(e.clientY, e.pointerId, e.currentTarget);
  };
  const onHandlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const st = dragRef.current;
    if (!st) return;
    // Dragging UP (smaller clientY) grows the composer — the handle sits at its top.
    const delta = st.startY - e.clientY;
    setBodyHeight(Math.min(st.max, Math.max(MIN_COMPOSER_H, st.startH + delta)));
  };
  const onHandlePointerUp = () => { dragRef.current = null; };
  const onHandleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const paneEl = rootRef.current?.closest('.chat-pane') as HTMLElement | null;
    const paneH = paneEl?.getBoundingClientRect().height ?? window.innerHeight;
    const max = Math.max(MIN_COMPOSER_H, Math.round(paneH * 0.5));
    if (e.key === 'ArrowUp') { e.preventDefault(); setBodyHeight((h) => Math.min(max, h + 16)); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setBodyHeight((h) => Math.max(MIN_COMPOSER_H, h - 16)); }
  };

  // ── Context + cost readout (state 1/11) ──────────────────────────────────────────
  const conv = session.getModel();
  const lastResult = conv.lastResult;
  // The STREAM is the primary source: Claude Code ≥2.1.x flushes a live session's transcript
  // only on exit/rotation, so `/agent/session-stats` (which reads that transcript) reports
  // nulls for the whole life of a chat — which is why this readout used to stay blank
  // forever. The polled stats remain as the fallback for a RESUMED conversation, whose
  // earlier turns are already on disk but whose usage this process has not seen stream by.
  const stats = useAgentSessionStats(session.claudeId, connected).data;
  // `used > 0` on the fallback too: a transcript whose only turn was a synthetic notice
  // (e.g. "Please run /login") reports zero tokens, and "0% 0/200k" is noise, not a reading.
  const ctx = conv.context
    ?? (stats?.contextTokens ? { used: stats.contextTokens, limit: stats.contextLimit ?? 200_000, pct: Math.min(100, Math.round((stats.contextTokens / (stats.contextLimit ?? 200_000)) * 100)) }
      : null);
  // `total_cost_usd` off the result frame is already cumulative for the conversation.
  const costUsd = lastResult?.costUsd ?? stats?.costUsd ?? null;
  const isTight = !!ctx && ctx.pct >= CONTEXT_TIGHT_PCT;

  const runCompact = () => {
    if (!connected) return;
    session.send('/compact');
  };

  // ── Submit ────────────────────────────────────────────────────────────────────────
  const pathAttachments = attachments.filter((a) => a.kind !== 'image');
  const hasSendableContent = !!draft.trim() || pathAttachments.length > 0 || !!skillChip;

  const submit = () => {
    if (busy || !connected || !hasSendableContent) return;
    const pathsText = pathAttachments.map((a) => quotePath(a.path ?? '')).join(' ');
    const bodyText = pathsText ? (draft.trim() ? `${draft.trim()} ${pathsText}` : pathsText) : draft.trim();
    const withSkill = skillChip ? `${skillChip}${bodyText}` : bodyText;
    const message = quote ? `> ${quote}\n\n${withSkill}` : withSkill;
    if (!message.trim()) return;

    session.send(message);
    setDraft('');
    setSlashQuery(null);
    setAttachments((prev) => {
      prev.forEach((a) => { if (a.kind === 'image' && a.url) URL.revokeObjectURL(a.url); });
      return [];
    });
    setSkillChip(null);
    onClearQuote();
  };

  // ONLY disconnection disables the textarea — it must stay focusable while Claude
  // works (a disabled textarea drops focus to <body>, killing surface-level chords).
  const disabled = !connected;
  const modelLabel = modelLabelFor(modelConfig, model);
  const effortValue = effort || modelConfig.defaultEffort;

  return (
    <div className="chat-cmp" ref={rootRef}>
      {/* Anchored to `.chat-cmp`, NOT to the row it belongs to: the card clips its own
          overflow (safe for the toolbar's menus, which are portaled — this one is not), so
          a menu opening upward out of the textarea would be cut off at the card's edge. */}
      {slashOpen && (
        <div className="chat-cmp-slash" role="listbox" aria-label="Slash commands" ref={slashListRef}>
          {slashMatches.map((cmd, i) => (
            <button
              key={cmd}
              type="button"
              role="option"
              aria-selected={i === slashIndex}
              data-active={i === slashIndex}
              className="chat-cmp-slash-row"
              // Pointer-DOWN, not click: the textarea must not lose focus first, which
              // would close the menu before the click ever lands.
              onMouseDown={(e) => { e.preventDefault(); acceptSlash(cmd); }}
              onMouseEnter={() => setSlashIndex(i)}
            >
              <span className="chat-cmp-slash-name">/{cmd}</span>
            </button>
          ))}
        </div>
      )}

      <div className="chat-cmp-card">
      <div
        className="chat-cmp-handle"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize composer"
        tabIndex={0}
        onPointerDown={onHandlePointerDown}
        onPointerMove={onHandlePointerMove}
        onPointerUp={onHandlePointerUp}
        onPointerCancel={onHandlePointerUp}
        onKeyDown={onHandleKeyDown}
      >
        <span className="chat-cmp-handle-grip" aria-hidden />
      </div>

      <div className="chat-cmp-body" style={{ ['--chat-cmp-h' as string]: `${bodyHeight}px` }}>
        {quote && (
          <div className="chat-cmp-quote">
            <span className="chat-cmp-quote-bar" aria-hidden />
            <div className="chat-cmp-quote-body">
              <span className="chat-cmp-quote-label"><span aria-hidden>↩</span> Replying to Claude</span>
              <span className="chat-cmp-quote-text">{truncateQuote(quote)}</span>
            </div>
            <button type="button" className="chat-cmp-chip-x" aria-label="Cancel reply" onClick={onClearQuote}>✕</button>
          </div>
        )}

        {skillChip && (
          <div className="chat-cmp-skillchip">
            <span aria-hidden>✦</span>
            <span className="chat-cmp-skillchip-label">{skillChip.trim()}</span>
            <button type="button" className="chat-cmp-chip-x" aria-label="Remove skill" onClick={() => setSkillChip(null)}>✕</button>
          </div>
        )}

        {attachments.length > 0 && (
          <div className="chat-cmp-attachments">
            {attachments.map((a) => (
              <div key={a.id} className={`chat-cmp-attachment chat-cmp-attachment-${a.kind}`}>
                {a.kind === 'image' ? (
                  <img src={a.url} alt={a.name} className="chat-cmp-thumb" />
                ) : (
                  <span className="chat-cmp-attachment-glyph" aria-hidden>{a.kind === 'folder' ? '📁' : '📄'}</span>
                )}
                <span className="chat-cmp-attachment-name">{a.name}</span>
                <button type="button" className="chat-cmp-chip-x" aria-label={`Remove ${a.name}`} onClick={() => removeAttachment(a.id)}>✕</button>
              </div>
            ))}
          </div>
        )}

        <div className="chat-cmp-row">
          <textarea
            ref={taRef}
            className="chat-cmp-input"
            placeholder={!connected ? 'Connecting…' : busy ? 'Claude is working — draft your next message…' : 'Message Claude…'}
            value={draft}
            disabled={disabled}
            onChange={(e) => {
              setDraft(e.target.value);
              session.syncDraft(e.target.value);
              syncSlash(e.target.value, e.target.selectionStart ?? e.target.value.length);
            }}
            // Moving the caret with the mouse or arrows can carry it into (or out of) a
            // leading `/…`, so the menu is re-derived on selection changes too, not only on
            // typing. `selectionchange` on a textarea is React-unsupported; this is the
            // event that actually fires for both cases.
            onSelect={(e) => {
              const el = e.currentTarget;
              syncSlash(el.value, el.selectionStart ?? el.value.length);
            }}
            onBlur={() => setSlashQuery(null)}
            onPaste={onPaste}
            onKeyDown={(e) => {
              if (slashOpen) {
                if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIndex((i) => (i + 1) % slashMatches.length); return; }
                if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length); return; }
                if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                  // Enter COMPLETES while the menu is open — it must not also send the
                  // half-typed command underneath.
                  e.preventDefault();
                  acceptSlash(slashMatches[slashIndex]);
                  return;
                }
                if (e.key === 'Escape') {
                  // Dismiss the menu only; the surface's own Esc (collapse the overlay) must
                  // not fire in the same keystroke.
                  e.preventDefault();
                  e.stopPropagation();
                  setSlashQuery(null);
                  return;
                }
              }
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
            }}
          />
        </div>
      </div>

      <div className="chat-cmp-toolbar">
        {/* Leading control: is this conversation on a leash? Everything after it is about
            composing the message; this one is about what Claude may do with it. */}
        <PermissionModeMenu mode={permissionMode} onChange={onPermissionModeChange} />

        {/* One control for every kind of attachment — files, folders and (once a picker
            exists) a task. It is LABELLED like its Skills neighbour rather than left as a
            bare `+`: both open a menu, so both carry a glyph, a word and a caret; an
            unlabelled icon between two labelled ones just reads as a loose part. */}
        <Popover
          align="left"
          trigger={(open, toggle) => (
            <button type="button" className={`chat-cmp-btn-ghost${open ? ' open' : ''}`} onClick={toggle} title="Attach files, folders or a task" aria-haspopup="menu" aria-expanded={open}>
              <PlusIcon /> Attach <span className="chat-cmp-caret" aria-hidden>▾</span>
            </button>
          )}
        >
          {(close) => (
            <div className="chat-cmp-menu-list">
              <button type="button" role="menuitem" onClick={() => { void pickPaths('files', close); }}>Attach files…</button>
              <button type="button" role="menuitem" onClick={() => { void pickPaths('folders', close); }}>Attach folders…</button>
              <button type="button" role="menuitem" onClick={() => { onOpenTaskPicker(); close(); }}>Attach task…</button>
            </div>
          )}
        </Popover>

        <Popover
          align="left"
          trigger={(open, toggle) => (
            <button type="button" className={`chat-cmp-btn-ghost${open ? ' open' : ''}`} onClick={toggle} aria-haspopup="menu" aria-expanded={open}>
              <span className="chat-cmp-spark" aria-hidden>✦</span> Skills <span className="chat-cmp-caret" aria-hidden>▾</span>
            </button>
          )}
        >
          {(close) => (
            <SkillBrowser
              onInsert={(snippet) => { setSkillChip(snippet); taRef.current?.focus(); }}
              close={close}
            />
          )}
        </Popover>

        <div className="chat-cmp-spacer" />

        {/* Context + cost, in the toolbar's own dead space rather than on a line of its own:
            it belongs to the same strip as the model and effort it depends on, and it costs
            the transcript no height. `%` first — "how much room is left" is the question;
            the raw token counts are the supporting detail. One wrapper so a narrow pane
            never strands the cost chip alone on a second row. */}
        {(ctx || costUsd != null) && (
          <div className="chat-cmp-readout">
            {ctx && (
              <span
                className="chat-cmp-ctx"
                data-tight={isTight}
                title={`Context window: ${fmtTokens(ctx.used)} of ${fmtTokens(ctx.limit)} used (${ctx.pct}%) — ${fmtTokens(Math.max(0, ctx.limit - ctx.used))} free`}
              >
                <span className="chat-cmp-ctx-track" aria-hidden>
                  <span className="chat-cmp-ctx-fill" style={{ width: `${ctx.pct}%` }} />
                </span>
                <span className="chat-cmp-ctx-pct">{ctx.pct}%</span>
                <span className="chat-cmp-ctx-count">{fmtTokens(ctx.used)}/{fmtTokens(ctx.limit)}</span>
              </span>
            )}
            {costUsd != null && (
              <span
                className="chat-cmp-ctx-cost"
                title={`Estimated cost at public API rates: ${fmtCost(costUsd)} (a Max/Pro plan is flat-rate — this is a what-if)`}
              >{fmtCost(costUsd)}</span>
            )}
            {isTight && (
              <button type="button" className="chat-cmp-compact-btn" onClick={runCompact} title="Ask Claude to compact the conversation">
                <span aria-hidden>⚠</span> /compact
              </button>
            )}
          </div>
        )}

        <div className="chat-cmp-spacer" />

        {/* Model, effort and Send travel together: on a narrow pane the toolbar wraps, and
            this keeps the send action with its two modifiers instead of orphaning it. */}
        <div className="chat-cmp-toolbar-right">
        <Popover
          trigger={(open, toggle) => (
            <button type="button" className={`chat-cmp-pill${open ? ' open' : ''}`} disabled={!connected} onClick={toggle} title="Model — switches live (applies from the next turn)" aria-haspopup="menu" aria-expanded={open}>
              <span className="chat-cmp-pill-label">{modelLabel}</span>
            </button>
          )}
        >
          {(close) => (
            <div className="chat-cmp-menu-list">
              {modelConfig.models.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={m.id === model}
                  className={`chat-cmp-menu-row${m.id === model ? ' on' : ''}`}
                  onClick={() => { onModelChange(m.id); close(); }}
                >{m.label}</button>
              ))}
            </div>
          )}
        </Popover>

        <Popover
          trigger={(open, toggle) => (
            <button type="button" className={`chat-cmp-pill${open ? ' open' : ''}`} disabled={!connected} onClick={toggle} title="Effort — switches live (applies from the next turn)" aria-haspopup="menu" aria-expanded={open}>
              <span className="chat-cmp-pill-label">{effortLabel(effortValue)}</span>
            </button>
          )}
        >
          {(close) => (
            <div className="chat-cmp-menu-list">
              {modelConfig.efforts.map((lvl) => (
                <button
                  key={lvl}
                  type="button"
                  role="menuitemradio"
                  aria-checked={lvl === effortValue}
                  className={`chat-cmp-menu-row${lvl === effortValue ? ' on' : ''}`}
                  onClick={() => { onEffortChange(lvl); close(); }}
                >{effortLabel(lvl)}</button>
              ))}
            </div>
          )}
        </Popover>

        {/* A round icon button, sized to sit level with the model/effort text beside it —
            the label would only repeat what ⏎ already does. */}
        {busy ? (
          <button type="button" className="chat-cmp-btn chat-cmp-stop" title="Interrupt the in-flight turn" aria-label="Stop" onClick={() => session.interrupt()}>
            <span aria-hidden>■</span>
          </button>
        ) : (
          <button type="button" className="chat-cmp-btn chat-cmp-send" disabled={!connected || !hasSendableContent} onClick={submit} title="Send (⏎)" aria-label="Send">
            <span aria-hidden>↑</span>
          </button>
        )}
        </div>
      </div>
      </div>
    </div>
  );
}
