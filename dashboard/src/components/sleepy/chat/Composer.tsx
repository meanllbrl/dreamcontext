import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { pickFiles, pickFolders } from '../../../lib/desktop';
import { uploadAgentFile } from '../../../lib/agentDrop';
import { useAgentSessionStats } from '../../../hooks/useAgentCapabilities';
import {
  effortLabel, modelLabelFor, quotePath, isSignInCommand, contextLimitFor,
  slashQueryAt, filterSlashCommands, applySlashCommand, type ModelConfig,
} from '../../../lib/agentComposer';
import {
  composerBodyHeight, composerHeightBounds, measureBodyChrome, measureFieldContent, readFieldMetrics,
} from './composerHeight';
import {
  promptHistory, canRecallHistory, stepHistory, NO_HISTORY_NAV, type HistoryNav,
} from './chatEntities';
import { Popover, SkillBrowser } from '../SkillPickerPopover';
import { PermissionModeMenu } from './PermissionModeMenu';
import { ContextReadout } from './ContextReadout';
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
 *
 * ── Parity with the terminal's readline (07-26) ─────────────────────────────────────
 * Two things the terminal pane gets free from the CLI's own readline, which a headless chat
 * has to build, and whose absence made the DEFAULT surface worse than the fallback one:
 *   QUEUE   — ⏎ while `busy` no longer no-ops. `submit` routes to `session.enqueue`, and the
 *             message becomes an editable row in the strip above (QueuedMessages.tsx), sent
 *             when the turn settles. The queue itself lives on the session model, not here,
 *             so it survives minimize/restore and drains where the busy edge is observed.
 *   HISTORY — ↑/↓ walk this conversation's own past prompts (`promptHistory`, newest first,
 *             `history` + `items` so a RESUMED chat can re-run its earlier turns). The nav
 *             state is local because it is a cursor into a view, not conversation state; the
 *             rules that keep it from eating a half-typed draft are pure and tested in
 *             chatEntities.ts (`canRecallHistory`, `stepHistory`).
 */

