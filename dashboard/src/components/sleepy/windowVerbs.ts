import type { ChatMode } from '../../lib/chatModes';

/**
 * Window control, the surface half: what the chat surface does when one of its chats' own
 * agent runs `dreamcontext window <verb>` (src/lib/window-control.ts sends it down that chat's
 * socket). `AgentSurface` lends the layout and its actions; this module owns the verbs, so
 * they are testable without React.
 *
 * Tabs are addressed by the id `state` lists: a tab's conversation id (`claudeId`), never a
 * position, so a verb cannot land on the wrong tab because another one moved. No `tab` means
 * the chat that asked (`self`). The server has already validated every argument's shape.
 */

export interface WindowTab {
  /** The surface's internal session id. */
  sid: string;
  /** The id the agent sees and passes back. */
  tab: string;
  title: string;
  kind: string;
  mode?: ChatMode;
  model?: string;
  busy: boolean;
  asking: boolean;
  dormant: boolean;
}

export interface WindowPane {
  id: string;
  tabs: string[];
  active: string;
}

export interface WindowVerbDeps {
  /** The calling chat's internal session id. */
  self: string;
  panes: WindowPane[];
  activePaneId: string;
  tabs: WindowTab[];
  openNew: (o: { prompt: string; mode: ChatMode; model: string; effort: string; split: boolean; terminal: boolean }) => Promise<string>;
  split: (sid: string, paneId: string) => void;
  join: (sid: string, paneId: string) => void;
  focus: (sid: string, paneId: string) => void;
  /** Respawns the chat in the new mode, at its next turn boundary. */
  setMode: (sid: string, mode: ChatMode) => 'now' | 'after-turn';
  setModel: (sid: string, model: string) => boolean;
  setEffort: (sid: string, level: string) => boolean;
  /** Busy: steered into the running turn; asking: queued behind the open card; idle: sent. */
  send: (sid: string, text: string) => 'steered' | 'queued' | 'sent' | false;
  close: (sid: string) => void;
}

export type WindowVerbResult = { ok: true; result?: unknown } | { ok: false; error: string };

const MODES: readonly ChatMode[] = ['basic', 'plan', 'develop'];

function paneOf(deps: WindowVerbDeps, sid: string): WindowPane | undefined {
  return deps.panes.find((p) => p.tabs.includes(sid));
}

/** The tab an argument names, or the calling chat when it names none. */
function resolve(deps: WindowVerbDeps, arg: unknown): WindowTab | string {
  if (arg === undefined || arg === null || arg === '') {
    const self = deps.tabs.find((t) => t.sid === deps.self);
    return self ?? 'this chat is not a tab of this window any more';
  }
  const t = deps.tabs.find((x) => x.tab === arg || x.sid === arg);
  return t ?? `no tab "${String(arg)}" in this window; run \`dreamcontext window state\``;
}

/** The layout the agent reads: panes left to right, each tab with what it is doing. */
export function windowState(deps: WindowVerbDeps): Record<string, unknown> {
  const byId = new Map(deps.tabs.map((t) => [t.sid, t]));
  return {
    panes: deps.panes.map((p, i) => ({
      pane: i + 1,
      focused: p.id === deps.activePaneId,
      tabs: p.tabs.map((sid) => byId.get(sid)).filter((t): t is WindowTab => !!t).map((t) => ({
        tab: t.tab,
        title: t.title,
        kind: t.kind,
        ...(t.kind === 'chat' ? { mode: t.mode ?? 'basic', ...(t.model ? { model: t.model } : {}) } : {}),
        status: t.dormant ? 'dormant' : t.asking ? 'asking' : t.busy ? 'working' : 'idle',
        ...(p.active === t.sid ? { visible: true } : {}),
        ...(t.sid === deps.self ? { self: true } : {}),
      })),
    })),
  };
}

