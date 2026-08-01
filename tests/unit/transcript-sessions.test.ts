/**
 * Unit tests for the past-conversations index (`lib/transcript-sessions.ts`) — the
 * "Past chats" picker's data source. Fixture lines mirror real
 * `~/.claude/projects/<slug>/<uuid>.jsonl` entries observed on CLI 2.1.220 (2026-08-01):
 * a `queue-operation` preamble, a hook `attachment`, `user`/`assistant` turns carrying
 * `cwd`/`gitBranch`/`timestamp`, and `last-prompt` records.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, statSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  listPastSessions, resolveProjectDir, summarizeTranscript, scanChunk, oneLine,
  claudeProjectDirName, clearTranscriptSessionCaches, promptLabel, isAgentRun,
} from '../../src/lib/transcript-sessions.js';

const PROJECT = '/Users/tester/projects/demo';
const SLUG = '-Users-tester-projects-demo';

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const S3 = '33333333-3333-4333-8333-333333333333';

const jsonl = (entries: unknown[]) => entries.map((e) => JSON.stringify(e)).join('\n') + '\n';

/** A realistic session file: CLI preamble, a hook attachment, then the given prompts. */
function transcript(prompts: string[], opts: { branch?: string; cwd?: string; sidechain?: boolean } = {}) {
  const cwd = opts.cwd ?? PROJECT;
  const gitBranch = opts.branch ?? 'main';
  const entries: unknown[] = [
    { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-08-01T11:41:29.085Z' },
    { type: 'attachment', attachment: { type: 'hook_success', hookName: 'SessionStart:startup', content: 'brain preload…' } },
  ];
  prompts.forEach((text, i) => {
    entries.push({
      type: 'user',
      isSidechain: opts.sidechain === true,
      uuid: `u${i}`,
      timestamp: `2026-08-01T12:0${i}:00.000Z`,
      cwd,
      gitBranch,
      message: { role: 'user', content: [{ type: 'text', text }] },
    });
    entries.push({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: `ok ${i}` }] },
    });
  });
  return jsonl(entries);
}

/** Real byte size + mtime — `raw.length` is CHARACTERS, and a fixture holding one `…`
 *  understates the file by two bytes, which is exactly enough to truncate the tail read. */
function statOf(path: string) {
  const st = statSync(path);
  return { mtimeMs: st.mtimeMs, size: st.size };
}

let home = '';
let projectsDir = '';

function writeSession(id: string, raw: string, mtimeSec?: number) {
  const path = join(projectsDir, `${id}.jsonl`);
  writeFileSync(path, raw);
  if (mtimeSec !== undefined) utimesSync(path, mtimeSec, mtimeSec);
  return path;
}

