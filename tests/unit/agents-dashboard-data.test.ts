/**
 * Wave 4a, lane T6: the dashboard's agent data and its two "go there" requests, driven directly
 * (no React, no DOM). The hooks are thin `useQuery`/`useMutation` wrappers; what is tested here
 * is everything they hand a caller that is NOT react-query's: the typed assignment refusal, the
 * roster helpers, the photo URL, and the two window-to-instance bridges (`requestOpenAgents`,
 * `requestTalkToAgent`) the four W4b lanes call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../dashboard/src/context/VaultContext', () => ({ useApi: () => null }));

import { RequestError, agentPhotoUrl } from '../../dashboard/src/api/client';
import { AssignAgentError, toAssignAgentError } from '../../dashboard/src/hooks/useTasks';
import { chatReadyAgents, findAgent, type AgentSummary } from '../../dashboard/src/hooks/useAgents';
import type { AutomationDraft } from '../../dashboard/src/hooks/useAutomations';
import {
  OPEN_AGENTS_EVENT, readOpenAgentsDetail, requestOpenAgents, type OpenAgentsDetail,
} from '../../dashboard/src/lib/openAgents';
import {
  TALK_ATTEMPTS, TALK_TO_AGENT_EVENT, TALK_TO_AGENT_REQUEST_EVENT, forwardTalkToAgent,
  requestTalkToAgent, type TalkToAgentDetail,
} from '../../dashboard/src/lib/talkToAgent';

function agent(slug: string, over: Partial<AgentSummary> = {}): AgentSummary {
  return {
    slug,
    title: slug,
    hasPhoto: false,
    description: '',
    model: null,
    effort: null,
    whiteboard: null,
    shared: false,
    approvedForChat: true,
    approvedToRun: true,
    approvalReason: null,
    implicit: false,
    hasCallSettings: false,
    usedBy: { automations: [], boards: [], tasks: [] },
    ...over,
  };
}

/** A stand-in `window`: an EventTarget with the timer the helpers use. */
function stubWindow(): EventTarget & { setTimeout: typeof setTimeout } {
  const w = Object.assign(new EventTarget(), { setTimeout: ((fn: () => void, ms: number) => setTimeout(fn, ms)) as typeof setTimeout });
  vi.stubGlobal('window', w);
  return w;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('assign to agent: the refusal reaches the caller TYPED (T7)', () => {
  it('maps the 409 agent_not_approved_to_run to its own code, keeping status and message', () => {
    const err = toAssignAgentError(new RequestError('Approve it on the AI Team page.', 409, 'agent_not_approved_to_run'));
    expect(err).toBeInstanceOf(AssignAgentError);
    expect(err.code).toBe('agent_not_approved_to_run');
    expect(err.status).toBe(409);
    expect(err.message).toBe('Approve it on the AI Team page.');
  });

  it('keeps every refusal the route answers with', () => {
    for (const code of ['agent_disabled', 'agent_busy', 'unknown_task', 'unknown_agent', 'note_too_long', 'missing_agent'] as const) {
      expect(toAssignAgentError(new RequestError('x', 409, code)).code).toBe(code);
    }
  });

  it('reads anything else as unknown, never as a refusal it did not see', () => {
    expect(toAssignAgentError(new RequestError('Bad gateway', 502, '')).code).toBe('unknown');
    expect(toAssignAgentError(new RequestError('x', 409, 'agent_unapproved')).code).toBe('unknown');
    const network = toAssignAgentError(new TypeError('Failed to fetch'));
    expect(network.code).toBe('unknown');
    expect(network.status).toBe(0);
    expect(toAssignAgentError(null).message).toBeTruthy();
  });

  it('passes an already-typed error through unchanged', () => {
    const typed = new AssignAgentError('m', 'agent_busy', 409);
    expect(toAssignAgentError(typed)).toBe(typed);
  });
});

describe('roster helpers', () => {
  it('a picker offers only agents approved for chat', () => {
    const list = [agent('a'), agent('b', { approvedForChat: false, approvedToRun: false }), agent('c', { approvedToRun: false })];
    expect(chatReadyAgents(list).map((a) => a.slug)).toEqual(['a', 'c']);
    expect(chatReadyAgents(undefined)).toEqual([]);
  });

  it('finds one agent by slug, or null', () => {
    const list = [agent('a'), agent('b')];
    expect(findAgent(list, 'b')?.slug).toBe('b');
    expect(findAgent(list, 'z')).toBeNull();
    expect(findAgent(list, null)).toBeNull();
    expect(findAgent(undefined, 'a')).toBeNull();
  });
});

describe('agentPhotoUrl', () => {
  it('reads the AGENTS route, with the vault and the cache buster in the query', () => {
    expect(agentPhotoUrl('Kitap Ağacı', 'researcher', 3)).toBe('/api/agents/researcher/photo?vault=Kitap+A%C4%9Fac%C4%B1&v=3');
    expect(agentPhotoUrl(null, 'researcher')).toBe('/api/agents/researcher/photo');
  });
});

describe('AutomationDraft', () => {
  it('a bound draft needs no prompt, and an own-agent draft still carries one', () => {
    const bound: AutomationDraft = { title: 'Daily digest', agent: 'researcher', job: 'Post a digest.', mode: 'sched' };
    const legacy: AutomationDraft = { title: 'Old', prompt: 'Do it.', mode: 'call', model: null, effort: null };
    expect(bound.agent).toBe('researcher');
    expect(legacy.prompt).toBe('Do it.');
  });
});

describe('requestOpenAgents', () => {
  it('normalises the request: a valid slug and create:true survive, anything else is dropped', () => {
    expect(readOpenAgentsDetail({ slug: 'daily-brief' })).toEqual({ slug: 'daily-brief' });
    expect(readOpenAgentsDetail({ create: true })).toEqual({ create: true });
    expect(readOpenAgentsDetail({ slug: 'Bad Slug', create: 'yes' })).toEqual({});
    expect(readOpenAgentsDetail({ slug: '../x' })).toEqual({});
    expect(readOpenAgentsDetail({ slug: 'a--b' })).toEqual({});
    expect(readOpenAgentsDetail(null)).toEqual({});
    expect(readOpenAgentsDetail('researcher')).toEqual({});
  });

  it('rings the window with the focus minus the nonce', () => {
    const w = stubWindow();
    const heard: OpenAgentsDetail[] = [];
    w.addEventListener(OPEN_AGENTS_EVENT, (e) => heard.push((e as CustomEvent<OpenAgentsDetail>).detail));
    requestOpenAgents({ slug: 'researcher' });
    requestOpenAgents({ create: true });
    expect(heard).toEqual([{ slug: 'researcher' }, { create: true }]);
    expect(heard.every((d) => !('nonce' in d))).toBe(true);
  });
});

describe('requestTalkToAgent: window, then the active instance\'s bus', () => {
  let w: ReturnType<typeof stubWindow>;
  let bus: EventTarget;
  beforeEach(() => {
    w = stubWindow();
    bus = new EventTarget();
  });

  /** What `ProjectInstance`'s TalkToAgentBridge does in the active instance. */
  function mountBridge(): () => void {
    const listener = (e: Event) => forwardTalkToAgent(bus, (e as CustomEvent<unknown>).detail);
    w.addEventListener(TALK_TO_AGENT_REQUEST_EVENT, listener);
    return () => w.removeEventListener(TALK_TO_AGENT_REQUEST_EVENT, listener);
  }

  it('resolves true once the surface on the bus ACKs, and the surface hears the slug', async () => {
    mountBridge();
    const heard: string[] = [];
    bus.addEventListener(TALK_TO_AGENT_EVENT, (e) => {
      const d = (e as CustomEvent<TalkToAgentDetail>).detail;
      heard.push(d.slug);
      d.accepted = true;
    });
    await expect(requestTalkToAgent('researcher')).resolves.toBe(true);
    expect(heard).toEqual(['researcher']);
  });

  it('keeps asking while the surface is not subscribed yet, then lands', async () => {
    vi.useFakeTimers();
    mountBridge();
    const pending = requestTalkToAgent('researcher');
    await vi.advanceTimersByTimeAsync(300);
    bus.addEventListener(TALK_TO_AGENT_EVENT, (e) => { (e as CustomEvent<TalkToAgentDetail>).detail.accepted = true; });
    await vi.advanceTimersByTimeAsync(300);
    await expect(pending).resolves.toBe(true);
  });

  it('resolves false when nothing takes it within the bound (no surface, Chat off)', async () => {
    vi.useFakeTimers();
    mountBridge();
    let asks = 0;
    bus.addEventListener(TALK_TO_AGENT_EVENT, () => { asks += 1; });
    const pending = requestTalkToAgent('researcher');
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toBe(false);
    expect(asks).toBe(TALK_ATTEMPTS);
  });

  it('refuses an invalid slug without ringing anything', async () => {
    let rung = 0;
    w.addEventListener(TALK_TO_AGENT_REQUEST_EVENT, () => { rung += 1; });
    await expect(requestTalkToAgent('Not A Slug')).resolves.toBe(false);
    await expect(requestTalkToAgent('')).resolves.toBe(false);
    expect(rung).toBe(0);
  });

  it('the forwarder ignores a malformed or already-taken request', () => {
    let heard = 0;
    bus.addEventListener(TALK_TO_AGENT_EVENT, () => { heard += 1; });
    forwardTalkToAgent(bus, null);
    forwardTalkToAgent(bus, { slug: 'Bad Slug', accepted: false });
    // Taken already: a second mounted instance must not start a second chat.
    forwardTalkToAgent(bus, { slug: 'researcher', accepted: true });
    expect(heard).toBe(0);
  });
});