export async function runWindowVerb(deps: WindowVerbDeps, verb: string, args: Record<string, unknown>): Promise<WindowVerbResult> {
  if (verb === 'state') return { ok: true, result: windowState(deps) };

  if (verb === 'new') {
    const mode = MODES.includes(args.mode as ChatMode) ? args.mode as ChatMode : 'basic';
    const tab = await deps.openNew({
      prompt: typeof args.prompt === 'string' ? args.prompt : '',
      mode,
      model: typeof args.model === 'string' ? args.model : '',
      effort: typeof args.effort === 'string' ? args.effort : '',
      split: args.split === true,
      terminal: args.terminal === true,
    });
    return { ok: true, result: { tab, placed: args.split === true ? 'new pane' : 'tab' } };
  }

  const t = resolve(deps, args.tab);
  if (typeof t === 'string') return { ok: false, error: t };
  const pane = paneOf(deps, t.sid);

  if (verb === 'split') {
    if (!pane) return { ok: false, error: 'that tab is not in a pane' };
    if (pane.tabs.length === 1) return { ok: true, result: { tab: t.tab, unchanged: 'it already has a pane of its own' } };
    deps.split(t.sid, pane.id);
    return { ok: true, result: { tab: t.tab, placed: 'new pane' } };
  }
  if (verb === 'join') {
    const into = resolve(deps, args.into);
    if (typeof into === 'string') return { ok: false, error: into };
    const target = paneOf(deps, into.sid);
    if (!target) return { ok: false, error: 'the --into tab is not in a pane' };
    if (target.tabs.includes(t.sid)) return { ok: true, result: { tab: t.tab, unchanged: 'already in that pane' } };
    deps.join(t.sid, target.id);
    return { ok: true, result: { tab: t.tab, joined: into.tab } };
  }
  if (verb === 'focus') {
    if (!pane) return { ok: false, error: 'that tab is not in a pane' };
    deps.focus(t.sid, pane.id);
    return { ok: true, result: { tab: t.tab } };
  }

  // Everything below acts on a CHAT that is running.
  if (verb === 'close') {
    if (t.sid === deps.self) return { ok: false, error: 'a chat cannot close itself; the owner closes it' };
    if ((t.busy || t.asking) && args.force !== true) {
      return { ok: false, error: `that tab is ${t.asking ? 'asking' : 'working'}; close it with --force only when the owner said so` };
    }
    deps.close(t.sid);
    return { ok: true, result: { tab: t.tab, closed: true } };
  }
  if (t.kind !== 'chat') return { ok: false, error: `"${verb}" works on a chat tab; that one is a ${t.kind}` };
  if (t.dormant) return { ok: false, error: 'that chat is not running; the owner resumes it first' };

  if (verb === 'mode') {
    const mode = args.mode as ChatMode;
    if (!MODES.includes(mode)) return { ok: false, error: `mode must be one of ${MODES.join(' | ')}` };
    if ((t.mode ?? 'basic') === mode) return { ok: true, result: { tab: t.tab, mode, unchanged: true } };
    const when = deps.setMode(t.sid, mode);
    return {
      ok: true,
      result: {
        tab: t.tab,
        mode,
        when: when === 'now' ? 'restarted now on the same conversation' : 'restarts on the same conversation as soon as the current turn ends',
      },
    };
  }
  if (verb === 'model') {
    const model = typeof args.model === 'string' ? args.model : '';
    if (!deps.setModel(t.sid, model)) return { ok: false, error: 'that chat is not running' };
    return { ok: true, result: { tab: t.tab, model, applies: 'from the next turn' } };
  }
  if (verb === 'effort') {
    const level = typeof args.level === 'string' ? args.level : '';
    if (!deps.setEffort(t.sid, level)) return { ok: false, error: 'that chat is not running' };
    return { ok: true, result: { tab: t.tab, effort: level } };
  }
  if (verb === 'send') {
    if (t.sid === deps.self) return { ok: false, error: 'that is this chat; just keep going' };
    const text = typeof args.text === 'string' ? args.text : '';
    const out = deps.send(t.sid, text);
    if (!out) return { ok: false, error: 'that chat is not running' };
    return { ok: true, result: { tab: t.tab, delivered: out } };
  }
  return { ok: false, error: `this window cannot run "${verb}"` };
}