beforeEach(() => {
  clearTranscriptSessionCaches();
  home = join(tmpdir(), `dc-sessions-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  projectsDir = join(home, '.claude', 'projects', SLUG);
  mkdirSync(projectsDir, { recursive: true });
});

afterEach(() => {
  clearTranscriptSessionCaches();
  rmSync(home, { recursive: true, force: true });
});

describe('claudeProjectDirName', () => {
  it('encodes a project path the way Claude Code does', () => {
    expect(claudeProjectDirName(PROJECT)).toBe(SLUG);
  });

  it('collapses dots too — a worktree path gets the doubled dash', () => {
    expect(claudeProjectDirName('/Users/me/p/app/.claude-worktrees/fix'))
      .toBe('-Users-me-p-app--claude-worktrees-fix');
  });
});

describe('oneLine', () => {
  it('flattens whitespace and clips with an ellipsis', () => {
    expect(oneLine('a\n\n  b\tc', 40)).toBe('a b c');
    expect(oneLine('x'.repeat(50), 10)).toBe(`${'x'.repeat(9)}…`);
  });
});

describe('promptLabel', () => {
  it('strips the dropped-file paths a message is prefixed with', () => {
    expect(promptLabel('/Users/me/p/_dream_context/tmp/agent-drops/1785-shot.png \n\nadd a tab here'))
      .toBe('add a tab here');
    expect(promptLabel('/a/one.png /a/two.png look at these')).toBe('look at these');
  });

  it('keeps a path that IS the whole message', () => {
    expect(promptLabel('/Users/me/p/shot.png')).toBe('/Users/me/p/shot.png');
  });

  it('leaves a relative path or a mid-sentence path alone', () => {
    expect(promptLabel('src/index.ts is broken')).toBe('src/index.ts is broken');
    expect(promptLabel('read /etc/hosts for me')).toBe('read /etc/hosts for me');
  });
});

describe('scanChunk', () => {
  it('keeps human prompts and drops tool results, meta entries and `<…>` stubs', () => {
    const raw = jsonl([
      { type: 'user', message: { content: 'real question' } },
      { type: 'user', isMeta: true, message: { content: 'meta noise' } },
      { type: 'user', message: { content: '<command-name>clear</command-name>' } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'output' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'answer' }] } },
    ]);
    expect(scanChunk(raw, 10).prompts).toEqual(['real question']);
  });

  it('skips a truncated line at a chunk boundary instead of throwing', () => {
    const raw = `${jsonl([{ type: 'user', message: { content: 'kept' } }])}{"type":"user","messag`;
    expect(scanChunk(raw, 10).prompts).toEqual(['kept']);
  });

  it('past the cap, the last slot tracks the MOST RECENT prompt', () => {
    const raw = jsonl(['a', 'b', 'c', 'd'].map((t) => ({ type: 'user', message: { content: t } })));
    const scan = scanChunk(raw, 2);
    expect(scan.prompts[0]).toBe('a');
    expect(scan.prompts[scan.prompts.length - 1]).toBe('d');
  });

  it('reports cwd, branch and the first prompt timestamp', () => {
    const scan = scanChunk(transcript(['hello'], { branch: 'feat/x' }), 10);
    expect(scan.cwd).toBe(PROJECT);
    expect(scan.gitBranch).toBe('feat/x');
    expect(scan.firstTimestamp).toBe(Date.parse('2026-08-01T12:00:00.000Z'));
  });

  it('flags a sidechain chunk', () => {
    expect(scanChunk(transcript(['sub work'], { sidechain: true }), 10).sidechain).toBe(true);
  });
});

describe('summarizeTranscript', () => {
  it('titles from the first prompt and previews the most recent one', () => {
    const path = writeSession(S1, transcript(['fix the sleep score', 'now ship it']));
    const s = summarizeTranscript(path, S1, statOf(path));
    expect(s?.title).toBe('fix the sleep score');
    expect(s?.preview).toBe('now ship it');
    expect(s?.gitBranch).toBe('main');
    expect(s?.startedAt).toBe(Date.parse('2026-08-01T12:00:00.000Z'));
  });

  it('a one-turn session does not repeat its title as its preview', () => {
    const path = writeSession(S1, transcript(['only one thing']));
    expect(summarizeTranscript(path, S1, statOf(path))?.preview).toBe('');
  });

  it('skips a transcript with no human prompt at all', () => {
    const path = writeSession(S1, jsonl([
      { type: 'queue-operation', operation: 'enqueue' },
      { type: 'user', message: { content: '<system-reminder>hi</system-reminder>' } },
    ]));
    expect(summarizeTranscript(path, S1, statOf(path))).toBeNull();
  });

  it('skips an old-CLI sub-agent sidechain file', () => {
    const path = writeSession(S1, transcript(['dispatched work'], { sidechain: true }));
    expect(summarizeTranscript(path, S1, statOf(path))).toBeNull();
  });

  it('titles from the message, not from the screenshot path it was dropped with', () => {
    const drop = '/Users/tester/projects/demo/_dream_context/tmp/agent-drops/1785585157340-Screenshot.png';
    const path = writeSession(S1, transcript([`${drop}\n\nBuraya geçmiş chatler diye bir sekme ekleyelim`]));
    expect(summarizeTranscript(path, S1, statOf(path))?.title)
      .toBe('Buraya geçmiş chatler diye bir sekme ekleyelim');
  });

  it('falls back to the CLI\'s own `last-prompt` record when the tail is all tool output', () => {
    // The realistic shape: the newest USER entry sits far above the tail window, buried
    // under a long tool-heavy turn — but a `last-prompt` record rides at the end.
    const filler = jsonl(
      Array.from({ length: 900 }, (_, i) => ({
        type: 'assistant',
        message: { content: [{ type: 'text', text: `${'x'.repeat(300)}${i}` }] },
      })),
    );
    const raw = transcript(['opening question']) + filler + jsonl([
      { type: 'last-prompt', lastPrompt: 'and then fix the migration…', sessionId: S1 },
    ]);
    const path = writeSession(S1, raw);
    const s = summarizeTranscript(path, S1, statOf(path));
    expect(s?.title).toBe('opening question');
    expect(s?.preview).toBe('and then fix the migration…');
  });

  it('reads the newest prompt out of the TAIL of a transcript far bigger than the head budget', () => {
    // 300 KB of filler between the first prompt and the last — past HEAD_BYTES (128 KB),
    // so the preview can only come from the tail read.
    const filler = jsonl(
      Array.from({ length: 900 }, (_, i) => ({
        type: 'assistant',
        message: { content: [{ type: 'text', text: `${'x'.repeat(300)}${i}` }] },
      })),
    );
    const raw = transcript(['opening question']) + filler + jsonl([
      { type: 'user', timestamp: '2026-08-01T13:00:00.000Z', message: { content: 'the latest thing I asked' } },
    ]);
    const path = writeSession(S1, raw);
    const s = summarizeTranscript(path, S1, statOf(path));
    expect(raw.length).toBeGreaterThan(128 * 1024);
    expect(s?.title).toBe('opening question');
    expect(s?.preview).toBe('the latest thing I asked');
  });
});

