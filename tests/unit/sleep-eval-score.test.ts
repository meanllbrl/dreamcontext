import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  aggregate,
  goldFor,
  labelsHash,
  lexicalSimilarity,
  matchPairs,
  scoreRound,
  type RoundOutput,
  type Similarity,
} from '../../src/lib/sleep-eval/score.js';
import { buildBrief, claudeArgs, diffVault, findEscapes, realTouchables, runEval, scratchEnv, whySection, type LoadSample } from '../../src/lib/sleep-eval/runner.js';
import { prepareScratch, sanitizeSetupConfig, sessionTaskSlugs, shimScript, trimChangelogAfter } from '../../src/lib/sleep-eval/scratch.js';
import { checkCloseGate, gateVerdict, renderReport, scoreRun, writeBaseline, type StoredScore } from '../../src/lib/sleep-eval/report.js';
import { writeRound } from '../../src/lib/sleep-eval/fixtures.js';
import { recordLabel } from '../../src/lib/sleep-eval/labels.js';
import type { FixtureRound, LabelItem, TaskFeedbackEntry } from '../../src/lib/sleep-eval/types.js';

// Fictional project throughout: "Larkspur", a recipe app.

const item = (id: string, category: LabelItem['category'], name: string, extra: Partial<LabelItem> = {}): LabelItem => ({
  id: `r1:${id}`, round: 'r1', category, name, why: '', quote: '', basis: 'unknown', ...extra,
});
const label = (id: string, verdict: 'keep' | 'reject', reason: TaskFeedbackEntry['reason'] = null): TaskFeedbackEntry => ({
  id: `r1:${id}`, at: '2026-05-01T00:00:00Z', source: 'sleep-eval', verdict, proposal: { name: '', why: '' }, basis: 'unknown', quote: '', reason,
});

/** Exact-name similarity: 1 when the first sentence matches, else 0. Pins the arithmetic. */
const exact: Similarity = (a, b) => (a.split('. ')[0].toLowerCase() === b.split('. ')[0].toLowerCase() ? 1 : 0);
const T = { matchThreshold: 0.5, duplicateThreshold: 0.5 };

const ITEMS: LabelItem[] = [
  item('opened:1', 'opened', 'Pantry view'),
  item('opened:2', 'opened', 'Old idea'),
  item('opened:3', 'opened', 'Grocery twin'),
  item('explicit-ask:1', 'explicit-ask', 'Recipe photos survive import'),
  item('explicit-ask:2', 'explicit-ask', 'Print a shopping list'),
  item('sub-detail:1', 'sub-detail', 'Pantry sorts by expiry', { parent: 'pantry-view' }),
  item('abandoned:1', 'abandoned', 'Meal planner'),
  item('other-project:1', 'other-project', 'Bakery invoices'),
  item('style-correction:1', 'style-correction', 'Say it in plain words'),
  item('explicit-ask:3', 'explicit-ask', 'Never labelled'),
];
const LABELS = new Map([
  ['r1:opened:1', label('opened:1', 'keep')],
  ['r1:opened:2', label('opened:2', 'reject', 'abandoned')],
  ['r1:opened:3', label('opened:3', 'reject', 'already-exists')],
  ['r1:explicit-ask:1', label('explicit-ask:1', 'keep')],
  ['r1:explicit-ask:2', label('explicit-ask:2', 'keep')],
  ['r1:sub-detail:1', label('sub-detail:1', 'keep')],
  ['r1:abandoned:1', label('abandoned:1', 'keep')],
  ['r1:other-project:1', label('other-project:1', 'keep')],
  ['r1:style-correction:1', label('style-correction:1', 'keep')],
].map(([k, v]) => [k as string, v as TaskFeedbackEntry]));

const OUT: RoundOutput = {
  round: 'r1',
  opened: [
    { slug: 'pantry-view', name: 'Pantry view', why: '', parent: null },
    { slug: 'meal-planner', name: 'Meal planner', why: '', parent: null },
    { slug: 'bakery', name: 'Bakery invoices', why: '', parent: null },
    { slug: 'grocery', name: 'Grocery twin', why: '', parent: null },
    { slug: 'recipes-copy', name: 'Recipes board', why: '', parent: null },
    { slug: 'mystery', name: 'Something new', why: '', parent: null },
    { slug: 'expiry', name: 'Pantry sorts by expiry', why: '', parent: 'pantry-view' },
  ],
  folds: [{ slug: 'imports', parent: null, text: 'Recipe photos survive import' }],
  patterns: [{ path: 'knowledge/patterns/voice.md', text: '# Voice\n\nSay it in plain words, every time.\n\nAnother rule here entirely.' }],
  boardNames: [{ slug: 'recipes', name: 'Recipes board' }],
};