interface Attachment {
  id: string;
  kind: 'image' | 'file' | 'folder';
  name: string;
  /** Image attachments only — an object URL for the pasted `File` blob, so the chip shows
   *  the picture itself while its bytes are still on their way to disk; revoked on removal
   *  and on unmount. The preview is NOT what gets sent (see `path`). */
  url?: string;
  /** The absolute path the outgoing message quotes — a real path from the native picker
   *  (`pickFiles`/`pickFolders`) for a file/folder, and for a pasted image the path the
   *  vault temp dir got when its bytes were uploaded (`uploadAgentFile`). The chat protocol
   *  is text-only, so this path IS the attachment as far as the agent is concerned. */
  path?: string;
  /** Image attachments only — bytes still in flight, so there is no `path` to send yet.
   *  `submit` waits for these rather than sending a message that references nothing. */
  uploading?: boolean;
  /** Image attachments only — the upload was refused (not the desktop app, over the 25 MB
   *  cap, unwritable temp dir). The chip says so instead of pretending it will be sent. */
  failed?: boolean;
}

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
  quote, onClearQuote, onOpenTaskPicker, permissionMode, onPermissionModeChange, onSignIn,
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
  /** Take over a submitted `/login` (or `/logout`): this engine is headless and answers both
   *  with "isn't available in this environment", so sending them would spend a turn to be told
   *  nothing. The handler opens an interactive terminal Claude tab that CAN run the flow. */
  onSignIn: () => void;
}) {
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
      const id = `att-${++attSeqRef.current}`;
      const name = file.name || 'Pasted image';
      const url = URL.createObjectURL(file);
      const chip: Attachment = { id, kind: 'image', url, name, uploading: true };
      // Ref first, state second — same reason as the settle below: the ref is what `submit`
      // and the unmount cleanup read, and it must know about this chip before the next render.
      attachmentsRef.current = [...attachmentsRef.current, chip];
      setAttachments((prev) => [...prev, chip]);
      const job = uploadAgentFile(file, name).then((path) => {
        const settle = (list: Attachment[]) => list.map((a) => (a.id === id
          ? { ...a, path: path ?? undefined, uploading: false, failed: !path }
          : a));
        // Written STRAIGHT to the ref as well as to state, because `submit` can read it in
        // the same microtask batch this resolved in — before React has re-rendered and
        // re-pointed the ref. Without this the path would depend on flush ordering, which is
        // exactly the kind of "works on my machine" the send path must not rest on. The next
        // render overwrites the ref with the same value.
        attachmentsRef.current = settle(attachmentsRef.current);
        setAttachments(settle);
      });
      uploadsRef.current.add(job);
      void job.finally(() => uploadsRef.current.delete(job));
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
  // skill / attachment rows appearing or disappearing.
  useLayoutEffect(() => { resize(); }, [resize, draft, draggedH, quote, skillChip, attachments]);

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
    || uploadingCount > 0 || !!skillChip;

  /** Everything `commit` builds the message from, re-read AFTER the await below — this
   *  render's closure would be stale by then (the user keeps typing; the turn can flip
   *  busy) and the message has to be the one that was actually in the box. */
  const liveRef = useRef({ draft, busy, connected, quote, skillChip });
  liveRef.current = { draft, busy, connected, quote, skillChip };
  /** Guards the window between "⏎ pressed" and "upload settled" against a second submit. */
  const sendingRef = useRef(false);
  const [awaitingUpload, setAwaitingUpload] = useState(false);

  const commit = () => {
    const { draft: text, busy: isBusy, connected: isConnected, quote: liveQuote, skillChip: skill } = liveRef.current;
    if (!isConnected) return;
    const pathsText = attachmentsRef.current.filter((a) => !!a.path)
      .map((a) => quotePath(a.path ?? '')).join(' ');
    const bodyText = pathsText ? (text.trim() ? `${text.trim()} ${pathsText}` : pathsText) : text.trim();
    const withSkill = skill ? `${skill}${bodyText}` : bodyText;
    const message = liveQuote ? `> ${liveQuote}\n\n${withSkill}` : withSkill;
    if (!message.trim()) return;

    // `/login` is the one command this surface must not forward. The headless engine replies
    // "/login isn't available in this environment." (verified on CLI 2.1.220) — a dead end for
    // the user typing exactly the right thing. Hand it to the terminal instead, and keep the
    // draft: if the sign-in tab isn't what they wanted, their text is still here.
    if (isSignInCommand(message)) { onSignIn(); return; }

    // ⏎ while Claude is working QUEUES rather than doing nothing — the CLI's own readline does
    // this for the terminal pane, and this composer used to hard-return on `busy`, which is
    // what made "line up the next instruction while a long turn runs" impossible here. The
    // message leaves the composer either way: it is committed, just not in flight yet, and it
    // stays editable as a row in the queue strip above (QueuedMessages.tsx).
    if (isBusy) session.enqueue(message);
    else session.send(message);
    setDraft('');
    session.syncDraft('');
    setNavBoth(NO_HISTORY_NAV);
    setSlashQuery(null);
    // Sent chips go (their previews with them); a chip that could NOT be attached stays, so
    // the row keeps saying "not sent" instead of implying it went with the message. Ref and
    // state together, for the same reason the paste path writes both.
    const kept = attachmentsRef.current.filter((a) => a.failed);
    attachmentsRef.current.forEach((a) => {
      if (!a.failed && a.kind === 'image' && a.url) URL.revokeObjectURL(a.url);
    });
    attachmentsRef.current = kept;
    setAttachments(kept);
    setSkillChip(null);
    onClearQuote();
  };

  const submit = () => {
    if (!connected || !hasSendableContent || sendingRef.current) return;
    // Nothing in flight — the common case, and it stays synchronous.
    if (uploadsRef.current.size === 0) { commit(); return; }
    // A screenshot pasted and sent in the same breath: the message can only name the file
    // once the path exists, so hold the submit for the upload rather than sending a message
    // that references nothing. Loopback write of a clipboard image — milliseconds.
    sendingRef.current = true;
    setAwaitingUpload(true);
    void Promise.allSettled([...uploadsRef.current]).then(() => {
      sendingRef.current = false;
      setAwaitingUpload(false);
      commit();
    });
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
                <button type="button" className="chat-cmp-chip-x" aria-label={`Remove ${a.name}`} onClick={() => removeAttachment(a.id)}>✕</button>
              </div>
            ))}
          </div>
        )}

        <div className="chat-cmp-row" ref={rowRef}>
          <textarea
            ref={taRef}
            className="chat-cmp-input"
            placeholder={!connected ? 'Connecting…' : busy ? 'Claude is working — ⏎ queues your next message…' : 'Message Claude…'}
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
            <button type="button" className={`chat-cmp-btn-ghost${open ? ' open' : ''}`} onClick={toggle} title="Attach files, folders or a task" aria-label="Attach" aria-haspopup="menu" aria-expanded={open}>
              {/* The word and the caret are wrapped, not bare text: below the icon-only
                  breakpoint both are dropped and the `title` carries the label instead. */}
              <PlusIcon /> <span className="chat-cmp-btn-label">Attach</span> <span className="chat-cmp-caret" aria-hidden>▾</span>
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
            <button type="button" className={`chat-cmp-btn-ghost${open ? ' open' : ''}`} onClick={toggle} title="Skills" aria-label="Skills" aria-haspopup="menu" aria-expanded={open}>
              <span className="chat-cmp-spark" aria-hidden>✦</span> <span className="chat-cmp-btn-label">Skills</span> <span className="chat-cmp-caret" aria-hidden>▾</span>
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

        {/* Its own class, not a bare `.chat-cmp-spacer`: the narrow stages collapse THIS one
            (and only this one) to left-dock the gauge against the controls. */}
        <div className="chat-cmp-spacer chat-cmp-spacer-lead" />

        {/* Context + cost, in the toolbar's own dead space rather than on a line of its own:
            it belongs to the same strip as the model and effort it depends on, and it costs
            the transcript no height. It is also the row's only elastic child — as the pane
            narrows it sheds detail in stages down to a bare gauge, so the toolbar stays ONE
            row instead of wrapping into a lopsided two-line block. See ContextReadout.tsx. */}
        <ContextReadout ctx={ctx} costUsd={costUsd} onCompact={runCompact} compactEnabled={connected} />

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
            the label would only repeat what ⏎ already does.

            While a turn runs BOTH are offered, because both actions are live: Stop ends the
            turn, and the send button becomes a queue button (⏎'s own behaviour — see `submit`).
            Making the mouse path stop at Stop while ⏎ queued would leave the pointer user with
            no way to reach the feature at all. The queue button appears only once there is
            something to queue, so an idle-handed Stop stays the single obvious control. */}
        {busy && (
          <button type="button" className="chat-cmp-btn chat-cmp-stop" title="Interrupt the in-flight turn (⌃C)" aria-label="Stop" onClick={() => session.interrupt()}>
            <span aria-hidden>■</span>
          </button>
        )}
        {(!busy || hasSendableContent) && (
          <button
            type="button"
            className={`chat-cmp-btn chat-cmp-send${busy ? ' chat-cmp-queue' : ''}`}
            // Held (not dropped) while a pasted image finishes attaching — `submit` is
            // already waiting on it, so a second press would only be a double-send.
            disabled={!connected || !hasSendableContent || awaitingUpload}
            onClick={submit}
            title={awaitingUpload ? 'Attaching the pasted image…' : busy ? 'Queue for the next turn (⏎)' : 'Send (⏎)'}
            aria-label={busy ? 'Queue message' : 'Send'}
          >
            {/* A DASHED up arrow for the queue: same gesture as Send, deferred — and
                monochrome, like every other glyph on this surface. */}
            <span aria-hidden>{busy ? '⇡' : '↑'}</span>
          </button>
        )}
        </div>
      </div>
      </div>
    </div>
  );
}