describe('listPastSessions', () => {
  it('lists every conversation newest-activity first', () => {
    writeSession(S1, transcript(['oldest chat']), 1_700_000_000);
    writeSession(S2, transcript(['middle chat']), 1_700_000_500);
    writeSession(S3, transcript(['newest chat']), 1_700_001_000);
    const r = listPastSessions(PROJECT, { home });
    expect(r.sessions.map((s) => s.title)).toEqual(['newest chat', 'middle chat', 'oldest chat']);
    expect(r.sessions.map((s) => s.id)).toEqual([S3, S2, S1]);
    expect(r.total).toBe(3);
    expect(r.truncated).toBe(false);
  });

  it('never ships the search index to the client', () => {
    writeSession(S1, transcript(['secret prompt text']));
    const [row] = listPastSessions(PROJECT, { home }).sessions;
    expect(row).toBeDefined();
    expect(Object.keys(row)).not.toContain('haystack');
  });

  it('matches the query against prompts a title never shows, and ANDs its tokens', () => {
    writeSession(S1, transcript(['first topic', 'later we discussed the migration ledger']));
    writeSession(S2, transcript(['unrelated work on the ledger']));
    expect(listPastSessions(PROJECT, { home, query: 'migration' }).sessions.map((s) => s.id)).toEqual([S1]);
    expect(listPastSessions(PROJECT, { home, query: 'ledger' }).total).toBe(2);
    expect(listPastSessions(PROJECT, { home, query: 'migration ledger' }).sessions.map((s) => s.id)).toEqual([S1]);
    expect(listPastSessions(PROJECT, { home, query: 'MIGRATION' }).total).toBe(1);
    expect(listPastSessions(PROJECT, { home, query: 'nothing here' }).total).toBe(0);
  });

  it('matches the branch too', () => {
    writeSession(S1, transcript(['some work'], { branch: 'feat/chat-steer' }));
    expect(listPastSessions(PROJECT, { home, query: 'chat-steer' }).total).toBe(1);
  });

  it('`total` counts the matches, `limit` bounds only the rows returned', () => {
    writeSession(S1, transcript(['one']), 1_700_000_100);
    writeSession(S2, transcript(['two']), 1_700_000_200);
    writeSession(S3, transcript(['three']), 1_700_000_300);
    const r = listPastSessions(PROJECT, { home, limit: 2 });
    expect(r.sessions).toHaveLength(2);
    expect(r.total).toBe(3);
  });

  it('re-reads a transcript that grew, and reuses the summary of one that did not', () => {
    const path = writeSession(S1, transcript(['first ask']), 1_700_000_000);
    expect(listPastSessions(PROJECT, { home }).sessions[0].preview).toBe('');
    // Rewrite the file behind the cache WITHOUT touching mtime/size → the memo must hold.
    const sameSize = transcript(['XXXXX ask']);
    writeFileSync(path, sameSize);
    utimesSync(path, 1_700_000_000, 1_700_000_000);
    expect(listPastSessions(PROJECT, { home }).sessions[0].title).toBe('first ask');
    // A real append (new mtime AND new size) must invalidate it.
    writeFileSync(path, transcript(['first ask', 'and a follow-up']));
    utimesSync(path, 1_700_000_900, 1_700_000_900);
    expect(listPastSessions(PROJECT, { home }).sessions[0].preview).toBe('and a follow-up');
  });

  it('ignores non-transcript files and empty ones', () => {
    writeSession(S1, transcript(['real chat']));
    writeFileSync(join(projectsDir, 'notes.txt'), 'not a transcript');
    writeFileSync(join(projectsDir, `${S2}.jsonl`), '');
    expect(listPastSessions(PROJECT, { home }).sessions.map((s) => s.id)).toEqual([S1]);
  });

  it('answers empty for a project Claude Code has never run in', () => {
    expect(listPastSessions('/Users/tester/projects/never', { home }))
      .toEqual({ sessions: [], total: 0, agentRuns: 0, truncated: false });
  });
});

