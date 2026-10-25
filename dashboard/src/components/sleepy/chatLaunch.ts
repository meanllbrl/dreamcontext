/**
 * The model, effort and account a chat tab runs on, carried through the roster (the server's
 * `SavedMeta.model/effort/account`, src/server/routes/agent-sessions.ts) so a relaunch resumes
 * it on them. Before this a restored chat fell back to the owner's Chat default, often xhigh: a
 * Super child started at medium came back at xhigh after every app restart (owner, 2026-10-24).
 * What is saved is what the chat RAN on (a running chat's own, the Chat default it was spawned
 * with included, when one is set), so a later change of the Chat default does not move it. An empty value is absent: the
 * Chat default then applies at spawn.
 */
export interface ChatLaunch { model?: string; effort?: string; account?: string }

export function chatLaunch(model: string | undefined, effort: string | undefined, account: string | undefined): ChatLaunch {
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(account ? { account } : {}) };
}

/** What a saved roster entry resumes with. The caller decides by the kind the tab is RESTORED
 *  as (a tab saved as a terminal agent can come back as a chat), so the saved kind is not read:
 *  the server only keeps these on chat entries, and fills a Super child's from its record. */
export function launchFromSaved(m: { model?: string; effort?: string; account?: string }): ChatLaunch {
  return chatLaunch(m.model, m.effort, m.account);
}

/** A dormant tab's settings: a parked tab's own, each field falling back to its `launch` (a Super
 *  child the relaunch held parked carries an empty `parked` beside the roster's `launch`). */
export function dormantLaunch(parked: ChatLaunch | undefined, launch: ChatLaunch | undefined): ChatLaunch | undefined {
  if (!parked) return launch;
  return chatLaunch(parked.model || launch?.model, parked.effort || launch?.effort, parked.account || launch?.account);
}

/** How a dormant tab's Resume reopens it. Read by Resume itself AND by `super resume`'s report, so
 *  what is reported is what runs: a parked tab as the transport it ran as, a tab saved in a chat
 *  mode as that chat, anything else as the Agent screen chosen now (`screen`). The model, effort
 *  and account ride only on a chat; a terminal reopens on the CLI's own. */
export function resumePlan(
  meta: { kind?: string; mode?: string; parked?: ChatLaunch & { transport: 'chat' | 'agent' }; launch?: ChatLaunch },
  screen: string,
): { asChat: boolean; spawnKind: string; launch: ChatLaunch } {
  const asChat = meta.parked ? meta.parked.transport === 'chat' : meta.kind === 'chat' && !!meta.mode;
  const spawnKind = asChat ? 'chat' : meta.parked ? meta.parked.transport : screen;
  return { asChat, spawnKind, launch: spawnKind === 'chat' ? (dormantLaunch(meta.parked, meta.launch) ?? {}) : {} };
}

/** What a roster save writes for one tab: a running chat's own settings, else (a dormant or
 *  parked tab, no process) the ones it will resume with. Nothing for any other kind. */
export function savedChatLaunch(kind: string | undefined, live: ChatLaunch | null, dormant: ChatLaunch | undefined): ChatLaunch {
  if (kind !== 'chat') return {};
  return live ?? dormant ?? {};
}