describe('scoreRound', () => {
  it('pins every metric on a hand-checked round', () => {
    const s = scoreRound(ITEMS, LABELS, OUT, exact, T);
    expect(s.opened).toBe(7);
    expect(s.kept).toBe(2);           // pantry view (opened keep) + expiry (sub-detail)
    expect(s.abandoned).toBe(1);      // meal planner
    expect(s.wrongProject).toBe(1);   // bakery
    expect(s.duplicates).toBe(2);     // grocery (rejected as already-exists) + recipes board (board twin)
    expect(s.unknown.map((u) => u.slug)).toEqual(['mystery']);
    expect(s.asks).toEqual({ hit: 2, total: 3 });    // photos (fold) + expiry (opened); shopping list missed
    expect(s.parents).toEqual({ hit: 1, total: 1 }); // expiry under pantry-view
    expect(s.patterns).toEqual({ hit: 0, total: 1 }); // a paragraph must match the whole correction text
    expect(s.gold).toBe(9);
  });

  it('credits a pattern when a changed pattern paragraph is the correction', () => {
    const out = { ...OUT, patterns: [{ path: 'p.md', text: 'Say it in plain words' + '\n\nfiller paragraph long enough to count' }] };
    expect(scoreRound(ITEMS, LABELS, out, exact, T).patterns).toEqual({ hit: 1, total: 1 });
  });

  it('a fold into the right parent counts for the parent rate', () => {
    const out: RoundOutput = { ...OUT, opened: [], folds: [{ slug: 'pantry-view', parent: null, text: 'Pantry sorts by expiry' }] };
    expect(scoreRound(ITEMS, LABELS, out, exact, T).parents).toEqual({ hit: 1, total: 1 });
    const wrong: RoundOutput = { ...OUT, opened: [], folds: [{ slug: 'imports', parent: null, text: 'Pantry sorts by expiry' }] };
    expect(scoreRound(ITEMS, LABELS, wrong, exact, T).parents).toEqual({ hit: 0, total: 1 });
  });

  it('rejected candidates and unlabelled items are not gold', () => {
    const labels = new Map(LABELS);
    labels.set('r1:abandoned:1', label('abandoned:1', 'reject'));
    expect(goldFor(ITEMS, labels).some((g) => g.item.id === 'r1:abandoned:1')).toBe(false);
    expect(goldFor(ITEMS, labels).some((g) => g.item.id === 'r1:explicit-ask:3')).toBe(false);
  });
});

describe('outcome answers ("what should sleep have done?")', () => {
  const ans = (id: string, outcome: TaskFeedbackEntry['outcome'], reason: TaskFeedbackEntry['reason'] = null): [string, TaskFeedbackEntry] =>
    [`r1:${id}`, { ...label(id, outcome === 'nothing' ? 'reject' : 'keep', reason), outcome }];
  it('maps each outcome to gold and scores a misfiled new task as shouldFold', () => {
    const items = [
      item('explicit-ask:1', 'explicit-ask', 'Recipe photos survive import', { parent: 'imports' }),
      item('explicit-ask:2', 'explicit-ask', 'Print a shopping list'),
      item('sub-detail:1', 'sub-detail', 'Pantry sorts by expiry', { parent: 'pantry-view' }),
      item('abandoned:1', 'abandoned', 'Meal planner'),
    ];
    const labels = new Map([
      ans('explicit-ask:1', 'add-to-task'),
      ans('explicit-ask:2', 'new-task'),
      ans('sub-detail:1', 'new-task'),          // the owner overrides the model's "sub-detail" reading
      ans('abandoned:1', 'nothing', 'abandoned'),
    ]);
    const out: RoundOutput = {
      round: 'r1', boardNames: [], patterns: [], folds: [],
      opened: [
        { slug: 'photos', name: 'Recipe photos survive import', why: '', parent: null }, // belonged in "imports"
        { slug: 'list', name: 'Print a shopping list', why: '', parent: null },
        { slug: 'expiry', name: 'Pantry sorts by expiry', why: '', parent: null },
        { slug: 'planner', name: 'Meal planner', why: '', parent: null },
      ],
    };
    const s = scoreRound(items, labels, out, exact, T);
    expect(s.kept).toBe(2);        // list + expiry (the owner said: its own task)
    expect(s.shouldFold).toBe(1);  // photos
    expect(s.abandoned).toBe(1);
    expect(s.parents).toEqual({ hit: 0, total: 1 });
    expect(s.asks).toEqual({ hit: 3, total: 3 });
    // Filed as a sub-task under the right parent is right.
    const under = scoreRound(items, labels, { ...out, opened: [{ ...out.opened[0], parent: 'imports' }] }, exact, T);
    expect(under).toMatchObject({ kept: 1, shouldFold: 0, parents: { hit: 1, total: 1 } });
  });
});