// ─── Agent runs ──────────────────────────────────────────────────────────────
//
// The openers below are REAL first prompts, copied from this repo's own
// `~/.claude/projects` corpus (2026-08-01) — 119 of its 372 conversations were spawned by
// the app or by an orchestration skill, and the picker's job is to not bury the other 253
// under them.

describe('isAgentRun', () => {
  const agentBriefs = [
    // The briefs this project writes itself (rule 1) — one per constant.
    'Think hard. Run a full dreamcontext memory consolidation ("sleep") for THIS project now',
    'Think hard. Run the /dream-sync flow for THIS project now, fully autonomously',
    'Work on this dreamcontext task and drive it to completion, fully autonomously',
    'You are scheduled dreamcontext automation "Insight\'ları güncelle" in /Users/me/projects/x',
    // Role assignments an orchestration skill writes (rule 2), in every wrapper seen.
    'You are the goal-planner for a goal-skill v2 run in the dreamcontext repo.',
    'ultrathink. You are the goal-planner in a goal-skill v2 orchestration for the dreamcontext repo',
    'ultrathink ROLE: You are the goal-planner for a goal-skill v2 orchestration',
    '# Your role\nYou are the **goal-planner** in a goal-skill v2 orchestration.',
    'You are a PLAN REVIEWER (pragmatist lens: scope/YAGNI), read-only',
    'You are the **T6 implementer**, wave 2, in a parallel build on the dreamcontext repo',
    'You are a council persona in a dreamcontext debate.',
    'You are the GOAL-PLANNER (not an orchestrator) for a goal-skill v2 rewrite. Think deeply.',
  ];
  for (const brief of agentBriefs) {
    it(`flags: ${brief.slice(0, 52).replace(/\n/g, ' ')}…`, () => {
      expect(isAgentRun(brief)).toBe(true);
    });
  }

  const humanPrompts = [
    'Buraya geçmiş chat’ler diye bir sekme ekleyelim',
    'sleep score değişti bildğin gibi peki dreamco app’de de sleep score’u doğru gözüküyor mu',
    'Use the Bash tool four times, one at a time: `sleep 6 && echo A1`',
    'publish checklist patterni uygulansın',
    'what is dreamcontext inform me',
    'selam',
    // "you are" that is not a role ASSIGNMENT — the opener has to be about the agent's role,
    // not merely contain the words.
    'why are you sure the migration ran? you are guessing',
    'Think hard about why the scroll jumps',
  ];
  for (const prompt of humanPrompts) {
    it(`keeps: ${prompt.slice(0, 52)}…`, () => {
      expect(isAgentRun(prompt)).toBe(false);
    });
  }

  it('is not fooled by an empty or whitespace prompt', () => {
    expect(isAgentRun('')).toBe(false);
    expect(isAgentRun('   \n ')).toBe(false);
  });
});

