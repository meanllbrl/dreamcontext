/**
 * Where a member's past work is delivered, and where it is not (plan uye-gecmis-is C5, D8, D10,
 * D13; criteria 4, 6, 7, 8): the hook's block on a member CHAT turn only, once per context, the
 * run prompt's block beside the history block, the budget share, and the history label of a
 * Super relay row. Fictional names only; a fake HOME.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pastWorkForTurn } from '../../src/cli/commands/hook.js';
import { fitPromptContext, markShownBlocks, markSessionWork, resetSessionOnce, sessionWork, type PromptBlock } from '../../src/lib/hook-delivery.js';
import { localIndex, type Selection } from '../../src/lib/agents/work-index.js';
import { traceId, writeTrace, type WorkTrace } from '../../src/lib/agents/work-trace.js';
import { projectKey } from '../../src/lib/local-store.js';
import { composePrompt, runPastWork } from '../../src/lib/automations/runner.js';
import { createAgent } from '../../src/lib/agents/store.js';
import { createAutomation } from '../../src/lib/automations/store.js';
import { appendThreadEntry } from '../../src/lib/automations/threads.js';
import { buildRecentHistoryBlock } from '../../src/lib/automations/history.js';
import type { AutomationManifest } from '../../src/lib/automations/types.js';
import { HOOK_OUTPUT_MAX_CHARS } from '../../src/lib/snapshot-budget.js';
import { makeMachine, globalMember, type Machine } from '../helpers/work-trace-fixtures.js';

let m: Machine;
beforeEach(() => { m = makeMachine(); globalMember(m, 'mira'); });
afterEach(() => m.dispose());

const ctx = (p = 'kestrel') => join(m.project(p), '_dream_context');
const chatEnv = (slug = 'mira'): NodeJS.ProcessEnv => ({ DREAMCONTEXT_AGENT_CHAT: slug, DREAMCONTEXT_DASHBOARD_PORT: '1' });
const trace = (key: string, ask: string, at = '2026-11-20T10:00:00.000Z', project = 'lumen'): WorkTrace => ({
  v: 1, id: traceId(key), key, kind: 'job', at,
  project: { key: projectKey(m.project(project)), name: project, root: m.project(project) },
  asks: [{ by: 'owner', text: ask }], did: 'one tap upsell added with the saved card line', files: ['/p/lumen/upsell.tsx'], status: 'ok', through: 1, transcript: key.split(':')[0],
});

/** The server's select, answered by an index built from the files (what the warm index holds). */
const selectFromFiles = (calls: unknown[] = []) => async (body: { member: string; root: string; query: string; audience: 'owner' | 'app'; app?: string | null; exclude?: { ids?: readonly string[]; conversation?: string | null; since?: number | null } }): Promise<Selection> => {
  calls.push(body);
  const hit = localIndex(body.member, body.root, m.home)!;
  return hit.idx.select({ query: body.query, audience: body.audience, app: body.app ?? null, exclude: body.exclude }, { projectKey: projectKey(body.root), scope: hit.scope });
};