describe('aggregate', () => {
  it('micro-averages and the composite is the mean of the defined rates', () => {
    const s = scoreRound(ITEMS, LABELS, OUT, exact, T);
    const empty = scoreRound(ITEMS, LABELS, { ...OUT, round: 'r2', opened: [], folds: [], patterns: [] }, exact, T);
    const run = aggregate([s, empty]);
    expect(run.precision).toBeCloseTo(2 / 7);
    expect(run.askRecall).toBeCloseTo(2 / 3);
    expect(run.parentRate).toBe(1);
    expect(run.patternRate).toBe(0);
    expect(run.composite).toBeCloseTo((2 / 7 + 2 / 3 + 1 + 0) / 4);
    expect(aggregate([]).composite).toBeNull();
  });
});

describe('matchPairs / lexicalSimilarity / labelsHash', () => {
  it('matches one-to-one, best pair first', () => {
    const pairs = matchPairs(['a', 'b'], ['x', 'y'], (p, q) => ({ ax: 0.9, ay: 0.95, bx: 0.8, by: 0.1 } as Record<string, number>)[p + q], 0.5);
    expect(pairs.map(([p, q]) => p + q)).toEqual(['ay', 'bx']);
  });
  it('lexical similarity folds Turkish letters', () => {
    expect(lexicalSimilarity('Görev açma ölçülür', 'gorev acma olculur')).toBe(1);
    expect(lexicalSimilarity('', 'x')).toBe(0);
  });
  it('labelsHash ignores order and notes', () => {
    const a = [label('opened:1', 'keep'), label('opened:2', 'reject', 'abandoned')];
    expect(labelsHash(a)).toBe(labelsHash([...a].reverse()));
    expect(labelsHash(a)).not.toBe(labelsHash([label('opened:1', 'reject', 'too-small'), a[1]]));
  });
});

describe('diffVault / whySection', () => {
  const task = (name: string, body: string, extra = '') => `---\nname: ${name}\nstatus: todo\n${extra}---\n\n${body}\n\n## Changelog\n\n### 2026-05-01 - Created\n- Task created.\n`;
  it('new files are opened tasks; added body lines are folds; the changelog is ignored', () => {
    const before = { tasks: new Map([['pantry-view', task('Pantry view', '## Why\n\nOwners lose track of food.')]]), patterns: new Map() };
    const after = {
      tasks: new Map([
        ['pantry-view', task('Pantry view', '## Why\n\nOwners lose track of food.\n\n## Acceptance Criteria\n\n- [ ] Pantry sorts by expiry date') + '- logged something\n'],
        ['expiry', task('Pantry sorts by expiry', '## Why\n<!-- hint -->\nFood goes off unseen.', 'parent_task: pantry-view\n')],
      ]),
      patterns: new Map([['voice', '# Voice\n\nSay it plainly.']]),
    };
    const out = diffVault(before, after, 'r1', []);
    expect(out.opened).toEqual([{ slug: 'expiry', name: 'Pantry sorts by expiry', why: 'Food goes off unseen.', parent: 'pantry-view' }]);
    expect(out.folds).toEqual([{ slug: 'pantry-view', parent: null, text: '- [ ] Pantry sorts by expiry date' }]);
    expect(out.patterns[0]).toMatchObject({ path: 'knowledge/patterns/voice.md' });
  });
  it('whySection strips comments and stops at the next heading', () => {
    expect(whySection('## Why\n<!-- x -->\nA reason.\n\n## Notes\nno')).toBe('A reason.');
  });
});

