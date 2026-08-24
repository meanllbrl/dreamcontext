import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { pickFiles, pickFolders } from '../../../lib/desktop';
import { useVault } from '../../../context/VaultContext';
import { uploadAgentFile } from '../../../lib/agentDrop';
import { useAgentSessionStats, useUsageLimits } from '../../../hooks/useAgentCapabilities';
import {
  effortLabel, modelLabelFor, quotePath, isSignInCommand, contextLimitFor, usageLimits,
  fmtTokens, CONTEXT_TIGHT_PCT,
  slashQueryAt, filterSlashCommands, applySlashCommand, type ModelConfig,
} from '../../../lib/agentComposer';
import { chatModeRow, DEFAULT_CHAT_MODE, type ChatMode } from '../../../lib/chatModes';
import { patchAgentSettings } from '../../../lib/agentSettings';
import {
  composerBodyHeight, composerHeightBounds, measureBodyChrome, measureFieldContent, readFieldMetrics,
} from './composerHeight';
import {
  promptHistory, canRecallHistory, stepHistory, NO_HISTORY_NAV, type HistoryNav,
} from './chatEntities';
import {
  addAttachments, dropSentAttachments, nextAttachmentId, readScratch, removeAttachment,
  settleAttachment, subscribeScratch, type Attachment,
} from './composerScratch';
import { Popover } from '../SkillPickerPopover';
import { ModeMenu, ModelMenu, UsageMenu } from './ComposerMenus';
import { useAnchoredMenu, MENU_TRIGGER_ATTR } from './useAnchoredMenu';
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
 * That mirror is also what makes the draft survive a RESPAWN, which is the one thing the
 * "never unmounts" rule above does not cover: a mode switch (and a permission switch into
 * Bypass, which the CLI refuses to apply live) replaces the session object, so this pane
 * unmounts and a fresh one mounts against the new session. AgentSurface reads `conv.draft`
 * off the outgoing session and hands it to the incoming one (`carryDraftInto`), and the
 * `useState` initializer below picks it up on first paint. The chips and the quote survive
 * the same respawn by a DIFFERENT route — they are keyed by conversation id, which no respawn
 * changes, so there is nothing to carry (see composerScratch.ts).
 *
 * ── Attachments (state 7) ───────────────────────────────────────────────────────────
 * Attachments (file/folder picks, pasted images) are held as SEPARATE "chips" above the
 * textarea rather than being merged into the draft text character-by-character — they're
 * folded into the outgoing message only at submit time. This is a deliberate departure from
 * the old composer's `insert()` (which spliced path text directly into the draft): the brief
 * asks for a distinct attachments row.
 *
 * They live in `composerScratch`, keyed by CONVERSATION id, not in this component's state —
 * along with the reply quote, which `ChatPane` reads from the same place. That is what makes
 * them survive the respawn case below (and it is why nothing here revokes an object URL on
 * unmount any more: an unmount is not evidence that the user is done with a chip).
 *
 * ── The chrome (D1-C) ───────────────────────────────────────────────────────────────
 * The toolbar is five controls: mode+permission, attach, spacer, usage ring, model+effort,
 * send. The Skills popover and its accent chip are GONE — the `/` menu below already lists
 * every command this session reported, including every skill, so a second door onto the
 * same list cost a control and taught two paths to one place. The idle placeholder names
 * the surviving one.
 *
 * Three of the toolbar's menus (mode / model+effort / usage) are absolutely-positioned
 * children of `.chat-cmp` under `useAnchoredMenu`, not `Popover`s — they are full-card-width
 * panels that line up with the composer's edges. The Attach menu stays a `Popover`: it is a
 * short list that clamps to its trigger. See ComposerMenus.tsx and useAnchoredMenu.ts.
 *
 * ── Parity with the terminal's readline (07-26) ─────────────────────────────────────
 * Two things the terminal pane gets free from the CLI's own readline, which a headless chat
 * has to build, and whose absence made the DEFAULT surface worse than the fallback one:
 *   QUEUE   — ⏎ while `busy` no longer no-ops. It STEERS: the message goes to the turn already
 *             running and the CLI folds it in at its next tool boundary (07-29 — the first cut
 *             held it back until the turn settled, which on a long turn made ⏎ useless for the
 *             correction it exists for). "Not this turn, the next one" is still available, as
 *             its own ⇡ button, and lands as an editable row in the strip above
 *             (QueuedMessages.tsx). The queue lives on the session model, not here, so it
 *             survives minimize/restore and drains where the busy edge is observed.
 *   HISTORY — ↑/↓ walk this conversation's own past prompts (`promptHistory`, newest first,
 *             `history` + `items` so a RESUMED chat can re-run its earlier turns). The nav
 *             state is local because it is a cursor into a view, not conversation state; the
 *             rules that keep it from eating a half-typed draft are pure and tested in
 *             chatEntities.ts (`canRecallHistory`, `stepHistory`).
 */

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
  quote, onClearQuote, onOpenTaskPicker, permissionMode, projectPermissionMode,
  onPermissionModeChange, onSignIn,
  mode = DEFAULT_CHAT_MODE, onModeChange, onSetModelDefault, shelved = false,
}: {
  session: ChatSession;
  model: string;
  effort: string;
  modelConfig: ModelConfig;
  onModelChange: (id: string) => void;
  onEffortChange: (level: string) => void;
  busy: boolean;
  connected: boolean;
  /**
   * THIS SESSION's permission mode — what the running `claude` process is actually under, not
   * the project's remembered default for the NEXT one.
   *
   * The distinction is the whole reason this doc changed: a handoff-spawned session is forced
   * to `auto` even inside a project whose remembered default is `bypass`, so rendering the
   * remembered value would print "bypass" over a process running `--permission-mode auto`.
   * A security indicator that can disagree with the process is worse than no indicator.
   * `ChatPane` owns the resolution (the CLI's own `conv.permissionMode`, falling back to
   * `session.bypass`); this composer renders what it is handed, verbatim, and reports a
   * change.
   */
  permissionMode: 'auto' | 'bypass';
  /**
   * The PROJECT's remembered permission default — what `onPermissionModeChange` actually
   * writes, as opposed to what `permissionMode` above DISPLAYS.
   *
   * Forwarded straight to `ModeMenu`, which names both scopes in its note (see its prop doc).
   * This composer holds the two apart rather than merging them: they answer different
   * questions, and the whole reason the indicator is trustworthy is that it shows the session
   * rather than the default.
   */
  projectPermissionMode?: 'auto' | 'bypass';
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
  /** Take over a submitted `/login` (or `/logout`): this engine is headless and answers both
   *  with "isn't available in this environment", so sending them would spend a turn to be told
   *  nothing. The handler opens an interactive terminal Claude tab that CAN run the flow. */
  onSignIn: () => void;
  /**
   * How this conversation's agent is briefed to WORK (plain / plan / develop). OPTIONAL with a
   * default so this file compiles and renders the moment it lands: `ChatPane` wires the real
   * value a wave later, and until it does the trigger reads "Basic" — which is exactly what an
   * unwired session is running.
   */
  mode?: ChatMode;
  /** Inert by default for the same reason — see `mode`. */
  onModeChange?: (mode: ChatMode) => void;
  /**
   * OVERRIDE for "Set as default" — not the thing that makes the button work.
   *
   * The write is SELF-CONTAINED here: `saveModelDefault` below persists `chatDefaultModel` /
   * `chatDefaultEffort` to `~/.dreamcontext/agent-ui.json` via `patchAgentSettings`, because
   * this component already holds both values the write needs and the settings module is a
   * plain import — routing it through the pane would add a hop carrying no decision. So the
   * footer is ALWAYS rendered and the default is ALWAYS persisted; no caller supplies this
   * prop today and none needs to.
   *
   * Pass it only to do something ELSE with the gesture (write somewhere other than the
   * settings blob, confirm first). Doing so REPLACES the built-in write — it does not run
   * alongside it. NOTE: `ModelMenu` hides its footer when given no `onSetDefault`, but that
   * arm is unreachable from here — this composer always hands it `saveModelDefault`.
   */
  onSetModelDefault?: () => void;
  /** The pinned shelf has an open row docked to this card's top edge, so the card squares its
   *  top corners and the two read as one object. Off until the shelf exists. */
  shelved?: boolean;
}) {
  // Which project a pasted image is uploaded into. From THIS subtree, never a module global:
  // with several projects live in one window the bytes would otherwise land in the temp dir of
  // whichever chip the user last touched.
  const { vault } = useVault();
  // Re-read on every render (the pane re-renders on every applied event — see ChatPane): this
  // is the live conversation model, not a snapshot.
  const conv = session.getModel();
  const [draft, setDraft] = useState(() => conv.draft);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // ── Prompt history (↑/↓) ─────────────────────────────────────────────────────────
  // The terminal pane gets this from the CLI's own readline; a headless chat has to build it,
  // and the only honest source is what this conversation has already sent — including the
  // replayed `history` of a resumed one, since re-running an earlier turn is half the point of
  // resuming. Derived per render rather than held in state: it changes only when a message is
  // sent, and a snapshot would go stale exactly then.
  const historyEntries = promptHistory(conv.history, conv.items);
  const [nav, setNav] = useState<HistoryNav>(NO_HISTORY_NAV);
  // Mirrored in a ref because `syncSlash` runs in the SAME handler that ends a walk and has to
  // see the new value, not the pre-update render's.
  const navRef = useRef(nav);
  const setNavBoth = (next: HistoryNav) => { navRef.current = next; setNav(next); };
  /** Move the textarea (and the mirrored model draft) to a recalled prompt. */
  const applyRecalled = (text: string) => {
    setDraft(text);
    session.syncDraft(text);
    // Caret to the END of the recalled text: you recall a prompt to extend or re-send it, and
    // a caret parked at 0 would also mean the next ↑ is read as "recall again" (see
    // canRecallHistory) when the user meant to move within the line.
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.setSelectionRange(text.length, text.length);
      ta.scrollTop = ta.scrollHeight;
    });
  };
  const recall = (dir: 'back' | 'forward'): boolean => {
    const stepped = stepHistory(historyEntries, nav, dir, draft);
    if (!stepped) return false;
    setNavBoth(stepped.nav);
    applyRecalled(stepped.text);
    return true;
  };

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
      // The session replaced the draft wholesale (a rewind prefill, a dropped file's path), so
      // any history walk in progress is over — its stash describes a draft that no longer
      // exists, and ↓ restoring it would throw the new text away.
      setNavBoth(NO_HISTORY_NAV);
      taRef.current?.focus();
    }
  }, [session, draftEpoch]);

  // ── Attachments (state 7) — staged per CONVERSATION, folded into the message at submit ──
  // The chips live in `composerScratch`, keyed by the conversation id, NOT in this component:
  // a mode/permission respawn unmounts this pane, and chips staged against the conversation
  // must outlive the process the way the conversation itself does. That module owns their
  // object URLs too, so there is no revoke-on-unmount here any more — an unmount is no longer
  // evidence that the user is done with a chip. See composerScratch.ts's header.
  //
  // Local state mirrors the store so React re-renders; the SUBSCRIPTION is what makes an
  // upload that settles after a respawn reach the new pane. `submit` reads the store directly
  // rather than a ref, which is what retired the old "ref first, state second" hazard: there
  // is no second copy left to be a render behind.
  const convId = session.claudeId;
  const [attachments, setAttachments] = useState<Attachment[]>(() => readScratch(convId).attachments);
  useEffect(() => {
    setAttachments(readScratch(convId).attachments);
    return subscribeScratch(convId, (next) => setAttachments(next.attachments));
  }, [convId]);

  const pickPaths = async (kind: 'files' | 'folders', close: () => void) => {
    const paths = kind === 'folders' ? await pickFolders() : await pickFiles();
    close();
    if (!paths.length) return;
    const attKind: Attachment['kind'] = kind === 'folders' ? 'folder' : 'file';
    addAttachments(convId, paths.map((p): Attachment => ({
      id: nextAttachmentId(),
      kind: attKind,
      path: p,
      name: basenameOf(p),
    })));
  };

  // Clipboard-paste image capture (drag/drop of real files is handled at the surface
  // level — see composer.css's header note — so only paste needs a local handler here).
  //
  // A pasted image has BYTES and no path, and the chat protocol carries text only — so the
  // bytes go straight to the vault's gitignored temp dir and the chip holds the path that
  // comes back. This is the same channel a dropped file uses (`POST /api/agent/drop`); the
  // beta shipped without it, which is what made a pasted screenshot a picture the user could
  // see and the agent never received (owner report 07-27).
  /** Upload jobs still running. `submit` awaits these so ⌘V then ⏎ sends the picture. */
  const uploadsRef = useRef<Set<Promise<void>>>(new Set());

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    let addedImage = false;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
      const file = item.getAsFile();
      if (!file) continue;
      const id = nextAttachmentId();
      const name = file.name || 'Pasted image';
      const url = URL.createObjectURL(file);
      // Staged in the store, which is both what `submit` reads (so there is no flush-ordering
      // question — a settle that lands in the same microtask batch as a send is already
      // visible) and what survives a respawn. The upload's resolution is addressed by
      // CONVERSATION id, so a mode switch mid-upload still lands the path on the right chip
      // in the pane that replaced this one.
      addAttachments(convId, [{ id, kind: 'image', url, name, uploading: true }]);
      const job = uploadAgentFile(vault, file, name)
        .then((path) => { settleAttachment(convId, id, path); });
      uploadsRef.current.add(job);
      void job.finally(() => uploadsRef.current.delete(job));
      addedImage = true;
    }
    if (addedImage) e.preventDefault(); // don't also paste raw image bytes as garbage text
  };

  // ── Slash-command autocomplete ───────────────────────────────────────────────────
  // Typing `/` opens the same menu the CLI's own TUI offers, from the SAME list: the
  // command names `system:init` reported for this session (built-ins + this project's
  // `.claude/commands/` + plugin/skill commands). The query is derived from the caret on
  // every keystroke rather than held in state, so it can never disagree with the textarea.
  // It opens at ANY token boundary, not only the first character — naming a skill on the
  // third line of a prompt is as common as opening with a command.
  const commands = session.getModel().slashCommands ?? [];
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const slashMatches = slashQuery === null ? [] : filterSlashCommands(commands, slashQuery);
  const slashOpen = slashQuery !== null && slashMatches.length > 0;
  const slashListRef = useRef<HTMLDivElement | null>(null);

  /** Re-derive the open/closed state from wherever the caret now is. */
  const syncSlash = (text: string, caret: number) => {
    // A prompt RECALLED from history was not typed, so a leading `/…` in it must not spring the
    // command menu open — ⏎ would then COMPLETE the command instead of re-sending the prompt,
    // which is the one thing the recall was for. (`setSelectionRange` fires `onSelect`, so
    // suppressing it once at the recall site would not hold.) The first keystroke ends the walk
    // and the menu behaves normally from there.
    const q = navRef.current.index !== null ? null : slashQueryAt(text, caret);
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

  // ── Composer height: auto-grow, with the drag handle as a floor (state 7) ──────────
  //
  // Two lines at rest, one more per typed line, capped at ten lines OR half the pane —
  // whichever is smaller — and back to two the frame a message is sent. The rule that keeps
  // the top drag handle and auto-grow from fighting over the same number lives (with its
  // WHY) in composerHeight.ts: `applied = min(ceiling, max(autoGrown, draggedFloor))`.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const rowRef = useRef<HTMLDivElement | null>(null);
  /** What the user last dragged/keyed the composer to — a FLOOR, not the applied height. */
  const [draggedH, setDraggedH] = useState<number | null>(null);
  const [bodyHeight, setBodyHeight] = useState<number | null>(null);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  // Read by `resize` (a stable callback) and written by the drag, which must not re-run the
  // measurement once per pointermove through a dependency array.
  const draggedRef = useRef<number | null>(draggedH);
  draggedRef.current = draggedH;

  /** The pane whose half-height is the ceiling. `||`, not `??`: a pane parked in the
   *  surface's detached garage measures 0, which is not a ceiling — it is "unknown yet". */
  const paneHeight = () => {
    const paneEl = rootRef.current?.closest('.chat-pane') as HTMLElement | null;
    return (paneEl?.getBoundingClientRect().height || 0) || window.innerHeight;
  };

  /** Measure → clamp → apply. Runs in a LAYOUT effect so a sent message never paints the
   *  tall box it was typed in, and a re-measure never shows the intermediate size. */
  const resize = useCallback(() => {
    const ta = taRef.current, body = bodyRef.current, row = rowRef.current;
    if (!ta || !body || !row) return;
    const { lineHeight, fieldChrome } = readFieldMetrics(ta);
    setBodyHeight(composerBodyHeight({
      contentHeight: measureFieldContent(ta),
      lineHeight,
      fieldChrome,
      chromeHeight: measureBodyChrome(body, row),
      paneHeight: paneHeight(),
      draggedHeight: draggedRef.current,
    }));
  }, []);

  // Every input that can change how many lines the draft occupies, or how much of the box
  // the chips have taken: typing/paste (`draft`), an external `sendText` or a rewind prefill
  // (also `draft`, via the draftEpoch adoption above), submit (draft → ''), and the quote /
  // attachment rows appearing or disappearing.
  useLayoutEffect(() => { resize(); }, [resize, draft, draggedH, quote, attachments]);

  // Width changes rewrap the text (so the line COUNT moves without the draft changing) and
  // height changes move the ceiling — neither is a React render. Guarded on the observed box
  // actually changing, so the height we ourselves just applied can't feed a second pass back
  // through the observer.
  useEffect(() => {
    const el = (rootRef.current?.closest('.chat-pane') as HTMLElement | null) ?? rootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let last = { w: 0, h: 0 };
    const ro = new ResizeObserver(([entry]) => {
      const { width: w, height: h } = entry.contentRect;
      if (w === last.w && h === last.h) return;
      last = { w, h };
      resize();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [resize]);

  const beginResize = (clientY: number, pointerId: number, target: Element) => {
    // Starts from the APPLIED height, not from the stored floor: the handle should continue
    // from where auto-grow left the box, not jump back to the last dragged size.
    dragRef.current = { startY: clientY, startH: bodyHeight ?? 0 };
    try { (target as Element & { setPointerCapture?: (id: number) => void }).setPointerCapture?.(pointerId); } catch { /* not a pointer target */ }
  };
  const onHandlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    beginResize(e.clientY, e.pointerId, e.currentTarget);
  };
  const onHandlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const st = dragRef.current;
    if (!st) return;
    // Dragging UP (smaller clientY) grows the composer — the handle sits at its top. The
    // real min/ceiling clamp is `composerBodyHeight`'s job; this only has to stay sane.
    setDraggedH(Math.max(0, st.startH + (st.startY - e.clientY)));
  };
  const onHandlePointerUp = () => { dragRef.current = null; };
  const onHandleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const ta = taRef.current, body = bodyRef.current, row = rowRef.current;
    if (!ta || !body || !row) return;
    const { lineHeight, fieldChrome } = readFieldMetrics(ta);
    const { min, ceiling } = composerHeightBounds({
      lineHeight, fieldChrome, chromeHeight: measureBodyChrome(body, row), paneHeight: paneHeight(),
    });
    const step = (d: number) => setDraggedH((h) => Math.min(ceiling, Math.max(min, (h ?? bodyHeight ?? min) + d)));
    if (e.key === 'ArrowUp') { e.preventDefault(); step(16); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); step(-16); }
  };

  // ── Context + cost readout (state 1/11) ──────────────────────────────────────────
  const lastResult = conv.lastResult;
  // The STREAM is the primary source: Claude Code ≥2.1.x flushes a live session's transcript
  // only on exit/rotation, so `/agent/session-stats` (which reads that transcript) reports
  // nulls for the whole life of a chat — which is why this readout used to stay blank
  // forever. The polled stats remain as the fallback for a RESUMED conversation, whose
  // earlier turns are already on disk but whose usage this process has not seen stream by.
  const stats = useAgentSessionStats(session.claudeId, connected).data;
  // `used > 0` on the fallback too: a transcript whose only turn was a synthetic notice
  // (e.g. "Please run /login") reports zero tokens, and "0% 0/1.0M" is noise, not a reading.
  const statsLimit = stats?.contextLimit ?? contextLimitFor(stats?.contextTokens ?? 0, conv.model);
  const ctx = conv.context
    ?? (stats?.contextTokens ? { used: stats.contextTokens, limit: statsLimit, pct: Math.min(100, Math.round((stats.contextTokens / statsLimit) * 100)) }
      : null);
  // `total_cost_usd` off the result frame is already cumulative for the conversation.
  const costUsd = lastResult?.costUsd ?? stats?.costUsd ?? null;

  // The ACCOUNT's 5-hour and weekly caps, stacked under the context bar in the usage popover.
  // One 60s poll shared by every pane (see useUsageLimits); `usageLimits` drops any cap whose
  // source is missing, stale or describing a window that has already rolled over — so an
  // absent cap draws NO bar rather than an empty one.
  const usageRes = useUsageLimits(connected).data ?? null;
  const { limits: usageBars, staleAsOf } = usageLimits(ctx, usageRes, Date.now());

  const runCompact = () => {
    if (!connected) return;
    session.send('/compact');
  };

  // ── Submit ────────────────────────────────────────────────────────────────────────
  // Every attachment reaches the agent the same way: as a path in the message text. A
  // file/folder pick has one from the native picker; a pasted image has one once its bytes
  // land in the vault temp dir. An image whose upload FAILED has none, so it is not sendable
  // content and (unlike everything else) survives the submit — the chip stays, saying it
  // wasn't sent, rather than disappearing as if it had been.
  const sendableAttachments = attachments.filter((a) => !!a.path);
  const uploadingCount = attachments.filter((a) => a.uploading).length;
  const hasSendableContent = !!draft.trim() || sendableAttachments.length > 0
    || uploadingCount > 0;

  /** Everything `commit` builds the message from, re-read AFTER the await below — this
   *  render's closure would be stale by then (the user keeps typing; the turn can flip
   *  busy) and the message has to be the one that was actually in the box. */
  const liveRef = useRef({ draft, busy, connected, quote });
  liveRef.current = { draft, busy, connected, quote };
  /** Guards the window between "⏎ pressed" and "upload settled" against a second submit. */
  const sendingRef = useRef(false);
  const [awaitingUpload, setAwaitingUpload] = useState(false);

  /** `auto` — ⏎ and the ↑ button: send, or steer into the running turn.
   *  `queue` — the ⇡ button: hold for the NEXT turn whatever is happening now. */
  type SubmitMode = 'auto' | 'queue';

  const commit = (mode: SubmitMode) => {
    const { draft: text, busy: isBusy, connected: isConnected, quote: liveQuote } = liveRef.current;
    if (!isConnected) return;
    const pathsText = readScratch(convId).attachments.filter((a) => !!a.path)
      .map((a) => quotePath(a.path ?? '')).join(' ');
    const bodyText = pathsText ? (text.trim() ? `${text.trim()} ${pathsText}` : pathsText) : text.trim();
    const message = liveQuote ? `> ${liveQuote}\n\n${bodyText}` : bodyText;
    if (!message.trim()) return;

    // `/login` is the one command this surface must not forward. The headless engine replies
    // "/login isn't available in this environment." (verified on CLI 2.1.220) — a dead end for
    // the user typing exactly the right thing. Hand it to the terminal instead, and keep the
    // draft: if the sign-in tab isn't what they wanted, their text is still here.
    if (isSignInCommand(message)) { onSignIn(); return; }

    // Three deliveries, one commit — and which one it is depends on the gesture, not on luck:
    //
    //   idle,  ⏎/↑  → send. Starts a turn.
    //   busy,  ⏎/↑  → STEER: written to the running turn now, folded in at the CLI's next tool
    //                 boundary. This is the terminal's own behaviour, and the thing this
    //                 surface was missing — ⏎ used to park the message until the whole turn
    //                 settled, which on a long turn is the difference between a ten-second
    //                 correction and a five-minute one.
    //   any,   ⇡     → QUEUE: held as an editable row above (QueuedMessages.tsx) and sent when
    //                 this turn settles. The other intent, kept as its own button precisely
    //                 because it is no longer what ⏎ does.
    //
    // The steer can refuse (a card is open, the process is gone, the socket shut) and then the
    // message falls back into the queue — the one thing that must never happen is ⏎ eating the
    // text, which is what the original `if (busy) return` did.
    if (mode === 'queue') session.enqueue(message);
    else if (isBusy) { if (!session.steer(message)) session.enqueue(message, { steerWhenPossible: true }); }
    else session.send(message);
    setDraft('');
    session.syncDraft('');
    setNavBoth(NO_HISTORY_NAV);
    setSlashQuery(null);
    // Sent chips go (their previews with them); anything that could NOT be attached stays, so
    // the row keeps saying "not sent" instead of implying it went with the message. The rule is
    // "had a path" rather than "was not failed" — see `dropSentAttachments`, which also clears
    // the quote, so this conversation's staged state settles in one write.
    dropSentAttachments(convId);
    onClearQuote();
  };

  const submit = (mode: SubmitMode = 'auto') => {
    if (!connected || !hasSendableContent || sendingRef.current) return;
    // Nothing in flight — the common case, and it stays synchronous.
    if (uploadsRef.current.size === 0) { commit(mode); return; }
    // A screenshot pasted and sent in the same breath: the message can only name the file
    // once the path exists, so hold the submit for the upload rather than sending a message
    // that references nothing. Loopback write of a clipboard image — milliseconds.
    sendingRef.current = true;
    setAwaitingUpload(true);
    void Promise.allSettled([...uploadsRef.current]).then(() => {
      sendingRef.current = false;
      setAwaitingUpload(false);
      commit(mode);
    });
  };

  // ONLY disconnection disables the textarea — it must stay focusable while Claude
  // works (a disabled textarea drops focus to <body>, killing surface-level chords).
  const disabled = !connected;
  const modelLabel = modelLabelFor(modelConfig, model);
  const effortValue = effort || modelConfig.defaultEffort;
  const modeRow = chatModeRow(mode);

  // ── Toolbar menus (mode / model+effort / usage) ──────────────────────────────────
  // One open at a time, absolutely positioned inside `.chat-cmp` and opening upward — the
  // same escape `.chat-cmp-slash` makes from the card's `overflow: hidden`. See
  // useAnchoredMenu.ts for why these are not `Popover`s (the Attach menu still is: it clamps
  // to its trigger rather than spanning the card).
  const menu = useAnchoredMenu();
  // "Saved as default" is a receipt, so it is only ever shown for a write that HAPPENED. Any
  // subsequent model/effort change clears it: a receipt next to a value you have since
  // changed is a false one.
  //
  // The write lands in `~/.dreamcontext/agent-ui.json` via `patchAgentSettings` — app-global,
  // like every other surface preference in that blob, and read back by the next chat spawn.
  // Done HERE rather than handed up as a prop because this component holds both values the
  // write needs and the settings module is a plain import; routing it through the pane would
  // add a hop that carries no decision. `onSetModelDefault` stays as an override seam for a
  // caller that needs to do something else with it.
  const [savedDefault, setSavedDefault] = useState(false);
  const saveModelDefault = () => {
    if (onSetModelDefault) onSetModelDefault();
    else patchAgentSettings({ chatDefaultModel: model, chatDefaultEffort: effortValue });
    setSavedDefault(true);
  };

  // The gauge, as a ring. `ctx.pct` drives an arc over a 6.5px-radius circle; the full
  // reading stays reachable as the button's title (a hover) and as `aria-valuetext` (a
  // screen reader) — demoted, never deleted.
  const RING_R = 6.5;
  const RING_C = 2 * Math.PI * RING_R;
  const isTight = !!ctx && ctx.pct >= CONTEXT_TIGHT_PCT;
  const ctxReading = ctx
    ? `Context window ${ctx.pct}% — ${fmtTokens(ctx.used)} of ${fmtTokens(ctx.limit)} used, ${fmtTokens(Math.max(0, ctx.limit - ctx.used))} free`
    : 'Session usage';
  // Nothing found on ANY of the three readings means there is nothing behind the button, so
  // it isn't drawn. An empty popover is worse than an absent one.
  const hasUsage = usageBars.length > 0 || costUsd != null;

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

      {/* The toolbar's three menus. Siblings of the CARD, not children: the card clips its own
          overflow, and these open upward out of it (see useAnchoredMenu.ts). */}
      {menu.open === 'mode' && (
        <div ref={menu.menuRef}>
          <ModeMenu
            mode={mode}
            onModeChange={(m) => onModeChange?.(m)}
            permission={permissionMode}
            projectPermission={projectPermissionMode}
            onPermissionChange={onPermissionModeChange}
            close={menu.close}
          />
        </div>
      )}
      {menu.open === 'model' && (
        <div ref={menu.menuRef}>
          <ModelMenu
            config={modelConfig}
            model={model}
            effort={effortValue}
            onModelChange={(id) => { onModelChange(id); setSavedDefault(false); }}
            onEffortChange={(lvl) => { onEffortChange(lvl); setSavedDefault(false); }}
            onSetDefault={saveModelDefault}
            savedDefault={savedDefault}
            close={menu.close}
          />
        </div>
      )}
      {menu.open === 'usage' && (
        <div ref={menu.menuRef}>
          <UsageMenu limits={usageBars} staleAsOf={staleAsOf} costUsd={costUsd} />
        </div>
      )}

      <div className={`chat-cmp-card${shelved ? ' is-shelved' : ''}`}>
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

      {/* No `--chat-cmp-h` until the first measurement lands (a layout effect, so before
          paint) — composer.css's own two-line fallback holds the box until then, rather
          than a JS constant that would drift from the tokens the moment one moved. */}
      <div className="chat-cmp-body" ref={bodyRef} style={bodyHeight == null ? undefined : { ['--chat-cmp-h' as string]: `${bodyHeight}px` }}>
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

        {attachments.length > 0 && (
          <div className="chat-cmp-attachments">
            {attachments.map((a) => (
              <div
                key={a.id}
                className={`chat-cmp-attachment chat-cmp-attachment-${a.kind}`}
                data-state={a.uploading ? 'uploading' : a.failed ? 'failed' : 'ready'}
              >
                {a.kind === 'image' ? (
                  <img src={a.url} alt={a.name} className="chat-cmp-thumb" />
                ) : (
                  <span className="chat-cmp-attachment-glyph" aria-hidden>{a.kind === 'folder' ? '📁' : '📄'}</span>
                )}
                {/* An attachment says what will happen to it. A picture that can't be sent
                    must never look like one that can — that is the whole bug this row grew
                    a state for (a pasted screenshot the agent never received). */}
                <span className="chat-cmp-attachment-name">
                  {a.name}
                  {a.uploading && <span className="chat-cmp-attachment-note">attaching…</span>}
                  {a.failed && <span className="chat-cmp-attachment-note">couldn't attach — not sent</span>}
                </span>
                <button type="button" className="chat-cmp-chip-x" aria-label={`Remove ${a.name}`} onClick={() => removeAttachment(convId, a.id)}>✕</button>
              </div>
            ))}
          </div>
        )}

        <div className="chat-cmp-row" ref={rowRef}>
          <textarea
            ref={taRef}
            className="chat-cmp-input"
            // The idle arm names the slash path, which is where skills now live: the Skills
            // popover is gone and the `/` menu (already here, already listing every command
            // this session reported) is the whole affordance. Only the IDLE arm — the other
            // two are saying something more urgent than where to find a feature.
            placeholder={!connected ? 'Connecting…' : busy ? 'Claude is working — ⏎ queues your next message…' : 'Message Claude…   ·   "/" for skills'}
            value={draft}
            disabled={disabled}
            onChange={(e) => {
              setDraft(e.target.value);
              session.syncDraft(e.target.value);
              // Editing a recalled prompt ends the walk: the text is the user's own draft from
              // here on, so ↓ must not silently discard the edit to go "forward" to it, and the
              // next ↑ re-stashes what is actually in the box. BEFORE `syncSlash`, which reads
              // the walk to decide whether a leading `/` may open the menu.
              if (navRef.current.index !== null) setNavBoth(NO_HISTORY_NAV);
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
              // Prompt history — AFTER the slash arm, which owns ↑/↓ while its menu is open.
              if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                const el = e.currentTarget;
                const caret = el.selectionStart ?? 0;
                const end = el.selectionEnd ?? caret;
                const recallable = e.key === 'ArrowDown'
                  // ↓ is only ever a history key while a walk is in progress — otherwise it is
                  // the caret moving down through a multi-line draft.
                  ? nav.index !== null
                  : canRecallHistory(draft, caret, end, nav);
                // `recall` returns false at the end of the history, and then the keystroke is
                // left to the textarea rather than swallowed.
                if (recallable && recall(e.key === 'ArrowUp' ? 'back' : 'forward')) {
                  e.preventDefault();
                  return;
                }
              }
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
            }}
          />
        </div>
      </div>

      <div className="chat-cmp-toolbar">
        {/* Leading control, and it answers two questions in one word each: how is this agent
            briefed to WORK, and what may it do without asking. Everything after it is about
            composing the message; this is about who you are talking to. */}
        <div className="chat-cmp-perm-wrap">
          <button
            type="button"
            {...{ [MENU_TRIGGER_ATTR]: '' }}
            className="chat-cmp-modeltrigger"
            onClick={() => menu.toggle('mode')}
            title={`Mode: ${modeRow.name} · Permission: ${permissionMode}`}
            aria-haspopup="menu"
            aria-expanded={menu.open === 'mode'}
          >
            <span className="chat-cmp-modeltrigger-model">{modeRow.name}</span>
            {/* THIS SESSION's permission, handed down already resolved — see the prop's doc. */}
            <span className="chat-cmp-modeltrigger-effort">{permissionMode}</span>
            <span className="chat-cmp-caret" aria-hidden>▾</span>
          </button>
        </div>

        {/* One control for every kind of attachment — files, folders and (once a picker
            exists) a task. A bare `+` now that its labelled Skills neighbour is gone: it is
            the only icon control on this side of the row, so there is nothing for it to read
            as a loose part OF. Still a `Popover` (not one of the three panels above): its
            menu is a short list that clamps to its trigger rather than spanning the card. */}
        <Popover
          align="left"
          trigger={(open, toggle) => (
            <button type="button" className="chat-cmp-iconbtn" onClick={toggle} title="Attach files, folders or a task" aria-label="Attach" aria-haspopup="menu" aria-expanded={open}>
              <PlusIcon />
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

        <div className="chat-cmp-spacer" />

        {/* The gauge, the two modifiers and Send travel together and never shrink: losing the
            Send button to a squeeze would be the single worst outcome of a narrow pane. */}
        <div className="chat-cmp-right">
        {/* The context meter, demoted to a ring. Its resting state is one mark — the full
            `X / Y · N%` is a hover away (`title`) and a click away (the usage popover), and
            `aria-valuetext` carries it for a screen reader. It ESCALATES on its own: past
            CONTEXT_TIGHT_PCT the ring goes amber and `/compact` appears beside it without
            hover or focus, because at that point the action is the point. */}
        {hasUsage && (
          <button
            type="button"
            {...{ [MENU_TRIGGER_ATTR]: '' }}
            className="chat-cmp-usagebtn"
            data-tight={isTight}
            onClick={() => menu.toggle('usage')}
            title={ctxReading}
            aria-label={ctxReading}
            aria-haspopup="menu"
            aria-expanded={menu.open === 'usage'}
          >
            <svg
              width="16" height="16" viewBox="0 0 16 16" fill="none"
              role={ctx ? 'meter' : undefined}
              aria-valuemin={ctx ? 0 : undefined}
              aria-valuemax={ctx ? 100 : undefined}
              aria-valuenow={ctx ? ctx.pct : undefined}
              aria-valuetext={ctx ? ctxReading : undefined}
              aria-hidden={ctx ? undefined : true}
            >
              <circle className="chat-cmp-usagering-track" cx="8" cy="8" r={RING_R} strokeWidth="2" />
              {ctx && (
                <circle
                  className="chat-cmp-usagering-fill"
                  cx="8" cy="8" r={RING_R} strokeWidth="2" strokeLinecap="round"
                  transform="rotate(-90 8 8)"
                  strokeDasharray={`${(RING_C * Math.min(100, ctx.pct) / 100).toFixed(2)} ${RING_C.toFixed(2)}`}
                />
              )}
            </svg>
          </button>
        )}

        {isTight && (
          <button
            type="button"
            className="chat-cmp-compact-btn"
            onClick={runCompact}
            disabled={!connected}
            title="Ask Claude to compact the conversation"
          >
            <span aria-hidden>⚠</span>
            <span className="chat-cmp-compact-label">/compact</span>
          </button>
        )}

        {/* Model and effort as ONE trigger: they are read together ("Opus, Xhigh") and set
            together, and two adjacent text pills for one decision was half this row's width. */}
        <div className="chat-cmp-model-wrap">
          <button
            type="button"
            {...{ [MENU_TRIGGER_ATTR]: '' }}
            className="chat-cmp-modeltrigger"
            disabled={!connected}
            onClick={() => menu.toggle('model')}
            title="Model and reasoning effort — switch applies from the next turn"
            aria-haspopup="menu"
            aria-expanded={menu.open === 'model'}
          >
            <span className="chat-cmp-modeltrigger-model">{modelLabel}</span>
            <span className="chat-cmp-modeltrigger-effort">{effortLabel(effortValue)}</span>
            <span className="chat-cmp-caret" aria-hidden>▾</span>
          </button>
        </div>

        {/* Round icon buttons, sized to sit level with the model/effort text beside them —
            a label would only repeat what ⏎ already does.

            While a turn runs, up to THREE are offered, because all three actions are live and
            they are genuinely different asks: Stop ends the turn, ⇡ holds the message for the
            next one, ↑ hands it to this one. ⏎ maps to ↑, so the pointer path and the keyboard
            path agree — and ⇡ exists precisely because ⏎ no longer queues, which would
            otherwise have left "not this turn, the next one" with no way to say it at all.
            Both text buttons appear only once there is something to send, so an idle-handed
            Stop stays the single obvious control. */}
        {busy && (
          <button type="button" className="chat-cmp-send is-stop" title="Interrupt the in-flight turn (⌃C)" aria-label="Stop" onClick={() => session.interrupt()}>
            <span aria-hidden>■</span>
          </button>
        )}
        {busy && hasSendableContent && (
          <button
            type="button"
            className="chat-cmp-send is-queue"
            disabled={!connected || awaitingUpload}
            onClick={() => submit('queue')}
            title="Queue for the next turn — held above, editable until it goes"
            aria-label="Queue for the next turn"
          >
            {/* A DASHED up arrow for the queue: the same gesture as Send, deferred — and
                monochrome, like every other glyph on this surface. */}
            <span aria-hidden>⇡</span>
          </button>
        )}
        {(!busy || hasSendableContent) && (
          <button
            type="button"
            // Empty-handed it is an outline; with something to send it fills in — "can I send
            // this?" answered by the button's weight rather than by a disabled label.
            className={`chat-cmp-send${!connected || !hasSendableContent || awaitingUpload ? '' : ' is-enabled'}`}
            // Held (not dropped) while a pasted image finishes attaching — `submit` is
            // already waiting on it, so a second press would only be a double-send.
            disabled={!connected || !hasSendableContent || awaitingUpload}
            onClick={() => submit('auto')}
            title={awaitingUpload ? 'Attaching the pasted image…'
              : busy ? 'Send into the running turn (⏎) — picked up at the next step'
                : 'Send (⏎)'}
            aria-label={busy ? 'Send into the running turn' : 'Send'}
          >
            <span aria-hidden>↑</span>
          </button>
        )}
        </div>
      </div>
      </div>
    </div>
  );
}