describe('the hook block on a member chat turn (D8)', () => {
  it('a global member in project B gets its project A job, fenced as a record', async () => {
    await writeTrace({ slug: 'mira', projectRoot: m.project('lumen'), home: m.home }, trace('s1:a', 'one tap upsell with the saved card line'));
    const pw = await pastWorkForTurn(ctx('kestrel'), 'add the one tap upsell like we did', { session_id: 'sess-k' }, { env: chatEnv(), home: m.home, select: selectFromFiles() });
    expect(pw?.text).toContain('YOUR PAST WORK');
    expect(pw?.text).toContain(`[w_${traceId('s1:a').slice(0, 8)}]`);
    expect(pw?.ids).toEqual([traceId('s1:a')]);
  });

  it('nothing outside a member chat: no member, an app chat, a run, a crew child; nothing on a pure event batch', async () => {
    await writeTrace({ slug: 'mira', projectRoot: m.project('lumen'), home: m.home }, trace('s1:a', 'one tap upsell with the saved card line'));
    const calls: unknown[] = [];
    const ask = (env: NodeJS.ProcessEnv, prompt = 'add the one tap upsell') => pastWorkForTurn(ctx('kestrel'), prompt, { session_id: 's' }, { env, home: m.home, select: selectFromFiles(calls) });
    expect(await ask({})).toBeNull();
    expect(await ask({ DREAMCONTEXT_AGENT_CHAT: 'app-funnel-desk' })).toBeNull();
    expect(await ask({ ...chatEnv(), DREAMCONTEXT_AUTOMATION_SLUG: 'mira-digest', DREAMCONTEXT_AUTOMATION_RUN: '2026-11-20T09:00:00Z' })).toBeNull();
    expect(await ask({ ...chatEnv(), DREAMCONTEXT_RUN_MEMBER: 'mira' })).toBeNull();
    expect(await ask({ ...chatEnv(), DREAMCONTEXT_MEMBER_CREW: 'mira' })).toBeNull();
    expect(await ask(chatEnv('oren'))).toBeNull();
    expect(await ask(chatEnv(), '[super events] batch=b items=1\n- item=n1 event=nudge request=q1\nStill open.')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('with no work folder the server is never asked (byte-identical output, no latency)', async () => {
    const calls: unknown[] = [];
    expect(await pastWorkForTurn(ctx('kestrel'), 'add the one tap upsell', { session_id: 's' }, { env: chatEnv(), home: m.home, select: selectFromFiles(calls) })).toBeNull();
    expect(calls).toHaveLength(0);
    expect(existsSync(join(m.home, '.dreamcontext', 'agents', 'mira', 'work'))).toBe(false);
  });

  it('a down or late server is no block', async () => {
    await writeTrace({ slug: 'mira', projectRoot: m.project('lumen'), home: m.home }, trace('s1:a', 'one tap upsell with the saved card line'));
    expect(await pastWorkForTurn(ctx('kestrel'), 'add the one tap upsell', { session_id: 's' }, { env: chatEnv(), home: m.home, select: async () => null })).toBeNull();
    // The real client against a port nobody listens on.
    expect(await pastWorkForTurn(ctx('kestrel'), 'add the one tap upsell', { session_id: 's' }, { env: chatEnv(), home: m.home })).toBeNull();
  });
});

describe('once per context (D10, criterion 6)', () => {
  it('not again next turn; again after a reset; a new trace written meanwhile arrives', async () => {
    const t = { slug: 'mira', projectRoot: m.project('lumen'), home: m.home };
    await writeTrace(t, trace('s1:a', 'one tap upsell with the saved card line'));
    const sid = 'sess-once';
    resetSessionOnce(sid, m.home, Date.parse('2026-11-21T00:00:00Z'));
    const turn = async (prompt: string) => {
      const pw = await pastWorkForTurn(ctx('kestrel'), prompt, { session_id: sid }, { env: chatEnv(), home: m.home, select: selectFromFiles() });
      if (pw) markSessionWork(sid, pw.ids, m.home);
      return pw;
    };
    expect((await turn('the one tap upsell again'))?.ids).toEqual([traceId('s1:a')]);
    expect(await turn('the one tap upsell again please')).toBeNull();
    // Another conversation (or a run) writes a matching trace after this chat opened.
    await writeTrace(t, trace('s2:b', 'one tap upsell on the second paywall', '2026-11-21T12:00:00.000Z'));
    expect((await turn('the one tap upsell on the paywall'))?.ids).toEqual([traceId('s2:b')]);
    // /clear or a compaction: the context lost what it was shown.
    resetSessionOnce(sid, m.home);
    expect((await turn('the one tap upsell again'))?.ids.sort()).toEqual([traceId('s1:a'), traceId('s2:b')].sort());
  });

  it('this conversation\'s own job opened since its reset is held back; an older one of it arrives after a /clear', async () => {
    const t = { slug: 'mira', projectRoot: m.project('kestrel'), home: m.home };
    await writeTrace(t, trace('sess-own:a', 'one tap upsell with the saved card line', '2026-11-21T10:00:00.000Z', 'kestrel'));
    resetSessionOnce('sess-own', m.home, Date.parse('2026-11-21T09:00:00Z'), { memberChat: true });
    expect(sessionWork('sess-own', m.home).since).toBe(Date.parse('2026-11-21T09:00:00Z'));
    const ask = () => pastWorkForTurn(ctx('kestrel'), 'the one tap upsell again', { session_id: 'sess-own' }, { env: chatEnv(), home: m.home, select: selectFromFiles() });
    expect(await ask()).toBeNull();
    resetSessionOnce('sess-own', m.home, Date.parse('2026-11-21T11:00:00Z'));
    expect((await ask())?.ids).toEqual([traceId('sess-own:a')]);
  });

  it('a machine that never delivered anything keeps no marker', () => {
    resetSessionOnce('sess-none', m.home);
    expect(existsSync(join(m.home, '.dreamcontext', 'prompt-seen'))).toBe(false);
  });
});

describe('the budget share (C5, criterion 7)', () => {
  it('the past-work block goes before the recall block is cut', () => {
    const recall: PromptBlock = { kind: 'recall', text: `— Memory recall\n${'r'.repeat(HOOK_OUTPUT_MAX_CHARS - 2_000)}` };
    const pastwork: PromptBlock = { kind: 'pastwork', text: `--- YOUR PAST WORK\n${'p'.repeat(2_400)}` };
    const fitted = fitPromptContext([{ kind: 'must', text: 'rule' }, recall, pastwork, { kind: 'gate', text: 'gate' }]);
    expect(fitted.text).toContain(recall.text);
    expect(fitted.text).not.toContain('YOUR PAST WORK');
    const small = fitPromptContext([{ kind: 'must', text: 'rule' }, { kind: 'recall', text: 'hit' }, { kind: 'pastwork', text: 'pw' }]);
    expect(small.text).toBe('rule\nhit\npw');
  });

  it('a past-work block the fit dropped is never marked shown (it arrives on a later turn)', () => {
    let shown = 0;
    const recall: PromptBlock = { kind: 'recall', text: `— Memory recall\n${'r'.repeat(HOOK_OUTPUT_MAX_CHARS - 2_000)}` };
    const big: PromptBlock[] = [{ kind: 'must', text: 'rule' }, recall, { kind: 'pastwork', text: `--- YOUR PAST WORK\n${'p'.repeat(2_400)}`, onShown: () => { shown++; } }];
    markShownBlocks(big, fitPromptContext(big));
    expect(shown).toBe(0);
    const small: PromptBlock[] = [{ kind: 'must', text: 'rule' }, { kind: 'pastwork', text: '--- YOUR PAST WORK\nline', onShown: () => { shown++; } }];
    markShownBlocks(small, fitPromptContext(small));
    expect(shown).toBe(1);
  });
});

// ─── The run prompt (D8, criterion 4, 7) ────────────────────────────

describe('the run prompt', () => {
  let projectRoot: string;
  let contextRoot: string;
  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dc-pw-run-'));
    contextRoot = join(projectRoot, '_dream_context');
    mkdirSync(join(contextRoot, 'automations'), { recursive: true });
    createAgent(contextRoot, { slug: 'scout', title: 'Scout', prompt: 'Scout the fictional market.' });
    createAutomation(contextRoot, { slug: 'morning-scan', title: 'Morning scan', agent: 'scout', days: 'daily', at: '08:00' });
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));
  const NOW = new Date('2026-11-20T12:00:00.000Z');
  const manifest = (): AutomationManifest => ({
    slug: 'scout', id: 'agt_1', title: 'Scout', mode: 'call', enabled: true, schedule: null, scheduleError: null,
    model: null, effort: null, timeoutMinutes: 15, catchupHours: 6, outputDir: null, shared: false, notify: true,
    learning: true, review: 'off', flow: null, whiteboard: null,
    pattern: '', prompt: 'Scout the fictional market.', outputInstructions: '',
    job: '', soul: '', runKind: 'agent', agent: 'scout', agentTitle: 'Scout', bindings: [], legacyKey: false,
    path: join(contextRoot, 'agents', 'scout.md'), body: '',
  } as unknown as AutomationManifest);

  it('carries exactly one past-work block when given, and is byte-identical without one', () => {
    const bare = composePrompt(manifest(), projectRoot, NOW, '/o.md', undefined, 'Compare the pricing pages.', null, null);
    expect(composePrompt(manifest(), projectRoot, NOW, '/o.md', undefined, 'Compare the pricing pages.', null, null, undefined, undefined, null, false, null, '')).toBe(bare);
    const block = '--- YOUR PAST WORK (x) n1 ---\nline\n--- END PAST WORK n1 ---';
    const p = composePrompt(manifest(), projectRoot, NOW, '/o.md', undefined, 'Compare the pricing pages.', null, null, undefined, undefined, null, false, null, block);
    expect(p.split('--- YOUR PAST WORK').length - 1).toBe(1);
    expect(p.indexOf('YOUR PAST WORK')).toBeLessThan(p.indexOf('Compare the pricing pages.'));
  });

  it('runPastWork asks nothing for a member with no work folder, and is empty on a down server', async () => {
    expect(await runPastWork('mira', m.project('kestrel'), 'compare pricing', null, m.home)).toBe('');
    await writeTrace({ slug: 'mira', projectRoot: m.project('kestrel'), home: m.home }, trace('s1:a', 'compare pricing', undefined, 'kestrel'));
    const prev = process.env.DREAMCONTEXT_DASHBOARD_PORT;
    process.env.DREAMCONTEXT_DASHBOARD_PORT = '1';
    try { expect(await runPastWork('mira', m.project('kestrel'), 'compare pricing', null, m.home)).toBe(''); } finally {
      if (prev === undefined) delete process.env.DREAMCONTEXT_DASHBOARD_PORT; else process.env.DREAMCONTEXT_DASHBOARD_PORT = prev;
    }
  });

  it('the history block labels a Super relay row the Super Agent; the owner\'s stays the owner (D13)', () => {
    const at = (min: number) => new Date(NOW.getTime() - 3_600_000 + min * 60_000);
    appendThreadEntry(contextRoot, 'scout', { runId: 'r1', kind: 'user', text: 'Compare the two pricing pages.', via: 'dashboard', now: at(1) });
    appendThreadEntry(contextRoot, 'scout', { runId: 'r2', kind: 'user', text: '[super events] batch=b items=1\n- item=q1 event=request from=super', via: 'dashboard', now: at(2) });
    appendThreadEntry(contextRoot, 'scout', { runId: 'r3', kind: 'user', text: '<super-owner-relay>he said so</super-owner-relay>', via: 'dashboard', now: at(3) });
    const lines = buildRecentHistoryBlock(contextRoot, 'scout', { nonce: 'n', now: NOW }).split('\n');
    expect(lines.find((l) => l.includes('Compare the two pricing'))).toMatch(/· the owner: /);
    expect(lines.find((l) => l.includes('[super events]'))).toMatch(/· the Super Agent: /);
    expect(lines.find((l) => l.includes('super-owner-relay') || l.includes('he said so'))).toMatch(/· the Super Agent: /);
  });
});
