/**
 * AI Team polish (owner QA on 0.33.0, 2026-10-21): the pure pieces behind the fixes.
 *
 *  - The approval strip: what waits for approval on this Mac, in one list, ordered by what
 *    blocks the owner's next message (`pendingApprovals`, `talkBlocked`), said in one sentence.
 *  - A notification landing: which row of the conversation it brings into view (`focusTargetKey`).
 *  - A failed run says its error ONCE (no folded "report" repeating it).
 *  - The banner and the notch name the TEAMMATE, as the AI Team page does.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildConversation, buildRoster, focusTargetKey, pendingApprovals, talkBlocked,
  type TeamAgent, type TeamAutomation,
} from '../../dashboard/src/components/aiteam/teamModel';
import type { FeedMessage } from '../../dashboard/src/hooks/useAutomations';
import { bannerTitle } from '../../src/lib/automations/runner.js';
import { speakerTitle } from '../../src/server/assistant-inbox.js';

function agent(over: Partial<TeamAgent> = {}): TeamAgent {
  return {
    slug: 'sentinel', title: 'Sentinel', hasPhoto: false, roleLine: '', description: '', approvedForChat: true,
    approvedToRun: true, approvalReason: null, model: null, effort: null, ...over,
  };
}
function routine(slug: string, over: Partial<TeamAutomation> = {}): TeamAutomation {
  return {
    slug, title: `Routine ${slug}`, agent: 'sentinel', runKind: 'automation', mode: 'sched', enabled: true,
    approved: true, approvalReason: null, pendingQuestion: null, nextFireAt: null, cadenceLabel: 'daily 09:00', ...over,
  };
}
function msg(slug: string, runId: string, over: Partial<FeedMessage> = {}): FeedMessage {
  return {
    key: `${slug}::${runId}`, slug, title: slug, agent: 'sentinel', agentTitle: 'Sentinel', hasPhoto: false, runId,
    at: runId, status: 'done', durationMs: 1000, costUsd: null, ask: null, text: `post ${runId}`, textFrom: 'post',
    files: [], summary: null, question: null, needsYou: false, replyCount: 0, lastReplyAt: null, document: null,
    sessionRunId: null, sessionOpenable: false, unread: false, newestId: null, ...over,
  } as FeedMessage;
}

describe('pendingApprovals: what waits on this Mac', () => {
  it('nothing when everything is approved', () => {
    expect(pendingApprovals(agent(), [routine('sentinel-daily')])).toEqual([]);
  });

  it('a never-approved agent with no routine of its own slug: talking is blocked (say would 409)', () => {
    const p = pendingApprovals(agent({ approvedToRun: false, approvalReason: 'never-approved' }), [routine('sentinel-daily')]);
    expect(p).toEqual([{ kind: 'agent', slug: 'sentinel', title: 'Sentinel', blocksTalk: true, reason: 'never-approved' }]);
    expect(talkBlocked(p)).toBe(true);
  });

  it('a routine sharing the agent slug carries the conversation: the agent row then only blocks boards and tasks', () => {
    const p = pendingApprovals(agent({ approvedToRun: false }), [routine('sentinel')]);
    expect(p).toEqual([{ kind: 'agent', slug: 'sentinel', title: 'Sentinel', blocksTalk: false, reason: null }]);
    expect(talkBlocked(p)).toBe(false);
  });

  it('an unapproved routine is listed; it blocks talk only when it is the one say runs', () => {
    const changed = pendingApprovals(agent(), [routine('sentinel-daily', { approved: false, approvalReason: 'manifest-changed' })]);
    expect(changed).toEqual([{ kind: 'routine', slug: 'sentinel-daily', title: 'Routine sentinel-daily', blocksTalk: false, reason: 'manifest-changed' }]);
    expect(talkBlocked(changed)).toBe(false);
    expect(talkBlocked(pendingApprovals(agent(), [routine('sentinel', { approved: false })]))).toBe(true);
  });

  it('not approved for chat blocks talk whatever the routines say, and comes first', () => {
    const p = pendingApprovals(
      agent({ approvedForChat: false, approvedToRun: false }),
      [routine('sentinel-daily', { approved: false }), routine('sentinel')],
    );
    expect(p.map((x) => `${x.kind}:${x.blocksTalk}`)).toEqual(['agent:true', 'routine:false']);
  });

  it('the roster tags the same teammate "approval" the strip shows (one rule, not two)', () => {
    const rows = buildRoster([agent({ approvedToRun: false })], [routine('sentinel-daily')], null);
    expect(rows[0].status).toBe('approval');
    const ok = buildRoster([agent()], [routine('sentinel-daily')], null);
    expect(ok[0].status).toBe('idle');
  });
});

describe('focusTargetKey: where a notification lands', () => {
  const messages = [
    msg('sentinel-daily', '2026-10-19T09:00:00.000Z'),
    msg('sentinel', '2026-10-20T10:00:00.000Z', { ask: { text: 'hi', at: '2026-10-20T10:00:00.000Z' } as FeedMessage['ask'] }),
    msg('sentinel-daily', '2026-10-21T09:00:00.000Z'),
    msg('sentinel', '2026-10-21T11:00:00.000Z', { ask: { text: 'and?', at: '2026-10-21T11:00:00.000Z' } as FeedMessage['ask'] }),
  ];
  const items = buildConversation(messages);

  it("the routine's newest post, not the owner's later turn", () => {
    expect(focusTargetKey(items, 'sentinel-daily')).toBe('sentinel-daily::2026-10-21T09:00:00.000Z:post');
  });
  it('a slug with no message in the conversation lands nowhere (the reader stays at the end)', () => {
    expect(focusTargetKey(items, 'other')).toBeNull();
    // A prefix of another slug is not that slug.
    expect(focusTargetKey(items, 'sentinel-dai')).toBeNull();
  });
});

describe('a failed run says its error once', () => {
  it('no folded report repeating the error under the post', () => {
    const m = msg('sentinel', 'r1', { status: 'failed', textFrom: 'error', text: 'Not logged in' });
    const items = buildConversation([m], { [m.key]: { entries: [], answer: { text: 'Not logged in' } as never } });
    const post = items.find((i) => i.kind === 'agent');
    expect(post && post.kind === 'agent' ? [post.text, post.report, post.failed] : null).toEqual(['Not logged in', null, true]);
  });
});

describe('the teammate is named where a notification is read', () => {
  it('macOS banner: "<teammate> · <routine>" for a routine, its own title otherwise', () => {
    expect(bannerTitle({ title: 'Daily check', agentTitle: 'Sentinel' })).toBe('Sentinel · Daily check');
    expect(bannerTitle({ title: 'Sentinel', agentTitle: 'Sentinel' })).toBe('Sentinel');
    expect(bannerTitle({ title: 'Legacy job', agentTitle: '' })).toBe('Legacy job');
  });
  it('notch inbox: the same words', () => {
    expect(speakerTitle('Sentinel', 'Daily check')).toBe('Sentinel · Daily check');
    expect(speakerTitle('Sentinel', 'Sentinel')).toBe('Sentinel');
    expect(speakerTitle(undefined, 'Legacy job')).toBe('Legacy job');
  });
});

describe('the surfaces wire it (source scan; the behaviour is proven in the browser run)', () => {
  const page = readFileSync('dashboard/src/pages/AiTeamPage.tsx', 'utf8');
  const convo = readFileSync('dashboard/src/components/aiteam/TeamConversation.tsx', 'utf8');
  const strip = readFileSync('dashboard/src/components/aiteam/TeamApproval.tsx', 'utf8');
  it('a landing is spent once it lands, so coming back opens at the newest end', () => {
    expect(page).toMatch(/onFocusDone=\{\(\) => setLanding\(null\)\}/);
    expect(convo).toMatch(/setFlash\(focusKey\);\s*onFocusDone\?\.\(\);/);
    // The mark fades on its own effect, not the landing's cleanup (which the page clears at once).
    expect(convo).toMatch(/if \(!flash\) return;\s*const timer = setTimeout\(\(\) => setFlash\(null\), 2400\)/);
  });
  it('the strip sits above the conversation and Approve waits for a fresh read', () => {
    expect(convo).toMatch(/<TeamApproval agentTitle=\{agent\.title\} pending=\{pending\}/);
    expect(convo).toMatch(/const blocked = talkBlocked\(pending\)/);
    expect(strip).toMatch(/invalidateQueries\(\{ queryKey: item\.kind === 'agent' \? \['agents', item\.slug\] : \['automations', item\.slug\], exact: true \}\)/);
    expect(strip).toMatch(/const ready = !!review && !detail\.isFetching && detail\.isFetchedAfterMount;/);
  });
});
