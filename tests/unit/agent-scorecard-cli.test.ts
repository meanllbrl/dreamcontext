/**
 * `agents rate` and `agents scorecard …` (plan uye-karnesi C4, D16): the owner rates freely; an
 * agent session rates only with his words and may not set his lines, goal or lessons.
 *
 * Fictional project and agents only ("Acme", "herodot").
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const spawned = vi.hoisted(() => ({ jobs: [] as unknown[] }));
vi.mock('../../src/lib/agents/scorecard-judge.js', async (orig) => {
  const actual = await orig<typeof import('../../src/lib/agents/scorecard-judge.js')>();
  return { ...actual, spawnScorecardJob: (j: unknown) => { spawned.jobs.push(j); } };
});

import { createAgent } from '../../src/lib/agents/store.js';
import { createAutomation } from '../../src/lib/automations/store.js';
import { newThreadEntryId, threadSlugDir } from '../../src/lib/automations/threads.js';
import { THREAD_ENTRY_MARKER, type ThreadEntry } from '../../src/lib/automations/types.js';
import { readScorecard } from '../../src/lib/agents/scorecard.js';
import { createProgram } from '../../src/cli/program.js';

let projectRoot: string;
let contextRoot: string;
let home: string;
let cwd: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ['HOME', 'CLAUDE_CODE_SESSION_ID', 'DREAMCONTEXT_AGENT_TOOL', 'DREAMCONTEXT_TAB_SESSION', 'CODEX_THREAD_ID'];
const NOW = new Date('2026-11-20T12:00:00.000Z');

beforeEach(() => {
  cwd = process.cwd();
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'dc-sccli-')));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  home = realpathSync(mkdtempSync(join(tmpdir(), 'dc-sccli-home-')));
  process.env.HOME = home;
  spawned.jobs = [];
  createAgent(contextRoot, { slug: 'herodot', title: 'Herodot', prompt: 'Herodot summarises the fictional Acme channel.', learning: false }, { approve: { now: NOW, home } });
  createAutomation(contextRoot, { slug: 'daily-digest', title: 'Daily digest', agent: 'herodot', days: 'daily', at: '09:00' }, { approve: { now: NOW, home } });
});
afterEach(() => {
  process.chdir(cwd);
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

let seq = 0;
function put(e: Omit<ThreadEntry, 'id' | 'via'>): void {
  const dir = threadSlugDir(contextRoot, 'daily-digest');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${e.at.slice(0, 10)}-aaaaaaaaaaaa.md`);
  const prev = existsSync(path) ? readFileSync(path, 'utf-8') : '';
  writeFileSync(path, `${prev}${THREAD_ENTRY_MARKER}\n\`\`\`json\n${JSON.stringify({ ...e, id: newThreadEntryId(Date.parse(e.at) + (seq++ % 7)), via: 'runner' })}\n\`\`\`\n\n`);
}
function run(firedAt: string): string {
  const end = new Date(Date.parse(firedAt) + 60_000).toISOString();
  put({ runId: firedAt, kind: 'system', event: 'started', at: firedAt, text: '' } as Omit<ThreadEntry, 'id' | 'via'>);
  put({ runId: firedAt, kind: 'agent', at: end, text: 'post' } as Omit<ThreadEntry, 'id' | 'via'>);
  put({ runId: firedAt, kind: 'system', event: 'ok', at: end, text: '' } as Omit<ThreadEntry, 'id' | 'via'>);
  return `daily-digest::${firedAt}`;
}

async function cli(argv: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const spies = (['log', 'error', 'warn'] as const).map((k) => vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); }));
  process.exitCode = undefined;
  process.chdir(projectRoot);
  try { await createProgram().parseAsync(argv, { from: 'user' }); } finally { for (const s of spies) s.mockRestore(); }
  const code = process.exitCode ?? 0;
  process.exitCode = undefined;
  return { code, out: lines.join('\n') };
}

describe('agents rate', () => {
  it('the owner rates a run with a note; the draft is spawned once; --stars 0 clears', async () => {
    const key = run('2026-11-19T09:00:00.000Z');
    const r = await cli(['agents', 'rate', 'herodot', '--run', key, '--stars', '4', '--note', 'Shorter next time']);
    expect(r.code).toBe(0);
    expect(readScorecard(projectRoot, 'herodot', home).card.ratings[key]).toMatchObject({ stars: 4, by: 'owner', note: 'Shorter next time' });
    expect(spawned.jobs).toEqual([expect.objectContaining({ kind: 'draft', member: 'herodot', run: key })]);
    expect((await cli(['agents', 'rate', 'herodot', '--run', key, '--stars', '0'])).code).toBe(0);
    expect(readScorecard(projectRoot, 'herodot', home).card.ratings[key]).toBeUndefined();
  });

  it('from an agent session without his words it is refused rate_needs_owner_words', async () => {
    run('2026-11-19T09:00:00.000Z');
    process.env.CLAUDE_CODE_SESSION_ID = 'sess-fictional';
    const r = await cli(['agents', 'rate', 'herodot', '--last', '--stars', '4']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('rate_needs_owner_words');
    const q = await cli(['agents', 'rate', 'herodot', '--last', '--stars', '4', '--quote', 'words he never said anywhere at all']);
    expect(q.code).toBe(1);
    expect(q.out).toContain('rate_needs_owner_words');
  });

  it('refuses bad arguments and an unknown member', async () => {
    expect((await cli(['agents', 'rate', 'herodot', '--stars', '4'])).out).toContain('invalid_args');
    expect((await cli(['agents', 'rate', 'nobody', '--last', '--stars', '4'])).out).toContain('unknown_member');
  });
});

describe('agents scorecard', () => {
  it('the owner adds a line; show --json prints it; an agent session may not', async () => {
    expect((await cli(['agents', 'scorecard', 'criteria', 'add', 'herodot', 'Only shipped features are claimed'])).code).toBe(0);
    const show = await cli(['agents', 'scorecard', 'show', 'herodot', '--json']);
    expect(show.out).toContain('Only shipped features are claimed');
    process.env.CLAUDE_CODE_SESSION_ID = 'sess-fictional';
    const refused = await cli(['agents', 'scorecard', 'criteria', 'add', 'herodot', 'Something else']);
    expect(refused.code).toBe(1);
    expect(readScorecard(projectRoot, 'herodot', home).card.criteria).toHaveLength(1);
    expect((await cli(['agents', 'scorecard', 'goal', 'clear', 'herodot'])).code).toBe(1);
    expect((await cli(['agents', 'scorecard', 'fresh', 'herodot'])).code).toBe(1);
  });
});
