/**
 * The task strip on a member's stage (plan-r10 1c, mockup r8-08b; AC18): its owner buttons send the
 * same actions as the task's own job row, the owner's message carries `[About task <slug>]` while it
 * is up, and the role, round and who-it-waits-on lines are derived the way the job row derives them.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { memberTasks, roleIn, stripActions, stripRequest, stripRound, stripWait } from '../../dashboard/src/components/sleepy/super/memberStageModel';
import { aboutTaskHeader, withAboutTask } from '../../dashboard/src/components/sleepy/super/superHandover';
import { ABOUT_TASK_RE, aboutHeads } from '../../dashboard/src/lib/superTypes';
import { jobWaitKey } from '../../dashboard/src/lib/taskAgentJob';

const src = (p: string) => readFileSync(join(__dirname, '..', '..', p), 'utf-8');
const job = (o: Record<string, unknown> = {}) => ({
  state: null, step: null, round: 0, cap: 5, reviewer: null, workspace: null, repo: null, startAt: null, queuedAt: null,
  reviewPassed: false, claimedMachine: null, reason: null, ...o,
}) as never;

describe('the owner buttons, when they apply', () => {
  it('delivered: Onayla and Geri gönder', () => {
    expect(stripActions(job({ state: 'delivered' }), { closed: false, readOnly: false })).toEqual(['complete', 'send-back']);
  });
  it('stuck at the cap: Bir tur daha, Ben alırım, İptal', () => {
    expect(stripActions(job({ state: 'stuck' }), { closed: false, readOnly: false })).toEqual(['one-more-round', 'take-over', 'cancel']);
  });
  it('waiting on him, blocked, stopped or stalled: Ben alırım', () => {
    for (const state of ['waiting_owner', 'blocked', 'stopped', 'stalled']) {
      expect(stripActions(job({ state }), { closed: false, readOnly: false })).toEqual(['take-over']);
    }
  });
  it('while an agent works, on a closed task, or for a teammate\'s member: none', () => {
    expect(stripActions(job({ state: 'running', step: 'review' }), { closed: false, readOnly: false })).toEqual([]);
    expect(stripActions(job({ state: 'delivered' }), { closed: true, readOnly: false })).toEqual([]);
    expect(stripActions(job({ state: 'delivered' }), { closed: false, readOnly: true })).toEqual([]);
    expect(stripActions(null, { closed: false, readOnly: false })).toEqual([]);
  });
});

describe('a button sends the job row\'s own action body', () => {
  it('every button but Send back goes as is', () => {
    expect(stripRequest('t-1', 'complete')).toEqual({ slug: 't-1', action: 'complete' });
    expect(stripRequest('t-1', 'one-more-round')).toEqual({ slug: 't-1', action: 'one-more-round' });
    expect(stripRequest('t-1', 'take-over')).toEqual({ slug: 't-1', action: 'take-over' });
    expect(stripRequest('t-1', 'cancel')).toEqual({ slug: 't-1', action: 'cancel' });
  });
  it('Send back waits for his words, trimmed', () => {
    expect(stripRequest('t-1', 'send-back')).toBeNull();
    expect(stripRequest('t-1', 'send-back', '   ')).toBeNull();
    expect(stripRequest('t-1', 'send-back', '  KDV eksik  ')).toEqual({ slug: 't-1', action: 'send-back', text: 'KDV eksik' });
  });
  it('the strip posts through the same hook the job row uses', () => {
    const strip = src('dashboard/src/components/sleepy/super/TaskStrip.tsx');
    expect(strip).toMatch(/useTaskAgentAction\(\)/);
    expect(strip).toMatch(/const body = stripRequest\(task\.slug, a,/);
    expect(strip).toMatch(/act\.mutate\(body,/);
    expect(strip).toContain('data-testid="super-task-strip"');
    expect(strip).toContain('data-task={task.slug}');
  });
  it('another task gets a fresh strip: an open Send back never carries over to it', () => {
    expect(src('dashboard/src/components/sleepy/super/SuperSurface.tsx')).toMatch(/<TaskStrip key=\{member\.task\} task=\{member\.task\}/);
  });
});

describe('role, round and who it waits on', () => {
  it('the member is the doer, else the reviewer', () => {
    expect(roleIn({ agent: 'rota', agent_job: job({ reviewer: 'gantt' }) }, 'rota')).toBe('doer');
    expect(roleIn({ agent: 'rota', agent_job: job({ reviewer: 'gantt' }) }, 'gantt')).toBe('reviewer');
    expect(roleIn({ agent: 'rota', agent_job: job({ reviewer: 'gantt' }) }, 'scout')).toBeNull();
  });
  it('round N/cap is the round in play (a rework\'s next one), none before a delivery', () => {
    expect(stripRound(job({ round: 2, cap: 5, step: 'review' }))).toEqual({ n: 2, cap: 5 });
    expect(stripRound(job({ round: 2, cap: 5, step: 'rework' }))).toEqual({ n: 3, cap: 5 });
    expect(stripRound(job({ round: 0, cap: 5 }))).toBeNull();
    expect(stripRound(null)).toBeNull();
  });
  it('waits-on is the job row\'s own derivation, nothing on a closed task', () => {
    for (const j of [job({ state: 'running', step: 'review' }), job({ state: 'queued', step: 'work' }), job({ state: 'delivered' }), job({ state: 'stuck' })]) {
      expect(stripWait(j, false)).toBe(jobWaitKey(j));
    }
    expect(stripWait(job({ state: 'running', step: 'review' }), false)).toBe('reviewer');
    expect(stripWait(job({ state: 'delivered' }), false)).toBe('owner');
    expect(stripWait(job({ state: 'stuck' }), false)).toBe('stuck');
    expect(stripWait(job({ state: 'running', step: 'work' }), false)).toBe('doer');
    expect(stripWait(job({ state: 'delivered' }), true)).toBeNull();
  });
  it('every waits-on key has its words', () => {
    const i18n = src('dashboard/src/context/I18nContext.tsx');
    for (const k of ['reviewer', 'owner', 'stuck', 'doer']) {
      expect(i18n.match(new RegExp(`'superStage\\.task\\.waitsOn\\.${k}'`, 'g'))?.length).toBe(2);
    }
    expect(i18n).toContain("'superStage.task.waitsOn.reviewer': 'İnceleyici çalışıyor · senden bir şey beklemiyor'");
  });
});

describe('"Görevleri": the member\'s tasks, open first', () => {
  it('doer and reviewer tasks, open before closed, newest first', () => {
    const t = (slug: string, o: Record<string, unknown>) => ({ slug, agent: null, agent_job: null, status: 'todo', updated_at: '2026-11-01', ...o }) as never;
    const rows = memberTasks([
      t('done-one', { agent: 'rota', status: 'completed', updated_at: '2026-11-03' }),
      t('old-open', { agent: 'rota', updated_at: '2026-10-01' }),
      t('reviewing', { agent: 'gantt', agent_job: job({ reviewer: 'rota' }), updated_at: '2026-11-02' }),
      t('not-mine', { agent: 'gantt' }),
    ], 'rota', (s) => s === 'completed');
    expect(rows.map((r) => [r.task.slug, r.role, r.open])).toEqual([
      ['reviewing', 'reviewer', true],
      ['old-open', 'doer', true],
      ['done-one', 'doer', false],
    ]);
  });
});

describe('[About task <slug>] rides on the owner\'s message while the strip is up', () => {
  const long = `a${'-b'.repeat(50)}`; // 101 characters: no 64 cap
  it('the header uses the task-slug charset with no 64 cap', () => {
    expect(aboutTaskHeader('yillik-plan-fiyati')).toBe('[About task yillik-plan-fiyati]');
    expect(aboutTaskHeader(long)).toBe(`[About task ${long}]`);
    expect(ABOUT_TASK_RE.test(aboutTaskHeader(long))).toBe(true);
    expect(aboutTaskHeader('Bad Slug')).toBe('');
    expect(aboutTaskHeader('../x')).toBe('');
    expect(aboutTaskHeader(null)).toBe('');
  });
  it('the message gets it first, as its own part, and the server reads it as a task head', () => {
    const out = withAboutTask('Bu görevde inceleyici ne dedi?', 'yillik-plan-fiyati');
    expect(out).toBe('[About task yillik-plan-fiyati]\n\nBu görevde inceleyici ne dedi?');
    expect(aboutHeads(out)).toEqual([expect.objectContaining({ kind: 'task', id: 'yillik-plan-fiyati', at: 0 })]);
  });
  it('never twice, never on an empty message, never without a task', () => {
    const once = withAboutTask('soru', 'x-1');
    expect(withAboutTask(once, 'x-1')).toBe(once);
    expect(withAboutTask('  ', 'x-1')).toBe('  ');
    expect(withAboutTask('soru', null)).toBe('soru');
  });
  it('the chat applies it at the send and at a steer; the stage sets it only on the member\'s chat', () => {
    const chat = src('dashboard/src/components/sleepy/chatSession.ts');
    expect(chat).toMatch(/return writeUser\(withAbout\(text\), \{ steered: false, own: own \?\? typedOwnFor\(text\) \}\);/);
    expect(chat).toMatch(/return writeUser\(withAbout\(text\), \{ steered: true, own: own \?\? typedOwnFor\(text\) \}\);/);
    const surface = src('dashboard/src/components/sleepy/AgentSurface.tsx');
    expect(surface).toMatch(/chatAgentFor\(cs\.claudeId\) !== memberOf\(activeSuperId\)\) return undefined;/);
    expect(surface).toMatch(/cs\.setAboutHeader\?\.\(\(text\) => withAboutTask\(text, memberTaskRef\.current\)\);/);
  });
});
