import { DEFAULT_CHAT_MODE } from '../../lib/chatModes';
import { historyChatItem, type ChatItem, type ChatSession, type ConversationModel, type HistoryEntry } from './chatSession';

/**
 * A conversation that has NO process, drawn by the same ChatPane a live chat uses: a finished
 * Super child (it did its job and exited, `gone`; a relaunch brings it back as a dormant tab) has
 * only its transcript on disk. Its card used to mount an empty slot (bug 2026-10-25: "a big empty
 * white area, Read only. and nothing under it").
 *
 * The object speaks ChatSession so the pane needs no second code path, but it never opens a
 * socket and never starts `claude`: every verb is a no-op, and the only thing that changes it is
 * {@link TranscriptSession.load}, fed from `/agent/chat-history`. The replay lands in `items`,
 * not `history`, so the pane draws no "earlier conversation · resumed" divider over a chat that
 * was never resumed.
 */
export interface TranscriptSession extends ChatSession {
  /** Replace what it shows with this transcript (the chat-history wire). */
  load: (entries: readonly HistoryEntry[]) => void;
}

let transcriptSeq = 0;

export function createTranscriptSession(
  claudeId: string,
  /** The pane's portal target. Injectable so a test runs without a DOM. */
  makeContainer: () => HTMLDivElement = () => {
    const el = document.createElement('div');
    el.className = 'agent-pane-chat';
    return el;
  },
): TranscriptSession {
  let conv: ConversationModel = {
    items: [], history: [], pending: [], queued: [], draft: '', draftEpoch: 0, capabilities: [], subAgents: [],
  };
  const subscribers = new Set<() => void>();
  const noop = () => { /* a finished conversation: nothing to do */ };
  const off = () => noop;
  const session: TranscriptSession = {
    id: `transcript-${++transcriptSeq}`,
    bypass: false,
    kind: 'chat',
    claudeId,
    container: makeContainer(),
    // 'open', not 'closed': closed draws "Session ended · Resume", and a card read only has
    // nothing to resume from here (the Super Agent does that with `super resume`).
    status: 'open',
    takenOver: false,
    takeBack: noop,
    setOnScreen: noop,
    opened: true,
    busy: false,
    asking: false,
    attention: false,
    agentsWorking: false,
    minimized: false,
    capabilities: [],
    model: '',
    effort: '',
    accountId: '',
    mode: DEFAULT_CHAT_MODE,
    agent: '',
    superMirror: false,
    superDigest: null,
    onSuperDigest: off,
    clearDraftEpochReason: noop,
    ensureOpen: noop,
    fitAndResize: noop,
    applyZoom: noop,
    sendText: noop,
    syncDraft: noop,
    dismissBranchNotice: noop,
    dismissHandoff: noop,
    dismissAccountSwitch: noop,
    noteAccountSwitch: noop,
    focus: noop,
    dispose: () => { subscribers.clear(); },
    subscribe: (cb) => { subscribers.add(cb); return () => { subscribers.delete(cb); }; },
    getModel: () => conv,
    send: noop,
    steer: () => false,
    canSteer: () => false,
    enqueue: noop,
    pauseQueue: noop,
    sendQueuedNow: noop,
    editQueued: noop,
    removeQueued: noop,
    flushQueue: noop,
    setCommandHandler: noop,
    setOwnerWordsHook: noop,
    setWindowHandler: noop,
    setParkHandler: noop,
    markFocus: noop,
    hasLiveWork: () => false,
    setSuperHandler: noop,
    onSuper: off,
    superChild: false,
    setSuperChild: noop,
    setDraftListener: noop,
    answer: () => false,
    answerQuestion: () => false,
    reconnectSoon: noop,
    interrupt: noop,
    bargeInSpeech: noop,
    armSpoken: noop,
    typedAt: () => 0,
    onSpeaking: off,
    onSpokenChunk: off,
    onPresent: off,
    setModel: noop,
    setEffort: noop,
    setContextHandoff: noop,
    setPermissionMode: noop,
    stopTask: noop,
    rewind: async () => { /* nothing to rewind */ },
    retry: async () => { /* nothing to retry */ },
    alwaysAllow: noop,
    clearAttention: noop,
    setAgentsWorking: noop,
    setFocusTarget: noop,
    setTranscriptRepin: noop,
    load: (entries) => {
      let seq = 0;
      const items = entries.map((h) => historyChatItem(h, `tr-${++seq}`)).filter((x): x is ChatItem => !!x);
      conv = { ...conv, items };
      subscribers.forEach((cb) => { try { cb(); } catch { /* a broken subscriber must not stop the rest */ } });
    },
  };
  return session;
}
