/**
 * A member's past work, the store and the one rule (plan uye-gecmis-is C1, D1-D5; criteria 2, 9, 10).
 * Every word fictional (pattern synthetic-fixtures); every file under a fake HOME.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  classifyUserEntry, deriveJobs, deriveTranscript, hookQueryOf, parseRecords, promptEntries, readAllTraces, toolWrites,
  traceId, workRoot, writeTrace, dropMemberWork, renameMemberWork, transcriptsOf, locateTranscript, noteTranscript,
  readCursor, buildRunTrace, writeRunTrace, headTail, type WorkTrace,
} from '../../src/lib/agents/work-trace.js';
import { wrapUntrusted } from '../../src/lib/assistant/autonomy.js';
import { REQUEST_FROM, REQUEST_LAST_LINE, ALLOW_TURN_HEAD } from '../../src/lib/super/inbox.js';
import { RESUME_TEXT } from '../../src/lib/super/outbox.js';
import { LIMIT_CONTINUE_TEXT } from '../../src/server/routes/agent-chat.js';
import { recordAgentSession, localDir, projectKey } from '../../src/lib/local-store.js';
import { readTranscriptText } from '../../src/lib/codex-rollout.js';
import {
  Tx, Rollout, asStringContent, makeMachine, globalMember, projectMember, putClaude, putAntigravity, putCodex, type Machine,
} from '../helpers/work-trace-fixtures.js';

const PROJECT = { key: 'k0', name: 'kestrel', root: '/fictional/kestrel' };
const derive = (tx: Tx | string, extra: Partial<Parameters<typeof deriveJobs>[1]> = {}) =>
  deriveJobs(parseRecords(typeof tx === 'string' ? tx : tx.jsonl()), { transcriptId: 'tx-1', project: PROJECT, ...extra });

const request = (text: string, item = 'q1') => [
  `[super events] batch=b1 items=1`,
  `- item=${item} event=request from=super`,
  wrapUntrusted('kestrel', `${REQUEST_FROM}: ${text}`),
  REQUEST_LAST_LINE,
].join('\n');
const replyBatch = (text: string) => [
  `[super events] batch=b2 items=1`,
  `- item=q1 event=reply from=super`,
  wrapUntrusted('kestrel', `${REQUEST_FROM}, the answer to your question: ${text}`),
].join('\n');
const nudgeBatch = () => ['[super events] batch=b3 items=1', '- item=n1 event=nudge request=q1', 'Your request q1 is still open.'].join('\n');

// ─── The prompt-entry reader ─────────────────────────────────────────

describe('promptEntries (D3: record fields first)', () => {
  it('keeps prompts and folded steers; drops tool results, injected, sidechain, caveat, stdout and interrupts', () => {
    const tx = new Tx()
      .user('build the kestrel paywall').say('on it').write('/p/kestrel/paywall.tsx')
      .steer('also the coupon line')
      .meta('a skill body').notification().compactSummary().sidechain('a child prompt').caveat()
      .local('effort').interrupt();
    const entries = promptEntries(parseRecords(tx.jsonl()));
    const texts = entries.map((e) => e.text);
    expect(texts[0]).toBe('build the kestrel paywall');
    expect(texts).toContain('also the coupon line');
    expect(entries.find((e) => e.steer)?.text).toBe('also the coupon line');
    // The /effort stub is a prompt entry (its segment decides it is none), its stdout is not.
    expect(texts.some((t) => t.includes('<command-name>/effort'))).toBe(true);
    expect(texts.some((t) => /local-command|task-notification|Request interrupted|skill body|continued from|child prompt/.test(t))).toBe(false);
  });

  it('applies the text fallback only to a record with no provenance field', () => {
    const quoted = 'Base directory for this skill: /x — why does the header show twice?';
    const old = new Tx().user(quoted);
    expect(promptEntries(parseRecords(old.jsonl()))).toHaveLength(0);
    const stamped = new Tx().user(quoted, { entrypoint: 'cli' });
    expect(promptEntries(parseRecords(stamped.jsonl()))).toHaveLength(1);
  });

  it('a string-content entry with no uuid gets a hash of time, text and occurrence', () => {
    const tx = new Tx();
    tx.recs.push({ type: 'user', timestamp: '2026-11-20T10:00:00.000Z', message: { role: 'user', content: 'same words' } });
    tx.recs.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } });
    tx.recs.push({ type: 'user', timestamp: '2026-11-20T10:00:00.000Z', message: { role: 'user', content: 'same words' } });
    const [a, b] = promptEntries(parseRecords(tx.jsonl()));
    expect(a!.id).toMatch(/^h[0-9a-f]{20}$/);
    expect(a!.id).not.toBe(b!.id);
    expect(promptEntries(parseRecords(tx.jsonl()))[0]!.id).toBe(a!.id);
  });
});

describe('toolWrites (one extractor)', () => {
  it('reads Write/Edit/MultiEdit/NotebookEdit and apply_patch bodies, in order, deduplicated', () => {
    const frames = [
      { message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/a.ts' } }, { type: 'tool_use', name: 'Read', input: { file_path: '/r.ts' } }] } },
      { message: { content: [{ type: 'tool_use', name: 'NotebookEdit', input: { notebook_path: '/n.ipynb' } }, { type: 'tool_use', name: 'Edit', input: { file_path: '/a.ts' } }] } },
      { content: [{ type: 'tool_use', name: 'apply_patch', input: { patch: '*** Begin Patch\n*** Update File: /b.ts\n*** Add File: /c.ts\n*** End Patch' } }] },
    ];
    expect(toolWrites(frames)).toEqual(['/a.ts', '/n.ipynb', '/b.ts', '/c.ts']);
  });
});

// ─── The one rule (D3), entry by entry ─────────────────────────────

describe('classifyUserEntry precedence', () => {
  const c = (text: string, ctx: Partial<Parameters<typeof classifyUserEntry>[1]> = {}, steer = false) =>
    classifyUserEntry({ text, steer }, { openJob: null, first: false, segmentWorked: true, ...ctx });
  it('none by outcome, whatever the text', () => {
    expect(c('build it', { segmentWorked: false })).toBe('none');
    expect(c('<command-name>/goal-skill</command-name><command-args>a b</command-args>', { segmentWorked: false })).toBe('none');
  });
  it('a pure event batch is none even when it worked', () => {
    expect(c(nudgeBatch())).toBe('none');
  });
  it('first opens a job, whatever its text', () => {
    expect(c(LIMIT_CONTINUE_TEXT, { first: true })).toBe('ask');
    expect(c('Handoff: continue task x', { first: true })).toBe('ask');
  });
  it('server texts, steers, reply batches and a resubmit continue', () => {
    expect(c(LIMIT_CONTINUE_TEXT)).toBe('continuation');
    expect(c(`${ALLOW_TURN_HEAD} \`npm test\`.`)).toBe('continuation');
    expect(c(RESUME_TEXT)).toBe('continuation');
    expect(c('[ran in chat]\n$ ls')).toBe('continuation');
    expect(c('MCP connected: posthog')).toBe('continuation');
    expect(c('Stop hook feedback:\n[goal]: keep going')).toBe('continuation');
    expect(c('[super answer] yes')).toBe('continuation');
    expect(c(replyBatch('use the blue one'))).toBe('continuation');
    expect(c('x', {}, true)).toBe('continuation');
    expect(c('build it', { openJob: { lastAsk: 'build it', repliedSinceLastAsk: false } })).toBe('continuation');
  });
  it('everything else that worked asks', () => {
    expect(c('build it', { openJob: { lastAsk: 'build it', repliedSinceLastAsk: true } })).toBe('ask');
    expect(c(request('make the lumen board'))).toBe('ask');
    expect(c('[super schedule] daily')).toBe('ask');
    expect(c('/tmp/shot.png why is this red?')).toBe('ask');
  });
});

describe('deriveJobs: one job = one trace (criterion 2)', () => {
  it('an owner ask opens a job with did, files and status', () => {
    const tx = new Tx().user('build the kestrel paywall').say('starting').write('/p/paywall.tsx').say('Done: paywall built.');
    const { traces } = derive(tx);
    expect(traces).toHaveLength(1);
    const t = traces[0]!;
    expect(t).toMatchObject({ v: 1, kind: 'job', asks: [{ by: 'window', text: 'build the kestrel paywall' }], did: 'Done: paywall built.', files: ['/p/paywall.tsx'], status: 'ok', transcript: 'tx-1' });
    expect(t.id).toBe(traceId(t.key));
    expect(t.key.startsWith('tx-1:')).toBe(true);
  });

  it('labels an owner ask by the owner-words ledger', () => {
    const tx = new Tx().user('build the kestrel paywall').say('ok');
    expect(derive(tx, { ownerTexts: new Set(['build the kestrel paywall']) }).traces[0]!.asks[0]!.by).toBe('owner');
  });

  it('a Super request batch, a team send, a window send and a delegate brief each open one', () => {
    const tx = new Tx()
      .user(request('make the lumen board')).say('board made').write('/p/lumen/board.md')
      .user('team send: check the fjord funnel numbers').say('numbers checked')
      .user('a window send: rename the column').say('renamed')
      .user('You work in your own git worktree: /w/x. Build the export.').say('export built');
    const { traces } = derive(tx);
    expect(traces).toHaveLength(4);
    expect(traces[0]!.asks).toEqual([{ by: 'super', text: 'make the lumen board' }]);
    expect(traces[0]!.files).toEqual(['/p/lumen/board.md']);
    expect(traces[3]!.asks[0]!.by).toBe('super');
  });

  it('an Allow turn, a resubmit after a refusal, a continue text, receipts and a Stop hook turn join the asking job', () => {
    const tx = new Tx()
      .user('deploy the kestrel staging').toolCut()
      .user(`${ALLOW_TURN_HEAD} \`npm run deploy\`.`).write('/p/deploy.log').say('half one')
      .user('deploy the kestrel staging2').refusal()
      .user('deploy the kestrel staging2').edit('/p/b.ts').say('resubmitted')
      .user(LIMIT_CONTINUE_TEXT).write('/p/c.ts').say('continued')
      .user('[ran in chat]\n$ ls\nexit 0').say('saw it')
      .user('MCP connected: posthog').say('connected')
      .user('Stop hook feedback:\n[goal]: keep going').write('/p/d.ts').say('All deployed.');
    const { traces } = derive(tx);
    expect(traces.map((t) => t.asks[0]!.text)).toEqual(['deploy the kestrel staging', 'deploy the kestrel staging2']);
    expect(traces[0]!.files).toEqual(['/p/deploy.log']);
    expect(traces[1]!.files).toEqual(['/p/b.ts', '/p/c.ts', '/p/d.ts']);
    expect(traces[1]!.did).toBe('All deployed.');
  });

  it('a folded steer adds its ask to the open job', () => {
    const tx = new Tx().user('write the lumen copy').say('writing').steer('make it shorter').say('shorter copy done');
    const { traces } = derive(tx);
    expect(traces).toHaveLength(1);
    expect(traces[0]!.asks.map((a) => a.text)).toEqual(['write the lumen copy', 'make it shorter']);
  });

  it('/effort, /clear, /model and a pure event batch mid-job change no job', () => {
    const tx = new Tx()
      .user('audit the fjord funnel').say('step one').write('/p/a.md')
      .local('effort', 'Set effort to high').local('model', 'Set model').local('clear')
      .user(nudgeBatch()).say('still on it')
      .user(LIMIT_CONTINUE_TEXT).write('/p/b.md').say('Audit done.');
    const { traces } = derive(tx);
    expect(traces).toHaveLength(1);
    expect(traces[0]!.files).toEqual(['/p/a.md', '/p/b.md']);
    expect(traces[0]!.did).toBe('Audit done.');
  });

  it('/effort then a notification and the CLI\'s own turn: the work joins the open job (note 1)', () => {
    const tx = new Tx().user('run the kestrel report').say('started a background job')
      .local('effort', 'Set effort').notification().write('/p/report.md').say('Report ready.');
    const { traces } = derive(tx);
    expect(traces).toHaveLength(1);
    expect(traces[0]!.files).toEqual(['/p/report.md']);
    expect(traces[0]!.did).toBe('Report ready.');
  });

  it('a skill command with arguments opens its own job, mid-job too, its arguments the ask', () => {
    const tx = new Tx().user('fix the lumen header').say('fixed')
      .skill('goal-skill', 'ship the fjord export screen').write('/p/export.tsx').say('Export screen shipped.');
    const { traces } = derive(tx);
    expect(traces).toHaveLength(2);
    expect(traces[1]!.asks[0]!.text).toBe('ship the fjord export screen');
    expect(traces[1]!.files).toEqual(['/p/export.tsx']);
    expect(hookQueryOf('<command-message>goal-skill</command-message>\n<command-name>/goal-skill</command-name>\n<command-args>ship the fjord export screen</command-args>')).toBe('ship the fjord export screen');
  });

  it('an image-only message that worked opens a job; a quoted skill header with provenance too', () => {
    const tx = new Tx().image().say('That button is clipped; fixed it.').edit('/p/btn.css')
      .user('Base directory for this skill: shows twice, why?', { entrypoint: 'cli' }).say('Because of the loader.');
    const { traces } = derive(tx);
    expect(traces).toHaveLength(2);
    expect(traces[0]!.asks[0]!.text).toBe('(a picture)');
  });

  it('a job stopped before any text or file leaves none; ending on a tool call or an interrupt is interrupted', () => {
    expect(derive(new Tx().user('do x').think()).traces).toHaveLength(0);
    const cut = derive(new Tx().user('do y').say('starting').write('/p/y.ts').toolCut()).traces[0]!;
    expect(cut.status).toBe('interrupted');
    const stopped = derive(new Tx().user('do z').write('/p/z.ts').interrupt()).traces[0]!;
    expect(stopped.status).toBe('interrupted');
    const fine = derive(new Tx().user('do w').toolCut().say('done after all')).traces[0]!;
    expect(fine.status).toBe('ok');
  });

  it('a path-led owner message opens its own job mid-job, and the hook queries its whole text', () => {
    const text = '/tmp/kestrel-shot.png the price row is wrong here';
    const tx = new Tx().user('tune the kestrel paywall').say('tuned').user(text).say('row fixed').edit('/p/row.tsx');
    expect(derive(tx).traces).toHaveLength(2);
    expect(hookQueryOf(text)).toBe(text);
  });

  it('a relaunch-cut job and then RESUME_TEXT keep one trace (note 4)', () => {
    const tx = new Tx().user('migrate the lumen data').write('/p/m1.sql').toolCut().user(RESUME_TEXT).write('/p/m2.sql').say('Migrated.');
    const { traces } = derive(tx);
    expect(traces).toHaveLength(1);
    expect(traces[0]!.files).toEqual(['/p/m1.sql', '/p/m2.sql']);
  });

  it('a [super recap] continues and never overwrites did (note 3); a reply batch continues', () => {
    const tx = new Tx().user(request('price the fjord plan')).say('Priced at 9.99.')
      .user(replyBatch('yes, go')).say('Priced at 9.99, applied.')
      .user('[super recap] item=r1 children=2').say('Recap: two children done.');
    const { traces } = derive(tx);
    expect(traces).toHaveLength(1);
    expect(traces[0]!.did).toBe('Priced at 9.99, applied.');
  });

  it('a short confirmation opens its own job (build note)', () => {
    const tx = new Tx().user('propose the lumen fix').say('Proposal: swap A for B.').user('evet').edit('/p/fix.ts').say('Applied.');
    expect(derive(tx).traces).toHaveLength(2);
  });

  it('a handoff first entry takes the handoff title', () => {
    const tx = new Tx().user('Handoff: continue task kestrel-export. Read the task first.').say('Read it.').write('/p/x.ts');
    const t = derive(tx, { handoffTitle: 'Kestrel export' }).traces[0]!;
    expect(t.asks[0]!.text.startsWith('Kestrel export: Handoff: continue')).toBe(true);
  });

  it('a first entry that is a server text (an account-switch continue) asks, by server', () => {
    const t = derive(new Tx().user(LIMIT_CONTINUE_TEXT).write('/p/after-switch.ts').say('Continued.')).traces[0]!;
    expect(t.asks[0]!.by).toBe('server');
  });

  it('a turn read while running is classified again once it worked', () => {
    const tx = new Tx().user('first job').say('done one').user('second job');
    const half = derive(tx);
    expect(half.traces).toHaveLength(1);
    // The cursor never passes the unclosed none entry (note 6).
    const secondStart = promptEntries(parseRecords(tx.jsonl()))[1]!.start;
    expect(half.resumeAt).toBe(Math.min(secondStart, promptEntries(parseRecords(tx.jsonl()))[0]!.start));
    tx.say('done two').write('/p/two.ts');
    expect(derive(tx).traces.map((t) => t.asks[0]!.text)).toEqual(['first job', 'second job']);
  });

  it('a run\'s own session: entries before chatFrom are the run\'s, later ones are classified', () => {
    const tx = new Tx().user('Scheduled run of kestrel-digest.').say('digest written').write('/p/digest.md');
    const chatFrom = tx.t + 500;
    tx.user('now also mail it').say('mailed');
    const { traces } = derive(tx, { runSession: true, chatFrom });
    expect(traces).toHaveLength(1);
    expect(traces[0]!.asks[0]!.text).toBe('now also mail it');
    expect(derive(tx, { runSession: true, chatFrom: null }).traces).toHaveLength(0);
  });

  it('Codex and Antigravity string-content entries open jobs as Claude\'s do', () => {
    const tx = new Tx().user('build the fjord chart').say('chart built').write('/p/chart.ts').user('Stop hook feedback:\n[goal]: verify').say('verified');
    const ag = derive(asStringContent(tx));
    expect(ag.traces).toHaveLength(1);
    expect(ag.traces[0]!.files).toEqual(['/p/chart.ts']);
    expect(ag.traces[0]!.did).toBe('verified');
  });

  it('bounds by code points: did head and tail ≤ 900, ask ≤ 600, never a split pair', () => {
    const long = '😀'.repeat(2000);
    const t = derive(new Tx().user(long).say(long)).traces[0]!;
    expect(Array.from(t.did).length).toBeLessThanOrEqual(900);
    expect(Array.from(t.asks[0]!.text).length).toBeLessThanOrEqual(600);
    expect(t.did).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(headTail('a b', 900)).toBe('a b');
  });
});

describe('hookQueryOf (D3 hook half)', () => {
  it('skips a pure event batch, a server text and a bare command; keeps a request and command args', () => {
    expect(hookQueryOf(nudgeBatch())).toBeNull();
    expect(hookQueryOf(LIMIT_CONTINUE_TEXT)).toBeNull();
    expect(hookQueryOf('<command-name>/effort</command-name><command-args></command-args>')).toBeNull();
    expect(hookQueryOf('/model')).toBeNull();
    expect(hookQueryOf('/goal-skill ship the export')).toBe('ship the export');
    expect(hookQueryOf(request('make the lumen board'))).toBe('make the lumen board');
  });
  it('strips the server\'s owner-msg and Super blocks (note 7)', () => {
    const q = hookQueryOf('fix the kestrel price row\n<owner-msg ref=abc>fix the kestrel price row</owner-msg>\n<owner-language>tr</owner-language>');
    expect(q).toBe('fix the kestrel price row');
  });
});

// ─── The store, on a fake machine ───────────────────────────────────

describe('the store (D5, G1, C7)', () => {
  let m: Machine;
  beforeEach(() => { m = makeMachine(); });
  afterEach(() => m.dispose());

  const trace = (key: string, through: number, project = 'kestrel'): WorkTrace => ({
    v: 1, id: traceId(key), key, kind: 'job', at: '2026-11-20T10:00:00.000Z',
    project: { key: projectKey(m.project(project)), name: project, root: m.project(project) },
    asks: [{ by: 'owner', text: 'x' }], did: `did ${through}`, files: [], status: 'ok', through,
  });

  it('a fresh global member (no home folder yet) gets its work folder, 0600 files', async () => {
    globalMember(m, 'mira');
    expect(existsSync(join(m.home, '.dreamcontext', 'agents', 'mira'))).toBe(false);
    expect(await writeTrace({ slug: 'mira', projectRoot: m.project('kestrel'), home: m.home }, trace('a:1', 5))).toBe(true);
    const root = workRoot('mira', m.project('kestrel'), m.home)!;
    expect(root).toBe(join(m.home, '.dreamcontext', 'agents', 'mira', 'work'));
    const file = join(root, '2026-11', `${traceId('a:1')}.json`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(root, 'gen.log'), 'utf-8')).toContain(traceId('a:1'));
  });

  it('a project member writes under the project\'s local dir', async () => {
    projectMember(m, 'kestrel', 'oren');
    expect(await writeTrace({ slug: 'oren', projectRoot: m.project('kestrel'), home: m.home }, trace('b:1', 5))).toBe(true);
    expect(existsSync(join(localDir(m.project('kestrel'), m.home), 'work', 'oren', '2026-11'))).toBe(true);
  });

  it('an older read never replaces a newer trace', async () => {
    globalMember(m, 'mira');
    const t = { slug: 'mira', projectRoot: m.project('kestrel'), home: m.home };
    await writeTrace(t, trace('c:1', 10));
    expect(await writeTrace(t, trace('c:1', 4))).toBe(false);
    expect(readAllTraces(workRoot('mira', m.project('kestrel'), m.home)!)[0]!.did).toBe('did 10');
    expect(await writeTrace(t, trace('c:1', 12))).toBe(true);
  });

  it('refuses a linked work root, an unsafe slug and a member that is not here', async () => {
    globalMember(m, 'mira');
    mkdirSync(join(m.home, '.dreamcontext', 'agents', 'mira'), { recursive: true });
    const elsewhere = join(m.root, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(m.home, '.dreamcontext', 'agents', 'mira', 'work'));
    expect(await writeTrace({ slug: 'mira', projectRoot: m.project('kestrel'), home: m.home }, trace('d:1', 1))).toBe(false);
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(workRoot('../x', m.project('kestrel'), m.home)).toBeNull();
    expect(await writeTrace({ slug: 'ghost', projectRoot: m.project('kestrel'), home: m.home }, trace('d:2', 1))).toBe(false);
    expect(existsSync(join(m.home, '.dreamcontext', 'agents', 'ghost'))).toBe(false);
  });

  it('a deleted member\'s work goes; a late writer recreates nothing; a re-created member starts empty (criterion 9)', async () => {
    projectMember(m, 'kestrel', 'oren');
    const t = { slug: 'oren', projectRoot: m.project('kestrel'), home: m.home };
    await writeTrace(t, trace('e:1', 1));
    dropMemberWork('oren', m.project('kestrel'), m.home);
    rmSync(join(m.project('kestrel'), '_dream_context', 'agents', 'oren.md'));
    const dir = join(localDir(m.project('kestrel'), m.home), 'work', 'oren');
    expect(existsSync(dir)).toBe(false);
    expect(await writeTrace(t, trace('e:2', 1))).toBe(false);
    expect(await noteTranscript(t, 'sess-late', { tool: 'claude' })).toBe(false);
    expect(existsSync(dir)).toBe(false);
    projectMember(m, 'kestrel', 'oren');
    expect(readAllTraces(workRoot('oren', m.project('kestrel'), m.home)!)).toEqual([]);
  });

  it('a renamed project member keeps its traces; a writer with the old name writes under the new one', async () => {
    projectMember(m, 'kestrel', 'oren');
    await writeTrace({ slug: 'oren', projectRoot: m.project('kestrel'), home: m.home }, trace('f:1', 1));
    rmSync(join(m.project('kestrel'), '_dream_context', 'agents', 'oren.md'));
    projectMember(m, 'kestrel', 'orin');
    renameMemberWork('oren', 'orin', m.project('kestrel'), m.home);
    const root = workRoot('orin', m.project('kestrel'), m.home)!;
    expect(readAllTraces(root).map((x) => x.key)).toEqual(['f:1']);
    expect(await writeTrace({ slug: 'oren', projectRoot: m.project('kestrel'), home: m.home }, trace('f:2', 1))).toBe(true);
    expect(readAllTraces(root).map((x) => x.key).sort()).toEqual(['f:1', 'f:2']);
  });
});

describe('deriveTranscript (D4, criterion 10)', () => {
  let m: Machine;
  beforeEach(() => { m = makeMachine(); globalMember(m, 'mira'); });
  afterEach(() => m.dispose());
  const kestrel = () => m.project('kestrel');
  const all = () => readAllTraces(workRoot('mira', kestrel(), m.home)!);

  it('deriving twice adds nothing; a grown transcript adds only its new job', async () => {
    const tx = new Tx().user('build the kestrel paywall').say('built').write('/p/paywall.tsx');
    const p = putClaude(m, 'sess-1', tx.jsonl());
    expect(await deriveTranscript('mira', kestrel(), 'sess-1', { home: m.home })).toHaveLength(1);
    expect(await deriveTranscript('mira', kestrel(), 'sess-1', { home: m.home })).toHaveLength(0);
    tx.user('now the lumen copy').say('copy written');
    writeFileSync(p, tx.jsonl());
    await deriveTranscript('mira', kestrel(), 'sess-1', { home: m.home });
    expect(all().map((t) => t.asks[0]!.text).sort()).toEqual(['build the kestrel paywall', 'now the lumen copy']);
    // The cursor resumes at the open job's ask, never past it.
    const c = readCursor(workRoot('mira', kestrel(), m.home)!, 'sess-1')!;
    expect(c.from).toBeGreaterThan(0);
    // A job still running at the cursor's read is re-derived as it grows.
    tx.write('/p/copy.md').say('Copy written and saved.');
    appendFileSync(p, tx.recs.slice(-3).map((r) => JSON.stringify(r)).join('\n') + '\n');
    await deriveTranscript('mira', kestrel(), 'sess-1', { home: m.home });
    const copy = all().find((t) => t.asks[0]!.text === 'now the lumen copy')!;
    expect(copy.did).toBe('Copy written and saved.');
    expect(all()).toHaveLength(2);
  });

  it('two derivations at once write each job once', async () => {
    const tx = new Tx().user('job a').say('a').user('job b').say('b').user('job c').say('c');
    putClaude(m, 'sess-2', tx.jsonl());
    await Promise.all([1, 2, 3].map(() => deriveTranscript('mira', kestrel(), 'sess-2', { home: m.home })));
    expect(all()).toHaveLength(3);
  });

  it('a trace outlives its deleted transcript', async () => {
    const p = putClaude(m, 'sess-3', new Tx().user('job a').say('a').jsonl());
    await deriveTranscript('mira', kestrel(), 'sess-3', { home: m.home });
    rmSync(p);
    expect(await deriveTranscript('mira', kestrel(), 'sess-3', { home: m.home })).toEqual([]);
    expect(all()).toHaveLength(1);
  });

  it('one transcript reached as a listed id, a cursor and a pin successor is traced once', async () => {
    putClaude(m, 'old-pin', new Tx().user('job in the old half').say('old done').jsonl());
    putClaude(m, 'new-half', new Tx().user('Handoff: continue').say('new done').jsonl());
    recordAgentSession(kestrel(), 'mira', 'old-pin', 'chat', m.home);
    recordAgentSession(kestrel(), 'mira', 'new-half', 'chat', m.home);
    await noteTranscript({ slug: 'mira', projectRoot: kestrel(), home: m.home }, 'new-half', { tool: 'claude' });
    const list = transcriptsOf('mira', kestrel(), { home: m.home, successor: (id) => (id === 'old-pin' ? 'new-half' : null) });
    expect(list.map((t) => t.id).sort()).toEqual(['new-half', 'old-pin']);
    for (const t of [...list, ...list]) await deriveTranscript('mira', kestrel(), t.id, { home: m.home, tool: t.tool, path: t.path });
    expect(all().map((t) => t.transcript).sort()).toEqual(['new-half', 'old-pin']);
  });

  it('a cursor of another project is not this project\'s transcript', async () => {
    putClaude(m, 'sess-lumen', new Tx().user('x').say('y').jsonl());
    await noteTranscript({ slug: 'mira', projectRoot: m.project('lumen'), home: m.home }, 'sess-lumen', { tool: 'claude' });
    expect(transcriptsOf('mira', kestrel(), { home: m.home }).map((t) => t.id)).toEqual([]);
    expect(transcriptsOf('mira', m.project('lumen'), { home: m.home }).map((t) => t.id)).toEqual(['sess-lumen']);
  });

  it('a run is not traced again from its own session (entries before chatFrom)', async () => {
    const tx = new Tx().user('Scheduled run of kestrel-digest.').say('digest written');
    putClaude(m, 'run-sess', tx.jsonl());
    const runSession = () => ({ run: true as const, endedAt: tx.t + 10 });
    expect(await deriveTranscript('mira', kestrel(), 'run-sess', { home: m.home, runSession })).toEqual([]);
  });

  it('Codex: the rollout is read under its own thread id; a converter dropping one more kind keeps the keys', async () => {
    const thread = '019a0000-0000-7000-8000-00000000abcd';
    const r = new Rollout().user('build the fjord export').say('export built').patch('/p/export.ts');
    putCodex(m, thread, r.text());
    expect(locateTranscript(thread, 'codex', m.home)?.tool).toBe('codex');
    const first = await deriveTranscript('mira', kestrel(), thread, { home: m.home, tool: 'codex' });
    expect(first).toHaveLength(1);
    expect(first[0]!.files).toEqual(['/p/export.ts']);
    // An injected record the converter drops does not shift the owner entry's key.
    const r2 = new Rollout().injected('<environment_context>cwd</environment_context>').user('build the fjord export').say('export built').patch('/p/export.ts');
    r2.lines = [r2.lines[0]!, ...r.lines];
    putCodex(m, thread, r2.text());
    const again = deriveJobs(parseRecords(readTranscriptText(locateTranscript(thread, 'codex', m.home)!.path)), { transcriptId: thread, project: PROJECT });
    expect(again.traces[0]!.key).toBe(first[0]!.key);
  });

  it('Antigravity: the bridge file is read under its own thread id', async () => {
    const tx = new Tx().user('draft the lumen mail').say('drafted').write('/p/mail.md');
    putAntigravity(m, 'ag-thread-1', asStringContent(tx));
    const out = await deriveTranscript('mira', kestrel(), 'ag-thread-1', { home: m.home, tool: 'antigravity' });
    expect(out).toHaveLength(1);
    expect(out[0]!.key.startsWith('ag-thread-1:h')).toBe(true);
  });
});

describe('a run\'s trace (C4 runner)', () => {
  let m: Machine;
  beforeEach(() => { m = makeMachine(); globalMember(m, 'mira'); });
  afterEach(() => m.dispose());

  it('a run whose child ran leaves one trace with D2\'s fields, its files from its own session', async () => {
    putClaude(m, 'run-1', new Tx().user('Scheduled run').write('/p/digest.md').say('Digest sent.').jsonl());
    const input = {
      member: 'mira', projectRoot: m.project('kestrel'), slug: 'kestrel-digest', fireIso: '2026-11-20T09:00:00.000Z',
      finishedAt: new Date('2026-11-20T09:05:00.000Z'), ask: { by: 'schedule' as const, text: 'Kestrel digest: send it' },
      result: 'Digest sent.', document: null, status: 'ok', sessionId: 'run-1', tool: 'claude' as const, home: m.home,
    };
    expect(await writeRunTrace(input)).toBe(true);
    expect(await writeRunTrace(input)).toBe(true);
    const all = readAllTraces(workRoot('mira', m.project('kestrel'), m.home)!);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ kind: 'run', key: 'run:kestrel-digest:2026-11-20T09:00:00.000Z', runKey: 'run:kestrel-digest:2026-11-20T09:00:00.000Z', files: ['/p/digest.md'], status: 'ok', did: 'Digest sent.' });
  });

  it('a refused run (a usage limit, an API error) stores no did: with no file written it leaves none', () => {
    const base = {
      member: 'mira', projectRoot: m.project('kestrel'), slug: 's', fireIso: '2026-11-20T09:00:00.000Z', finishedAt: new Date(),
      ask: { by: 'schedule' as const, text: 'weekly price watch' }, document: 'You have hit your usage limit', status: 'failed', sessionId: null, tool: 'claude' as const, home: m.home,
    };
    expect(buildRunTrace({ ...base, result: 'You have hit your usage limit. It resets at 3pm.', refused: true })).toBeNull();
    expect(buildRunTrace({ ...base, result: 'API Error: 529 overloaded' })).toBeNull();
    // A failure with a real reason is still work.
    expect(buildRunTrace({ ...base, result: 'The pricing page moved; I could not read vexa this week.', document: null })?.did).toContain('pricing page moved');
  });

  it('a run with no result and no written file leaves none', () => {
    expect(buildRunTrace({
      member: 'mira', projectRoot: m.project('kestrel'), slug: 's', fireIso: '2026-11-20T09:00:00.000Z', finishedAt: new Date(),
      ask: { by: 'schedule', text: 'x' }, result: null, document: null, status: 'failed', sessionId: null, tool: 'claude', home: m.home,
    })).toBeNull();
  });
});
