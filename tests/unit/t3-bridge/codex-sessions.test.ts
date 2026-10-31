import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearCodexSessionCache, listCodexSessions, mergeSessionRows, tabsByThread } from '../../../src/lib/t3-bridge/codex-sessions.js';
import { linkedWritableRoots, worktreesIn } from '../../../src/lib/t3-bridge/roots.js';
import { computeChatSessions } from '../../../src/server/routes/agent-chat-sessions.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const TAB = '33333333-3333-4333-8333-333333333333';

let base = '';
let home = '';
let proj = '';
let other = '';

function thread(id: string, cwd: string, said: string[], branch = 'main'): void {
  const dir = join(home, '.codex', 'sessions', '2026', '10', '31');
  mkdirSync(dir, { recursive: true });
  const line = (type: string, payload: unknown) => JSON.stringify({ timestamp: '2026-10-31T10:00:00.000Z', type, payload });
  writeFileSync(join(dir, `rollout-2026-10-31T10-00-00-${id}.jsonl`), [
    line('session_meta', { id, cwd, git: { branch } }),
    line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] }),
    ...said.map((t) => line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: t }] })),
    line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }),
  ].join('\n') + '\n');
}

beforeEach(() => {
  clearCodexSessionCache();
  base = realpathSync(mkdtempSync(join(tmpdir(), 'dc-codex-sessions-')));
  home = join(base, 'home');
  proj = join(base, 'proj');
  other = join(base, 'other');
  for (const d of [home, join(proj, '_dream_context', 'state'), other]) mkdirSync(d, { recursive: true });
});
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

describe('Past chats lists a project\'s Codex threads', () => {
  it('lists only this project\'s threads, with the first thing the owner said', () => {
    thread(A, proj, ['fix the invoice export', 'and add a test'], 'feat/x');
    thread(B, other, ['someone else']);
    const rows = listCodexSessions(proj, { home });
    expect(rows.map((r) => r.id)).toEqual([A]);
    expect(rows[0]).toMatchObject({ title: 'fix the invoice export', preview: 'and add a test', tool: 'codex', gitBranch: 'feat/x', named: false, agentRun: false });
  });

  it('a thread nobody said anything in is not a chat', () => {
    thread(A, proj, []);
    expect(listCodexSessions(proj, { home })).toEqual([]);
  });

  it('a thread run in a tab keeps the tab\'s id and name, so it opens that tab', () => {
    thread(A, proj, ['hello']);
    const ctx = join(proj, '_dream_context');
    mkdirSync(join(ctx, 'state', '.agent-session-map'), { recursive: true });
    writeFileSync(join(ctx, 'state', '.agent-session-map', `${TAB}.json`), JSON.stringify({ current: A, updated: 'x' }));
    expect(tabsByThread(ctx).get(A)).toBe(TAB);
    const rows = listCodexSessions(proj, { home, contextRoot: ctx, titles: new Map([[TAB, 'Fatura işi']]) });
    expect(rows[0]).toMatchObject({ id: TAB, title: 'Fatura işi', named: true });
  });

  it('a query matches what the owner said, and says where', () => {
    thread(A, proj, ['fix the invoice export', 'now the pdf footer']);
    expect(listCodexSessions(proj, { home, query: 'INVOICE' })[0]).toMatchObject({ matchIn: 'title' });
    expect(listCodexSessions(proj, { home, query: 'pdf footer' })[0]).toMatchObject({ matchIn: 'prompt' });
    expect(listCodexSessions(proj, { home, query: 'nothing like this' })).toEqual([]);
  });

  it('merges by time, or by match rank on a query', () => {
    const c = { id: 'c', updatedAt: 5, matchIn: 'content' };
    const t = { id: 't', updatedAt: 1, matchIn: 'title' };
    expect(mergeSessionRows([c], [t], 10, false).map((r) => r.id)).toEqual(['c', 't']);
    expect(mergeSessionRows([c], [t], 10, true).map((r) => r.id)).toEqual(['t', 'c']);
    expect(mergeSessionRows([c], [t], 1, false).map((r) => r.id)).toEqual(['c']);
  });

  it('the route carries them beside Claude\'s, and never on the Super-only listing', async () => {
    thread(A, proj, ['from codex']);
    const ctx = join(proj, '_dream_context');
    const all = await computeChatSessions(ctx, {}, { home }) as { sessions: Array<{ id: string; tool?: string }>; total: number };
    expect(all.sessions.map((s) => [s.id, s.tool])).toEqual([[A, 'codex']]);
    expect(all.total).toBe(1);
    const only = await computeChatSessions(ctx, { super: 'only' }, { home }) as { sessions: unknown[] };
    expect(only.sessions).toEqual([]);
  });
});

describe('linked repos become writable roots', () => {
  it('reads a repo\'s worktrees from git\'s own list', () => {
    expect(worktreesIn('worktree /code/app\nHEAD abc\nbranch refs/heads/main\n\nworktree /wt/app-x\nHEAD def\n')).toEqual(['/code/app', '/wt/app-x']);
  });

  it('an unreadable project is no root at all, never a wider one', () => {
    expect(linkedWritableRoots(join(base, 'nowhere'), { home })).toEqual([]);
  });
});
