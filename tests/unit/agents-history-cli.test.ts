/**
 * `agents history <slug> --search` finds a member's past-work traces too, `--all` spans every
 * project for a global member and is refused in an app's session, `history show <w_id>` prints
 * one whole (plan uye-gecmis-is D12; criteria 3, 5). Fictional names only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgent } from '../../src/lib/agents/store.js';
import { pastWorkViewer, searchPastWork, findTrace } from '../../src/lib/agents/history.js';
import { traceId, writeTrace, type WorkTrace } from '../../src/lib/agents/work-trace.js';
import { projectKey } from '../../src/lib/local-store.js';
import { createProgram } from '../../src/cli/program.js';

let projectRoot: string;
let contextRoot: string;
let home: string;
let realHome: string | undefined;
let cwd: string;
const saved: Record<string, string | undefined> = {};
const ENV = ['DREAMCONTEXT_AGENT_CHAT', 'DREAMCONTEXT_RUN_APP', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID', 'DREAMCONTEXT_DASHBOARD_PORT'];

beforeEach(() => {
  cwd = process.cwd();
  projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'dc-pastwork-')));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  home = realpathSync(mkdtempSync(join(tmpdir(), 'dc-pastwork-home-')));
  realHome = process.env.HOME;
  process.env.HOME = home;
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  // No server answers on this port: the CLI reads the files.
  process.env.DREAMCONTEXT_DASHBOARD_PORT = '1';
  createAgent(contextRoot, { slug: 'oren', title: 'Oren', prompt: 'oren measures the fictional fjord funnel.', learning: false }, { approve: { now: new Date('2026-11-20T00:00:00Z'), home } });
});
afterEach(() => {
  process.chdir(cwd);
  process.env.HOME = realHome;
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const trace = (key: string, ask: string): WorkTrace => ({
  v: 1, id: traceId(key), key, kind: 'job', at: '2026-11-20T10:00:00.000Z',
  project: { key: projectKey(projectRoot), name: 'fjord', root: projectRoot },
  asks: [{ by: 'owner', text: ask }], did: 'measured and posted', files: ['/p/fjord/report.md'], status: 'ok', through: 1, transcript: key.split(':')[0],
});

async function runCli(argv: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const spies = (['log', 'error', 'warn'] as const).map((k) => vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); }));
  process.exitCode = undefined;
  process.chdir(projectRoot);
  try { await createProgram().parseAsync(argv, { from: 'user' }); } finally { for (const s of spies) s.mockRestore(); }
  const code = process.exitCode ?? 0;
  process.exitCode = undefined;
  return { code, out: lines.join('\n') };
}

describe('agents history and past work', () => {
  it('--search prints the trace hits after the run and talk hits, read from the files with no server', async () => {
    await writeTrace({ slug: 'oren', projectRoot, home }, trace('s1:a', 'fjord funnel drop by step'));
    const r = await runCli(['agents', 'history', 'oren', '--search', 'fjord funnel drop']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Past work');
    expect(r.out).toContain(`[w_${traceId('s1:a').slice(0, 8)}]`);
    const json = JSON.parse((await runCli(['agents', 'history', 'oren', '--search', 'fjord funnel drop', '--json'])).out) as { traces: Array<{ id: string }> };
    expect(json.traces.map((t) => t.id)).toEqual([traceId('s1:a')]);
  });

  it('history show <w_id> prints one trace whole', async () => {
    await writeTrace({ slug: 'oren', projectRoot, home }, trace('s1:b', 'weekly fjord report'));
    const r = await runCli(['agents', 'history', 'show', `w_${traceId('s1:b').slice(0, 8)}`]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('weekly fjord report');
    expect(r.out).toContain('/p/fjord/report.md');
    expect(findTrace(contextRoot, 'w_zz', ['oren'], home)).toBeNull();
  });

  it('--all is refused in an app\'s session (G2)', async () => {
    process.env.DREAMCONTEXT_AGENT_CHAT = 'app-funnel-desk';
    const r = await runCli(['agents', 'history', 'oren', '--search', 'fjord', '--all']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('not open to an app');
  });

  it('a LIVE app run reads as its app: --all refused, the owner\'s jobs and show hidden (G2)', async () => {
    await writeTrace({ slug: 'oren', projectRoot, home }, trace('s3:a', 'fjord funnel drop by step'));
    process.env.DREAMCONTEXT_RUN_APP = 'funnel-desk';
    expect(pastWorkViewer(contextRoot)).toEqual({ app: 'funnel-desk' });
    const all = await runCli(['agents', 'history', 'oren', '--search', 'fjord', '--all']);
    expect(all.code).toBe(1);
    expect(all.out).toContain('not open to an app');
    const json = JSON.parse((await runCli(['agents', 'history', 'oren', '--search', 'fjord funnel drop', '--json'])).out) as { traces: unknown[] };
    expect(json.traces).toEqual([]);
    expect((await runCli(['agents', 'history', 'show', `w_${traceId('s3:a').slice(0, 8)}`])).code).toBe(1);
  });

  it('the viewer: an app chat is its app, anyone else the owner', () => {
    expect(pastWorkViewer(contextRoot, { DREAMCONTEXT_AGENT_CHAT: 'app-crm' })).toEqual({ app: 'crm' });
    expect(pastWorkViewer(contextRoot, { DREAMCONTEXT_AGENT_CHAT: 'oren' })).toBeNull();
    expect(pastWorkViewer(contextRoot, {})).toBeNull();
  });

  it('searchPastWork with and without a server finds every match (no cap)', async () => {
    for (let i = 0; i < 120; i++) await writeTrace({ slug: 'oren', projectRoot, home }, trace(`s2:${i}`, `fjord cohort retention table variant${i}`));
    const hits = await searchPastWork(contextRoot, 'oren', 'fjord cohort retention table', { home, viaServer: false });
    expect(hits).toHaveLength(120);
  });
});