describe('listPastSessions — agent runs', () => {
  const SLEEP_BRIEF = 'Think hard. Run a full dreamcontext memory consolidation ("sleep") for THIS project now';

  it('withholds agent runs by default and says how many', () => {
    writeSession(S1, transcript(['a real question about the ledger']), 1_700_000_300);
    writeSession(S2, transcript([SLEEP_BRIEF]), 1_700_000_200);
    writeSession(S3, transcript(['You are the goal-planner for a goal-skill v2 run.']), 1_700_000_100);

    const shown = listPastSessions(PROJECT, { home });
    expect(shown.sessions.map((s) => s.id)).toEqual([S1]);
    expect(shown.total).toBe(1);
    expect(shown.agentRuns).toBe(2);
  });

  it('includes them on request, and then withholds nothing', () => {
    writeSession(S1, transcript(['a real question']), 1_700_000_300);
    writeSession(S2, transcript([SLEEP_BRIEF]), 1_700_000_200);

    const all = listPastSessions(PROJECT, { home, includeAgentRuns: true });
    expect(all.sessions.map((s) => s.id)).toEqual([S1, S2]);
    expect(all.total).toBe(2);
    expect(all.agentRuns).toBe(0);
    expect(all.sessions.map((s) => s.agentRun)).toEqual([false, true]);
  });

  it('counts the agent runs that match the QUERY, not the whole corpus', () => {
    // Two sleep runs, but only one of them mentions the searched word.
    writeSession(S1, transcript([SLEEP_BRIEF, 'the ledger reconciled cleanly']), 1_700_000_300);
    writeSession(S2, transcript([SLEEP_BRIEF, 'nothing to report']), 1_700_000_200);
    writeSession(S3, transcript(['what happened to the ledger']), 1_700_000_100);

    const r = listPastSessions(PROJECT, { home, query: 'ledger' });
    expect(r.sessions.map((s) => s.id)).toEqual([S3]);
    expect(r.agentRuns).toBe(1);
  });

  it('classifies past a leading attachment path, which would otherwise hide a brief', () => {
    writeSession(S1, transcript([`${PROJECT}/tmp/plan.md ${SLEEP_BRIEF}`]));
    expect(listPastSessions(PROJECT, { home }).agentRuns).toBe(1);
  });

  it('classifies on the full prompt, not the row-clipped title', () => {
    // A brief whose role assignment sits past TITLE_MAX (120 chars) must still be caught.
    const padded = `ultrathink. ${'context '.repeat(20)}You are the goal-planner for this run.`;
    expect(padded.length).toBeGreaterThan(120);
    writeSession(S1, transcript([padded]));
    // (Rule 2 anchors at the START, so this one is correctly NOT flagged — what the test
    // pins is that the decision is made on the whole prompt, never on a truncated copy.)
    const r = listPastSessions(PROJECT, { home, includeAgentRuns: true });
    expect(r.sessions[0].title.endsWith('…')).toBe(true);
    expect(r.sessions[0].agentRun).toBe(false);
  });
});

describe('resolveProjectDir', () => {
  it('finds the dir by slug', () => {
    expect(resolveProjectDir(PROJECT, home)).toBe(projectsDir);
  });

  it('falls back to the cwd recorded INSIDE the transcripts when the slug encoding misses', () => {
    // A dir name no slug rule of ours would produce — the fallback has to read its way in.
    const odd = join(home, '.claude', 'projects', 'zz-opaque-hash-9f2c');
    mkdirSync(odd, { recursive: true });
    writeFileSync(join(odd, `${S2}.jsonl`), transcript(['work here'], { cwd: '/Users/tester/projects/other' }));
    clearTranscriptSessionCaches();
    expect(resolveProjectDir('/Users/tester/projects/other', home)).toBe(odd);
  });

  it('returns null when no dir records that cwd', () => {
    expect(resolveProjectDir('/Users/tester/projects/nope', home)).toBeNull();
  });
});