describe('brief, args, env, shim, config', () => {
  const round: FixtureRound = {
    id: 'r1', consolidatedAt: '2026-05-02T20:00:00Z', previousAt: null, summary: '', board: [], opened: [], candidates: [],
    sessions: [
      { session_id: 'b', file: '', stopped_at: '2026-05-02T10:00:00Z', last_assistant_message: '', subagents: [] },
      { session_id: 'a', file: '', stopped_at: '2026-05-01T10:00:00Z', last_assistant_message: '', subagents: [] },
    ],
  };
  it('lists sessions oldest first with their task slugs and the override line', () => {
    const brief = buildBrief(round, 'E', 'standard', 'v1.2.0', new Map([['a', ['pantry-view']]]));
    expect(brief.indexOf('2026-05-01T10:00:00Z  a  [pantry-view]')).toBeLessThan(brief.indexOf('2026-05-02T10:00:00Z  b  []'));
    expect(brief).toContain('later sessions override earlier ones');
  });
  it('the specialist runs as the session agent with no orchestration tools', () => {
    const args = claudeArgs('P', 'sleep-tasks', 'claude-opus-5', 'medium');
    expect(args.slice(0, 4)).toEqual(['-p', 'P', '--agent', 'sleep-tasks']);
    expect(args).toContain('--no-session-persistence');
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('project');
    expect(args[args.indexOf('--disallowedTools') + 1]).toContain('Agent');
    // An unscoped Write/Edit in the allow list reaches every path: they must not be there.
    expect(args[args.indexOf('--allowedTools') + 1].split(' ')).toEqual(['Bash', 'Read', 'Glob', 'Grep']);
  });
  it('the child env puts the shim first and drops session identity', () => {
    const env = scratchEnv({ bin: '/s/bin' } as never, { PATH: '/usr/bin', DREAMCONTEXT_TAB_SESSION: 'x', CLAUDE_CODE_SESSION_ID: 'y', HOME: '/h' });
    expect(env.PATH).toBe('/s/bin:/usr/bin');
    expect(env.DREAMCONTEXT_TAB_SESSION).toBeUndefined();
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(env.HOME).toBe('/h');
  });
  it('the setup config loses every outward path', () => {
    const c = sanitizeSetupConfig({ taskBackend: 'github', github: { owner: 'o' }, brainRepo: {}, linkedRepos: [], learning: { enabled: true }, setupVersion: '0.1.0' }, '9.9.9');
    expect(c).toEqual({ taskBackend: 'local', learning: { enabled: true }, setupVersion: '9.9.9' });
  });
  it('the shim refuses outward verbs and pins HOME for the rest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shim-'));
    try {
      const entry = join(dir, 'cli.mjs');
      writeFileSync(entry, 'console.log(process.env.HOME + " " + process.argv.slice(2).join(" "))');
      const shim = join(dir, 'dreamcontext');
      const log = join(dir, 'log');
      writeFileSync(shim, shimScript({ home: join(dir, 'h'), log, nodeBin: process.execPath, cliEntry: entry }), { mode: 0o755 });
      expect(execFileSync(shim, ['tasks', 'list']).toString().trim()).toBe(`${join(dir, 'h')} tasks list`);
      expect(execFileSync(shim, ['peer', 'send', 'Tilki', 'hi']).toString()).toContain('recorded, not run');
      expect(() => execFileSync(shim, ['brain', 'sync'], { stdio: 'pipe' })).toThrow();
      expect(readFileSync(log, 'utf-8')).toBe('peer send Tilki hi\nbrain sync\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('session task slugs come from what the session touched, limited to the board', () => {
    const dir = mkdtempSync(join(tmpdir(), 'slugs-'));
    try {
      const p = join(dir, 't.jsonl');
      writeFileSync(p, 'dreamcontext tasks log pantry-view "x" ... _dream_context/state/expiry.md ... tasks status not-on-board done');
      expect(sessionTaskSlugs(p, new Set(['pantry-view', 'expiry']))).toEqual(['expiry', 'pantry-view']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── End to end: a round through an injected "agent", scored, gated ──────────

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sleep-eval-run-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function fakeSet(): { ctx: string; project: string; entry: string } {
  const project = join(dir, 'brain');
  const ctx = join(project, '_dream_context');
  const evalRoot = join(ctx, 'tmp', 'sleep-eval');
  mkdirSync(join(evalRoot, 'board'), { recursive: true });
  mkdirSync(join(ctx, 'state'), { recursive: true });
  mkdirSync(join(ctx, 'core'), { recursive: true });
  mkdirSync(join(project, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(project, '.claude', 'agents', 'sleep-tasks.md'), '---\nname: sleep-tasks\nmodel: claude-opus-5\neffort: medium\n---\nYou file tasks.\n');
  writeFileSync(join(ctx, 'state', '.config.json'), JSON.stringify({ taskBackend: 'github', github: { owner: 'o', repo: 'r' } }));
  writeFileSync(join(evalRoot, 'board', 'pantry-view.md'), '---\nname: Pantry view\nstatus: todo\n---\n\n## Why\n\nFood.\n');
  writeFileSync(join(evalRoot, 'set.json'), JSON.stringify({ version: 1, createdAt: '2026-05-03T00:00:00Z', source: ctx, rounds: ['r1'], scoring: { matchThreshold: 0.5, duplicateThreshold: 0.9, gateTolerance: 0.05 } }));
  mkdirSync(join(evalRoot, 'fixtures', 'r1', 'sessions'), { recursive: true });
  writeFileSync(join(evalRoot, 'fixtures', 'r1', 'sessions', 's1.jsonl'), '');
  writeRound(ctx, {
    id: 'r1', consolidatedAt: '2026-05-02T20:00:00Z', previousAt: null, summary: '', board: ['pantry-view'],
    sessions: [{ session_id: 's1', file: 'sessions/s1.jsonl', stopped_at: '2026-05-02T10:00:00Z', last_assistant_message: 'ok', subagents: [] }],
    opened: [], candidates: [{ id: 'r1:explicit-ask:1', round: 'r1', category: 'explicit-ask', name: 'Recipe photos survive import', why: '', quote: '', basis: 'ask' }],
  });
  // A stand-in CLI: answers `sleep start --json`, prints nothing for the rest.
  const entry = join(dir, 'cli.mjs');
  writeFileSync(entry, 'const a = process.argv.slice(2).join(" "); if (a === "sleep start --json") console.log(JSON.stringify({ epoch: "2026-05-03T00:00:00Z", depth: "light" }));');
  return { ctx, project, entry };
}

const quiet = (): LoadSample => ({ load1: 0.5, cores: 8, freeMemMb: 1000 });

describe('runEval → scoreRun → gate', () => {
  it('replays a round in a sandboxed scratch vault and keeps only its changes', async () => {
    const { ctx, project, entry } = fakeSet();
    let seen: { args: string[]; cwd: string; env: Record<string, string | undefined> } | null = null;
    const meta = await runEval(ctx, {
      brainProject: project, cliEntry: entry, nodeBin: process.execPath, cliVersion: '9.9.9', load: quiet, for: 'child-task',
      exec: async (args, cwd, env) => {
        seen = { args, cwd, env };
        writeFileSync(join(cwd, '_dream_context', 'state', 'recipe-photos.md'), '---\nname: Recipe photos survive import\nstatus: todo\n---\n\n## Why\n\nOwners re-attach photos.\n');
        const now = new Date();
        return { spawned: true, timedOut: false, exitCode: 0, stdout: '{"result":"report","total_cost_usd":0.42,"num_turns":7}', stderrTail: '', startedAt: now, finishedAt: now, result: null };
      },
    });
    expect(meta.rounds).toHaveLength(1);
    expect(meta.rounds[0]).toMatchObject({ round: 'r1', status: 'ok', costUsd: 0.42, turns: 7, escaped: [] });
    expect(meta.model).toBe('claude-opus-5');
    const s = seen!;
    expect(s.args).toContain('claude-opus-5');
    expect(s.args[1]).toContain('Epoch: 2026-05-03T00:00:00Z');
    expect(s.env.PATH!.split(':')[0]).toMatch(/scratch\/bin$/);
    // The scratch vault is gone (round ok, no --keep-scratch); its config was local-only while it lived.
    expect(existsSync(join(ctx, 'tmp', 'sleep-eval', 'runs', meta.id, 'r1', 'scratch'))).toBe(false);
    const out = JSON.parse(readFileSync(join(ctx, 'tmp', 'sleep-eval', 'runs', meta.id, 'r1', 'output.json'), 'utf-8'));
    expect(out.opened).toEqual([{ slug: 'recipe-photos', name: 'Recipe photos survive import', why: 'Owners re-attach photos.', parent: null }]);
    expect(readFileSync(join(ctx, 'tmp', 'sleep-eval', 'runs', meta.id, 'r1', 'brief.md'), 'utf-8')).toContain('2026-05-02T10:00:00Z  s1  []');

    recordLabel(ctx, { id: 'r1:explicit-ask:1', verdict: 'keep' });
    const stored = await scoreRun(ctx, meta.id, { sim: lexicalSimilarity, matcher: 'lexical' });
    expect(stored.score.askRecall).toBe(1);
    expect(stored.score.precision).toBe(1);
    expect(stored.score.composite).toBe(1);

    // No baseline: the gate does not apply. With one: the run made FOR the child decides.
    expect(checkCloseGate(ctx, 'child-task', 'parent').applies).toBe(false);
    writeBaseline(ctx, { runId: meta.id, parents: ['parent'], at: '' });
    expect(checkCloseGate(ctx, 'child-task', 'parent')).toMatchObject({ applies: true, ok: true });
    expect(checkCloseGate(ctx, 'other-child', 'parent')).toMatchObject({ applies: true, ok: false });
    expect(checkCloseGate(ctx, 'child-task', 'another-parent').applies).toBe(false);
    // A partial run made for the child (fewer rounds than the baseline) never passes.
    const partial = { ...meta, id: `${meta.id}-partial`, startedAt: `${meta.startedAt}Z`, rounds: [] };
    mkdirSync(join(ctx, 'tmp', 'sleep-eval', 'runs', partial.id), { recursive: true });
    writeFileSync(join(ctx, 'tmp', 'sleep-eval', 'runs', partial.id, 'run.json'), JSON.stringify(partial));
    expect(checkCloseGate(ctx, 'child-task', 'parent')).toMatchObject({ applies: true, ok: false });
    expect(checkCloseGate(ctx, 'child-task', 'parent').message).toContain('did not cover');
    rmSync(join(ctx, 'tmp', 'sleep-eval', 'runs', partial.id), { recursive: true, force: true });
    // Labels moved since the score: the gate asks for a re-score rather than comparing stale numbers.
    recordLabel(ctx, { id: 'r1:explicit-ask:1', verdict: 'reject' });
    expect(checkCloseGate(ctx, 'child-task', 'parent').message).toContain('Labels changed');

    const md = renderReport(meta, stored, null, 0);
    expect(md).toContain('İsabet');
    expect(md).toContain('$0.42');
  });

  it('--retry re-runs only the rounds that did not end ok, in the same run', async () => {
    const { ctx, project, entry } = fakeSet();
    let calls = 0;
    const base = { brainProject: project, cliEntry: entry, nodeBin: process.execPath, cliVersion: '9.9.9', load: quiet };
    const fail = async () => { calls++; const now = new Date(); return { spawned: true, timedOut: true, exitCode: null, stdout: '', stderrTail: '', startedAt: now, finishedAt: now, result: null }; };
    const ok = async () => { calls++; const now = new Date(); return { spawned: true, timedOut: false, exitCode: 0, stdout: '{}', stderrTail: '', startedAt: now, finishedAt: now, result: null }; };
    const first = await runEval(ctx, { ...base, exec: fail });
    expect(first.rounds[0].status).toBe('timeout');
    const repaired = await runEval(ctx, { ...base, exec: ok, retry: first.id });
    expect(repaired.id).toBe(first.id);
    expect(repaired.rounds.map((r) => r.status)).toEqual(['ok']);
    expect(repaired.retriedAt).toHaveLength(1);
    expect(calls).toBe(2);
    // Nothing left to retry: no round runs again.
    await runEval(ctx, { ...base, exec: ok, retry: first.id });
    expect(calls).toBe(2);
  });

  it('--retry stays inside the run it repairs and refuses a changed agent or CLI', async () => {
    const { ctx, project, entry } = fakeSet();
    const evalRoot = join(ctx, 'tmp', 'sleep-eval');
    const set = JSON.parse(readFileSync(join(evalRoot, 'set.json'), 'utf-8'));
    writeFileSync(join(evalRoot, 'set.json'), JSON.stringify({ ...set, rounds: ['r1', 'r2'] }));
    mkdirSync(join(evalRoot, 'fixtures', 'r2', 'sessions'), { recursive: true });
    writeFileSync(join(evalRoot, 'fixtures', 'r2', 'sessions', 's2.jsonl'), '');
    writeRound(ctx, {
      id: 'r2', consolidatedAt: '2026-05-03T20:00:00Z', previousAt: null, summary: '', board: ['pantry-view'],
      sessions: [{ session_id: 's2', file: 'sessions/s2.jsonl', stopped_at: '2026-05-03T10:00:00Z', last_assistant_message: 'ok', subagents: [] }],
      opened: [], candidates: [],
    });
    const ran: string[] = [];
    const base = { brainProject: project, cliEntry: entry, nodeBin: process.execPath, cliVersion: '9.9.9', gitSha: 'aaaa1111', load: quiet };
    const exec = (timedOut: boolean) => async (_a: string[], cwd: string) => {
      ran.push(cwd);
      const now = new Date();
      return { spawned: true, timedOut, exitCode: timedOut ? null : 0, stdout: '{}', stderrTail: '', startedAt: now, finishedAt: now, result: null };
    };
    // A partial run (--rounds r1) that timed out: the retry re-runs r1 and never adds r2.
    const partial = await runEval(ctx, { ...base, rounds: ['r1'], exec: exec(true) });
    expect(partial.agentHash).toMatch(/^[0-9a-f]{12}$/);
    const repaired = await runEval(ctx, { ...base, exec: exec(false), retry: partial.id });
    expect(repaired.rounds.map((r) => [r.round, r.status])).toEqual([['r1', 'ok']]);
    expect(ran).toHaveLength(2);

    const timedOut = await runEval(ctx, { ...base, exec: exec(true) });
    expect(timedOut.rounds.map((r) => r.status)).toEqual(['timeout', 'timeout']);
    // A newer CLI, or an edited agent, would mix two versions into one run: refused.
    await expect(runEval(ctx, { ...base, cliVersion: '9.9.10', exec: exec(false), retry: timedOut.id })).rejects.toThrow(/CLI changed/);
    await expect(runEval(ctx, { ...base, gitSha: 'bbbb2222', exec: exec(false), retry: timedOut.id })).rejects.toThrow(/CLI changed/);
    const agentFile = join(project, '.claude', 'agents', 'sleep-tasks.md');
    const original = readFileSync(agentFile, 'utf-8');
    writeFileSync(agentFile, `${original}Also file bugs.\n`);
    await expect(runEval(ctx, { ...base, exec: exec(false), retry: timedOut.id })).rejects.toThrow(/agent or its skills changed/);
    writeFileSync(agentFile, original);
    expect(ran).toHaveLength(4);

    // A run from before rounds recorded their agent: the timed-out rounds' kept scratch
    // vaults still say which agent ran, so the retry can check it.
    const runJson = join(evalRoot, 'runs', timedOut.id, 'run.json');
    const legacy = JSON.parse(readFileSync(runJson, 'utf-8'));
    writeFileSync(runJson, JSON.stringify({ ...legacy, agentHash: null, rounds: legacy.rounds.map(({ agentHash: _h, ...r }: { agentHash?: string }) => r) }));
    const fixed = await runEval(ctx, { ...base, exec: exec(false), retry: timedOut.id });
    expect(fixed.rounds.map((r) => r.status)).toEqual(['ok', 'ok']);
    expect(fixed.agentHash).toBe(timedOut.agentHash);
  });

  it('a prepared scratch vault never carries a remote task backend', () => {
    const { ctx, project, entry } = fakeSet();
    const round = JSON.parse(readFileSync(join(ctx, 'tmp', 'sleep-eval', 'fixtures', 'r1', 'round.json'), 'utf-8')) as FixtureRound;
    const v = prepareScratch(ctx, round, join(dir, 'scratch'), { brainProject: project, cliEntry: entry, nodeBin: process.execPath, agents: ['sleep-tasks'], cliVersion: '9.9.9', realHome: dir });
    const cfg = JSON.parse(readFileSync(join(v.ctx, 'state', '.config.json'), 'utf-8'));
    expect(cfg.taskBackend).toBe('local');
    expect(cfg.github).toBeUndefined();
    expect(existsSync(join(v.ctx, 'state', 'pantry-view.md'))).toBe(true);
    const settings = JSON.parse(readFileSync(join(v.proj, '.claude', 'settings.json'), 'utf-8'));
    expect(settings.sandbox.enabled).toBe(true);
    expect(settings.permissions.deny).toContain(`Edit(/${join(ctx, 'state')}/**)`);
    expect(settings.permissions.deny).toContain(`Write(/${join(ctx, 'knowledge')}/**)`);
    expect(settings.permissions.deny.some((r: string) => r.includes(join(ctx, 'tmp')))).toBe(false);
    expect(settings.hooks).toBeUndefined();
    const sleep = JSON.parse(readFileSync(join(v.ctx, 'state', '.sleep.json'), 'utf-8'));
    expect(sleep.sessions[0].transcript_path).toBe(join(ctx, 'tmp', 'sleep-eval', 'fixtures', 'r1', 'sessions', 's1.jsonl'));
    expect(v.home.startsWith(v.proj)).toBe(true);
  });
});

describe('findEscapes', () => {
  it('flags a touched real file that changed or appeared, ignores untouched churn', () => {
    const d = mkdtempSync(join(tmpdir(), 'escape-'));
    try {
      mkdirSync(join(d, 'state'), { recursive: true });
      writeFileSync(join(d, 'state', 'pantry-view.md'), 'a');
      writeFileSync(join(d, 'state', 'owner-edits.md'), 'a');
      writeFileSync(join(d, 'state', 'filed-by-the-real-sleep.md'), 'long ago');
      const before = realTouchables(d);
      writeFileSync(join(d, 'state', 'pantry-view.md'), 'a + escaped fold');
      writeFileSync(join(d, 'state', 'owner-edits.md'), 'the owner kept working');
      writeFileSync(join(d, 'state', 'brand-new.md'), 'created by the round');
      expect(findEscapes(d, before, ['state/pantry-view.md', 'state/brand-new.md', 'state/never-there.md'])).toEqual(['state/pantry-view.md', 'state/brand-new.md']);
      expect(findEscapes(d, before, [])).toEqual([]);
      // A replay that re-files the task the real sleep filed (same slug, untouched real file) is no escape.
      expect(findEscapes(d, before, ['state/filed-by-the-real-sleep.md'])).toEqual([]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('trimChangelogAfter', () => {
  it('drops log entries after the round day, keeps same-day ones and the body', () => {
    const md = '---\nname: x\n---\n\n## Why\n\nBody 2026-12-01 stays.\n\n## Changelog\n\n### 2026-05-03 - Later\n- future\n### 2026-05-02 - Same day\n- kept\n### 2026-05-01 - Created\n- Task created.\n';
    const out = trimChangelogAfter(md, '2026-05-02');
    expect(out).toContain('Body 2026-12-01 stays.');
    expect(out).not.toContain('future');
    expect(out).toContain('- kept');
    expect(out).toContain('Task created.');
    expect(trimChangelogAfter('no log', '2026-01-01')).toBe('no log');
  });
});

describe('prepareScratch for a round cut from another brain', () => {
  it('takes that brain\'s board, config and project files, denies edits to both brains', () => {
    const { ctx, project, entry } = fakeSet();
    const other = join(dir, 'quill', '_dream_context');
    mkdirSync(join(other, 'state'), { recursive: true });
    mkdirSync(join(other, 'core'), { recursive: true });
    writeFileSync(join(other, 'core', '0.soul.md'), 'Quill soul');
    writeFileSync(join(other, 'state', '.config.json'), JSON.stringify({ taskBackend: 'clickup', clickup: { list: 'x' } }));
    const srcDir = join(ctx, 'tmp', 'sleep-eval', 'sources', 'Quill');
    mkdirSync(join(srcDir, 'board'), { recursive: true });
    writeFileSync(join(srcDir, 'board', 'note-sync.md'), '---\nname: Note sync\n---\n');
    const round: FixtureRound = { id: 'quill-r-1', source: { name: 'Quill', ctx: other }, consolidatedAt: '2026-05-05T20:00:00Z', previousAt: null, summary: '', board: ['note-sync'], sessions: [], opened: [], candidates: [] };
    const v = prepareScratch(ctx, round, join(dir, 'scratch-q'), { brainProject: project, cliEntry: entry, nodeBin: process.execPath, agents: ['sleep-tasks'], cliVersion: '9.9.9', realHome: dir });
    expect(existsSync(join(v.ctx, 'state', 'note-sync.md'))).toBe(true);
    expect(existsSync(join(v.ctx, 'state', 'pantry-view.md'))).toBe(false);
    expect(readFileSync(join(v.ctx, 'core', '0.soul.md'), 'utf-8')).toBe('Quill soul');
    expect(JSON.parse(readFileSync(join(v.ctx, 'state', '.config.json'), 'utf-8'))).toMatchObject({ taskBackend: 'local' });
    const deny = JSON.parse(readFileSync(join(v.proj, '.claude', 'settings.json'), 'utf-8')).permissions.deny as string[];
    expect(deny).toContain(`Edit(/${join(other, 'state')}/**)`);
    expect(deny).toContain(`Edit(/${join(ctx, 'state')}/**)`);
    // The specialist under test stays THIS brain's.
    expect(readFileSync(join(v.proj, '.claude', 'agents', 'sleep-tasks.md'), 'utf-8')).toContain('You file tasks.');
  });
});

describe('gateVerdict', () => {
  const stored = (composite: number | null, hash = 'h', matcher: 'e5' | 'lexical' = 'e5'): StoredScore => ({
    runId: 'x', at: '', labelsHash: hash, labelled: 1, matcher, scoring: { matchThreshold: 0.86, duplicateThreshold: 0.92, gateTolerance: 0.05 },
    score: { rounds: [], opened: 0, kept: 0, duplicates: 0, abandoned: 0, wrongProject: 0, precision: null, askRecall: null, parentRate: null, patternRate: null, composite, gold: 0 },
  });
  it('passes within tolerance, fails below it, refuses mismatched labels or matchers', () => {
    expect(gateVerdict(stored(0.46), stored(0.5)).ok).toBe(true);
    expect(gateVerdict(stored(0.44), stored(0.5)).ok).toBe(false);
    expect(gateVerdict(stored(0.9, 'a'), stored(0.5, 'b')).ok).toBe(false);
    expect(gateVerdict(stored(0.9, 'h', 'lexical'), stored(0.5)).ok).toBe(false);
    expect(gateVerdict(stored(null), stored(0.5)).ok).toBe(false);
  });
});
