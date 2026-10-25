/**
 * A relaunch resumes each chat on the model, effort and account it ran on (owner, 2026-10-24).
 * Before this the roster kept none of them, so a restored Super child reopened on the owner's
 * Chat default (often xhigh) whatever it was started with: 26 children went high → xhigh at the
 * same minutes, right after app restarts (_dream_context/tmp/super-sonuclar/model-efor/rapor.md).
 *
 *  - the server's `sanitizeRoster` keeps them, on chat entries only, each through its spawn gate;
 *  - GET hands them back, and fills a Super child's missing ones from its record (else the
 *    child default for its mode), never leaving it to the Chat default;
 *  - the client writes a running chat's own settings, and a dormant tab's until it runs again.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sanitizeRoster, restoredLaunch, handleAgentSessionsGet, type SavedMeta } from '../../src/server/routes/agent-sessions.js';
import { SUPER_STATE_REL, resetSuperIndex } from '../../src/lib/super/store.js';
import { emptySuperState, type SuperState } from '../../src/lib/super/types.js';
import { childDefaultEffort } from '../../src/lib/model-facts.js';
import { launchFromSaved, savedChatLaunch, chatLaunch, dormantLaunch, resumePlan } from '../../dashboard/src/components/sleepy/chatLaunch.js';

const CHILD = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const OTHER = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';
const entry = (over: Partial<SavedMeta> & Record<string, unknown> = {}) => ({
  title: 'Job', bypass: false, minimized: false, size: 1, sessionId: CHILD, kind: 'chat', ...over,
});

describe('sanitizeRoster: what a chat runs on', () => {
  it('keeps model, effort and account on a chat entry', () => {
    const [m] = sanitizeRoster({ sessions: [entry({ model: 'sonnet', effort: 'medium', account: 'work-acct' })] })!;
    expect(m).toMatchObject({ model: 'sonnet', effort: 'medium', account: 'work-acct' });
  });

  it('drops them on every other kind', () => {
    for (const kind of ['agent', 'shell', 'automation', undefined]) {
      const [m] = sanitizeRoster({ sessions: [entry({ kind, model: 'sonnet', effort: 'medium', account: 'work-acct' })] })!;
      expect(m.model).toBeUndefined();
      expect(m.effort).toBeUndefined();
      expect(m.account).toBeUndefined();
    }
  });

  it('drops a value its spawn gate would refuse', () => {
    const [m] = sanitizeRoster({ sessions: [entry({ model: 'opus; rm -rf ~', effort: 'ultra', account: 'Bad--Id' })] })!;
    expect(m.model).toBeUndefined();
    expect(m.effort).toBeUndefined();
    expect(m.account).toBeUndefined();
    const [n] = sanitizeRoster({ sessions: [entry({ model: 42, effort: ['high'], account: { id: 'x' } })] })!;
    expect([n.model, n.effort, n.account]).toEqual([undefined, undefined, undefined]);
  });
});

describe('restoredLaunch: what GET hands back', () => {
  const state = (children: SuperState['children'] = {}): SuperState => ({ ...emptySuperState(), children });
  const child = (over: Record<string, unknown> = {}) => ({ sessionId: CHILD, brief: 'job', adopted: false, startedAt: 1, ...over }) as SuperState['children'][string];
  const anyAccount = () => true;

  it("the entry's own settings win", () => {
    const m = sanitizeRoster({ sessions: [entry({ model: 'opus', effort: 'high' })] })![0];
    expect(restoredLaunch(m, state({ [CHILD]: child({ model: 'sonnet', effort: 'low' }) }), anyAccount)).toEqual({ model: 'opus', effort: 'high' });
  });

  it('a Super child saved without them takes its record', () => {
    const m = sanitizeRoster({ sessions: [entry()] })![0];
    expect(restoredLaunch(m, state({ [CHILD]: child({ mode: 'develop', model: 'sonnet', effort: 'medium' }) }), anyAccount))
      .toEqual({ model: 'sonnet', effort: 'medium' });
  });

  it('a Super child with no effort anywhere takes the child default for its mode, never the Chat default', () => {
    for (const mode of ['basic', 'plan', 'develop']) {
      const m = sanitizeRoster({ sessions: [entry()] })![0];
      const got = restoredLaunch(m, state({ [CHILD]: child(mode === 'basic' ? {} : { mode }) }), anyAccount);
      expect(got.effort).toBe(childDefaultEffort(mode));
      expect(got.effort).not.toBe('xhigh');
    }
  });

  it("an owner's own chat saved without them stays on the Chat default", () => {
    const m = sanitizeRoster({ sessions: [entry({ sessionId: OTHER })] })![0];
    expect(restoredLaunch(m, state({ [CHILD]: child({ effort: 'low' }) }), anyAccount)).toEqual({});
  });

  it('an account no longer registered is dropped (the default account is used)', () => {
    const m = sanitizeRoster({ sessions: [entry({ effort: 'high', account: 'gone-acct' })] })![0];
    expect(restoredLaunch(m, state(), (id) => id !== 'gone-acct')).toEqual({ effort: 'high' });
    expect(restoredLaunch(m, state(), () => true)).toEqual({ effort: 'high', account: 'gone-acct' });
  });

  it('nothing for a tab that is not a chat, unless it is a Super child (it may come back as one)', () => {
    const agent = sanitizeRoster({ sessions: [entry({ kind: 'agent', sessionId: OTHER, model: 'opus', effort: 'low' })] })![0];
    expect(restoredLaunch(agent, state({ [CHILD]: child({ effort: 'low' }) }), anyAccount)).toEqual({});
    // Saved while the Agent screen was Terminal: its record still answers when it reopens as a chat.
    const swapped = sanitizeRoster({ sessions: [entry({ kind: 'agent', effort: 'xhigh' })] })![0];
    expect(swapped.effort).toBeUndefined();
    expect(restoredLaunch(swapped, state({ [CHILD]: child({ mode: 'develop', effort: 'medium' }) }), anyAccount)).toEqual({ effort: 'medium' });
    const shell = sanitizeRoster({ sessions: [entry({ kind: 'shell' })] })![0];
    expect(restoredLaunch(shell, state({ [CHILD]: child({ effort: 'low' }) }), anyAccount)).toEqual({});
  });
});

describe('GET /api/agent/sessions: a relaunch reads them back', () => {
  const dirs: string[] = [];
  const realDesktop = process.env.DREAMCONTEXT_DESKTOP;
  afterEach(() => {
    if (realDesktop === undefined) delete process.env.DREAMCONTEXT_DESKTOP;
    else process.env.DREAMCONTEXT_DESKTOP = realDesktop;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    resetSuperIndex();
  });

  function vault(roster: Record<string, unknown>, superState?: Record<string, unknown>): string {
    const root = mkdtempSync(join(tmpdir(), 'dc-roster-launch-'));
    dirs.push(root);
    mkdirSync(join(root, 'state'), { recursive: true });
    writeFileSync(join(root, 'state', '.agent-sessions.json'), `${JSON.stringify(roster)}\n`, 'utf-8');
    if (superState) writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: 'sup-1', enabled: true, ...superState }));
    return root;
  }

  async function get(root: string): Promise<Array<Record<string, unknown>>> {
    process.env.DREAMCONTEXT_DESKTOP = '1';
    let body: unknown = null;
    const res = { writeHead() {}, setHeader() {}, end(d: string) { body = JSON.parse(d); } } as unknown as ServerResponse;
    const home = mkdtempSync(join(tmpdir(), 'dc-roster-launch-home-'));
    dirs.push(home);
    await handleAgentSessionsGet({} as IncomingMessage, res, {}, root, home);
    return (body as { sessions: Array<Record<string, unknown>> }).sessions;
  }

  it('returns the model and effort a chat was saved with', async () => {
    const [m] = await get(vault({ sessions: [entry({ mode: 'develop', model: 'sonnet', effort: 'medium' })] }));
    expect(m).toMatchObject({ kind: 'chat', mode: 'develop', model: 'sonnet', effort: 'medium' });
  });

  it("fills a Super child's from its record when the saved entry predates them", async () => {
    const root = vault(
      { sessions: [entry({ mode: 'develop' })] },
      { children: { [CHILD]: { sessionId: CHILD, brief: 'job', adopted: false, startedAt: 1, mode: 'develop', model: 'opus', effort: 'medium' } } },
    );
    const [m] = await get(root);
    expect(m).toMatchObject({ model: 'opus', effort: 'medium' });
  });

  it('drops an account this machine does not have', async () => {
    const [m] = await get(vault({ sessions: [entry({ effort: 'high', account: 'gone-acct' })] }));
    expect(m.effort).toBe('high');
    expect(m.account).toBeUndefined();
  });
});

describe('chatLaunch (client): what a save writes and a restore resumes with', () => {
  it('a restore reads what GET handed back; the kind it restores as is the caller\'s to decide', () => {
    expect(launchFromSaved({ model: 'opus', effort: 'medium', account: '' })).toEqual({ model: 'opus', effort: 'medium' });
    expect(launchFromSaved({})).toEqual({});
  });

  it("a save writes a running chat's own settings, else the dormant tab's", () => {
    const live = chatLaunch('sonnet', 'low', '');
    expect(savedChatLaunch('chat', live, { effort: 'high' })).toEqual({ model: 'sonnet', effort: 'low' });
    expect(savedChatLaunch('chat', null, { model: 'opus', effort: 'high' })).toEqual({ model: 'opus', effort: 'high' });
    expect(savedChatLaunch('chat', null, undefined)).toEqual({});
    expect(savedChatLaunch('agent', live, undefined)).toEqual({});
  });

  it('a Super child the relaunch held parked keeps its launch on save (an empty parked never erases it)', () => {
    const launch = { model: 'sonnet', effort: 'medium', account: 'work-acct' };
    // The hydrate gives it `parked: { at, transport }` with no settings beside the roster's launch.
    expect(savedChatLaunch('chat', null, dormantLaunch({}, launch))).toEqual(launch);
    // A tab parked under load carries its own settings, and they win.
    expect(dormantLaunch({ model: 'opus', effort: 'high' }, launch)).toEqual({ model: 'opus', effort: 'high', account: 'work-acct' });
    expect(dormantLaunch({ effort: 'low' }, undefined)).toEqual({ effort: 'low' });
    expect(dormantLaunch(undefined, launch)).toEqual(launch);
  });
});

describe('resumePlan (client): how Resume reopens a dormant tab, and what `super resume` reports', () => {
  const launch = { model: 'sonnet', effort: 'medium', account: 'work-acct' };

  it('a chat saved in a mode comes back as that chat, on the roster settings', () => {
    expect(resumePlan({ kind: 'chat', mode: 'develop', launch }, 'agent')).toEqual({ asChat: true, spawnKind: 'chat', launch });
  });

  it('a relaunch-parked chat child (empty parked) comes back on its launch', () => {
    expect(resumePlan({ kind: 'chat', mode: 'plan', parked: { transport: 'chat' }, launch }, 'chat').launch).toEqual(launch);
  });

  it('a tab parked under load comes back on its own settings, as the transport it ran as', () => {
    expect(resumePlan({ kind: 'chat', mode: 'basic', parked: { transport: 'chat', effort: 'high' } }, 'agent')).toEqual({ asChat: true, spawnKind: 'chat', launch: { effort: 'high' } });
    expect(resumePlan({ kind: 'agent', parked: { transport: 'agent' }, launch }, 'chat')).toEqual({ asChat: false, spawnKind: 'agent', launch: {} });
  });

  it('a Super child held dormant under the Terminal screen and resumed under Chat keeps its settings', () => {
    expect(resumePlan({ kind: 'agent', launch }, 'chat')).toEqual({ asChat: false, spawnKind: 'chat', launch });
  });

  it('reopened as a terminal: no chat settings (the report then names none, and the record keeps its own)', () => {
    expect(resumePlan({ kind: 'agent', launch }, 'agent')).toEqual({ asChat: false, spawnKind: 'agent', launch: {} });
  });
});
