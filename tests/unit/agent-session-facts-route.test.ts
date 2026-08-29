/**
 * `GET /api/agent/session-facts` (src/server/routes/agent-shelf.ts) — the branch and worktree
 * marker on the chat shelf's resting tag line.
 *
 * The property under test is the one the route got WRONG until 2026-08-24: it answered for
 * the folder the app has open rather than for the checkout the SESSION is working in. So every
 * case here drives the real handler against real git repositories and real `git worktree add`,
 * with the session registry in the state a live `EnterWorktree` frame would have left it in.
 *
 * The compatibility arms matter as much as the new behaviour. A caller that sends no session
 * id — a fresh pane, a resumed conversation the server has seen no frame from, the terminal
 * view — must still get the project root's branch rather than nothing.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleAgentSessionFacts, resolveSessionDir } from '../../src/server/routes/agent-shelf.js';
import type { SessionFacts } from '../../src/lib/session-facts.js';
import { resetSessionFactsCaches } from '../../src/lib/session-facts.js';
import { enterSessionCheckout, exitSessionCheckout, resetSessionCheckouts } from '../../src/lib/session-cwd.js';
import { resetTranscriptCheckoutCaches } from '../../src/lib/session-transcript-cwd.js';
import { recordSessionEdit, resetSessionEdits } from '../../src/lib/session-edits.js';

function gitAvailable(): boolean {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}
const HAS_GIT = gitAvailable();

const SCRATCH = mkdtempSync(join(tmpdir(), 'dc-facts-route-'));
afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  delete process.env.DREAMCONTEXT_DESKTOP;
});

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/** A real repo with a `_dream_context/` beside the code, i.e. the default vault layout the
 *  route's `projectRootOf` is written for. */
function makeProject(name: string, branch: string): { root: string; contextRoot: string } {
  const root = join(SCRATCH, name);
  mkdirSync(join(root, '_dream_context'), { recursive: true });
  git(root, 'init', '-q', '-b', branch);
  git(root, 'config', 'user.email', 'verify@example.com');
  git(root, 'config', 'user.name', 'Verify');
  writeFileSync(join(root, 'README.md'), '# fixture\n', 'utf-8');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-qm', 'initial');
  return { root, contextRoot: join(root, '_dream_context') };
}

function addWorktree(root: string, name: string, branch: string): string {
  const path = join(SCRATCH, name);
  git(root, 'worktree', 'add', '-q', '-b', branch, path);
  return path;
}

function fakeRes(): { res: ServerResponse; captured: { status: number; body: unknown } } {
  const captured = { status: 0, body: null as unknown };
  const res = {
    writeHead(status: number) { captured.status = status; return this; },
    end(payload?: string) { captured.body = payload ? JSON.parse(payload) : null; },
  } as unknown as ServerResponse;
  return { res, captured };
}

async function get(contextRoot: string | null, session?: string): Promise<SessionFacts> {
  const qs = session === undefined ? '' : `?session=${encodeURIComponent(session)}`;
  const req = {
    url: `/api/agent/session-facts${qs}`,
    headers: { host: '127.0.0.1:1234' },
  } as unknown as IncomingMessage;
  const { res, captured } = fakeRes();
  await handleAgentSessionFacts(req, res, {}, contextRoot);
  expect(captured.status).toBe(200);
  return captured.body as SessionFacts;
}

const SESSION_A = '11111111-2222-3333-4444-555555555555';
const SESSION_B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe.skipIf(!HAS_GIT)('GET /api/agent/session-facts', () => {
  beforeEach(() => {
    process.env.DREAMCONTEXT_DESKTOP = '1';
    resetSessionCheckouts();
    resetSessionFactsCaches();
    resetTranscriptCheckoutCaches();
    resetSessionEdits();
  });

  it('carries the write-location warning, composed OUTSIDE the git memo', async () => {
    const { root, contextRoot } = makeProject('elsewhere-route', 'main');
    const wt = addWorktree(root, 'elsewhere-route-wt', 'feat/written-in');

    const quiet = await get(contextRoot, SESSION_A);
    expect(quiet.elsewhere).toBeNull();

    recordSessionEdit(SESSION_A, join(wt, 'src.ts'), root);
    const warned = await get(contextRoot, SESSION_A);
    // Composed per request: the git reading above is memoized for 12s, and had `elsewhere`
    // ridden along with it this second call would still say null.
    expect(warned.elsewhere?.name).toBe('elsewhere-route-wt');
    expect(warned.elsewhere?.count).toBe(1);
    // The chip's own reading is UNCHANGED — a warning, never a move.
    expect(warned.branch).toBe('main');
    expect(warned.worktree).toBe(false);

    // Another session wrote nothing, and a caller with no id has no session to warn about.
    expect((await get(contextRoot, SESSION_B)).elsewhere).toBeNull();
    expect((await get(contextRoot)).elsewhere).toBeNull();
  });

  it('with NO session id, answers for the project root — the pre-existing behaviour', async () => {
    const { root, contextRoot } = makeProject('no-id', 'main');
    addWorktree(root, 'no-id-wt', 'feat/elsewhere');

    const facts = await get(contextRoot);
    expect(facts.isRepo).toBe(true);
    expect(facts.branch).toBe('main');
    expect(facts.worktree).toBe(false);
    expect(facts.worktreeName).toBeNull();
  });

  it('with an id the server has seen no move from, also answers for the project root', async () => {
    const { contextRoot } = makeProject('unmoved', 'main');
    expect((await get(contextRoot, SESSION_A)).branch).toBe('main');
  });

  it('after the session enters a worktree, it answers for the WORKTREE', async () => {
    const { root, contextRoot } = makeProject('moved', 'main');
    const wt = addWorktree(root, 'moved-wt', 'fix/pushme-streak-paused-contradiction');
    expect(enterSessionCheckout(SESSION_A, wt, root)).toBe(true);

    const facts = await get(contextRoot, SESSION_A);
    expect(facts.branch).toBe('fix/pushme-streak-paused-contradiction');
    expect(facts.worktree).toBe(true);
    expect(facts.worktreeName).toBe('moved-wt');
    expect(facts.mainRoot).not.toBeNull();
  });

  it('two sessions in two worktrees get two different branches from the same project', async () => {
    const { root, contextRoot } = makeProject('two', 'main');
    const one = addWorktree(root, 'two-wt-a', 'feat/a');
    const two = addWorktree(root, 'two-wt-b', 'feat/b');
    enterSessionCheckout(SESSION_A, one, root);
    enterSessionCheckout(SESSION_B, two, root);

    expect((await get(contextRoot, SESSION_A)).branch).toBe('feat/a');
    expect((await get(contextRoot, SESSION_B)).branch).toBe('feat/b');
    // …and a third pane that never moved still reads the root.
    expect((await get(contextRoot)).branch).toBe('main');
  });

  it('a session param that is not a UUID is ignored, not used as a key', async () => {
    const { root, contextRoot } = makeProject('hostile', 'main');
    const wt = addWorktree(root, 'hostile-wt', 'feat/hostile');
    // Register the move under the hostile string itself: if the route used the raw param, this
    // is the entry it would find.
    const raw = '../../etc';
    enterSessionCheckout(raw, wt, root);

    for (const bad of [raw, '', 'not-a-uuid', 'a'.repeat(200)]) {
      expect((await get(contextRoot, bad)).branch, bad).toBe('main');
    }
  });

  it('off-desktop and no-project both answer the unknown shape, never a 500', async () => {
    const { contextRoot } = makeProject('gated', 'main');

    expect(await get(null, SESSION_A)).toMatchObject({ isRepo: false, branch: null });

    delete process.env.DREAMCONTEXT_DESKTOP;
    expect(await get(contextRoot, SESSION_A)).toMatchObject({ isRepo: false, branch: null });
  });

  it('a contextRoot that is already the project root is handled too (full-repo layout)', async () => {
    const { root } = makeProject('full-repo', 'main');
    expect((await get(root)).branch).toBe('main');
  });
});

/**
 * WHICH source wins — the ORDER, which is the whole behaviour of `resolveSessionDir`.
 *
 * The tool-frame registry (`session-cwd.ts`) is precise about the moves it can see and blind to
 * every other one: a manual `git worktree add` + `cd`, a plain `git checkout -b`, and a `cd`
 * back OUT of a worktree it is still holding. The transcript sees all of them, so it wins where
 * the two disagree. Above BOTH sits the agent's own CLAIM (server/checkout-directive.ts), which
 * is the only source that can describe work happening where the session is not standing — the
 * one thing neither observer can report. Every case below is one of those disagreements.
 */
describe.skipIf(!HAS_GIT)('resolveSessionDir — claim, then transcript, then tool frames', () => {
  beforeEach(() => {
    resetSessionCheckouts();
    resetSessionFactsCaches();
    resetTranscriptCheckoutCaches();
  });

  function makeHome(name: string): string {
    const home = join(SCRATCH, name);
    mkdirSync(join(home, '.claude', 'projects', 'p'), { recursive: true });
    return home;
  }
  function writeTranscript(home: string, id: string, cwd: string): void {
    writeFileSync(
      join(home, '.claude', 'projects', 'p', `${id}.jsonl`),
      JSON.stringify({ type: 'assistant', cwd, message: { content: [] } }) + '\n',
      'utf-8',
    );
  }

  it('follows a move the registry NEVER SAW — the manual `git worktree add` + `cd`', () => {
    // The owner's 2026-08-25 screenshot: a whole run in `eur-multicurrency` under a tag that
    // still read `main`, because no EnterWorktree frame was ever emitted.
    const { root } = makeProject('order-manual', 'main');
    const wt = addWorktree(root, 'order-manual-wt', 'feat/eur-multicurrency');
    const home = makeHome('order-manual-home');
    writeTranscript(home, SESSION_A, wt);

    expect(resolveSessionDir(SESSION_A, root, { home })).toBe(realpathSync(wt));
  });

  it('follows a `cd` back OUT of a worktree the registry is still holding', () => {
    const { root } = makeProject('order-back-out', 'main');
    const wt = addWorktree(root, 'order-back-out-wt', 'feat/left');
    expect(enterSessionCheckout(SESSION_A, wt, root)).toBe(true);
    const home = makeHome('order-back-out-home');
    writeTranscript(home, SESSION_A, root);

    // The registry says the worktree; the transcript says the session came home. The transcript
    // is the one that observed the session rather than one tool call inside it.
    expect(resolveSessionDir(SESSION_A, root, { home })).toBe(realpathSync(root));
  });

  it('falls back to the REGISTRY when the transcript has nothing to say', () => {
    // The window between a tool result crossing the stream and the CLI flushing its transcript,
    // and the standing case of a conversation with no transcript at all.
    const { root } = makeProject('order-fallback', 'main');
    const wt = addWorktree(root, 'order-fallback-wt', 'feat/registry-only');
    expect(enterSessionCheckout(SESSION_A, wt, root)).toBe(true);
    const home = makeHome('order-fallback-home');

    expect(resolveSessionDir(SESSION_A, root, { home })).toBe(wt);
  });

  it('a CLAIM outranks the transcript — the case neither observer can see', () => {
    // The agent stands in the vault (cwd says so, truthfully) and does its work in a worktree.
    // If the transcript won here, the declaration could only ever restate what was already
    // known, and the shelf would keep naming the checkout the work is NOT in.
    const { root } = makeProject('order-claim', 'main');
    const wt = addWorktree(root, 'order-claim-wt', 'feat/declared');
    const home = makeHome('order-claim-home');
    writeTranscript(home, SESSION_A, root);

    expect(enterSessionCheckout(SESSION_A, wt, root, { claim: true })).toBe(true);
    expect(resolveSessionDir(SESSION_A, root, { home })).toBe(wt);
  });

  it('a WITHDRAWN claim hands the answer straight back to the transcript', () => {
    const { root } = makeProject('order-withdraw', 'main');
    const wt = addWorktree(root, 'order-withdraw-wt', 'feat/declared');
    const home = makeHome('order-withdraw-home');
    writeTranscript(home, SESSION_A, root);

    enterSessionCheckout(SESSION_A, wt, root, { claim: true });
    exitSessionCheckout(SESSION_A);
    expect(resolveSessionDir(SESSION_A, root, { home })).toBe(realpathSync(root));
  });

  it('an OBSERVED move does not outrank the transcript — only a claim does', () => {
    // The distinction the `claim` flag exists for: same registry, same directory, different
    // authority. A frame is an observation the transcript also made (and made later).
    const { root } = makeProject('order-observed', 'main');
    const wt = addWorktree(root, 'order-observed-wt', 'feat/observed');
    const home = makeHome('order-observed-home');
    writeTranscript(home, SESSION_A, root);

    enterSessionCheckout(SESSION_A, wt, root); // no claim
    expect(resolveSessionDir(SESSION_A, root, { home })).toBe(realpathSync(root));
  });

  it('reports writes that landed in ANOTHER checkout — and does not follow them', () => {
    // The owner's question, 2026-08-28: what if the agent never says anything? The route
    // answers with the checkout the session is in, MARKED with where the writes actually went.
    const { root } = makeProject('order-elsewhere', 'main');
    const wt = addWorktree(root, 'order-elsewhere-wt', 'feat/written-in');
    const home = makeHome('order-elsewhere-home');
    resetSessionEdits();
    recordSessionEdit(SESSION_A, join(wt, 'src.ts'), root);

    // The checkout is unchanged — this is a warning, not a move.
    expect(resolveSessionDir(SESSION_A, root, { home })).toBe(root);
  });

  it('falls back to the PROJECT ROOT when neither source knows anything', () => {
    const { root } = makeProject('order-nothing', 'main');
    const home = makeHome('order-nothing-home');
    expect(resolveSessionDir(SESSION_B, root, { home })).toBe(root);
    expect(resolveSessionDir(null, root, { home })).toBe(root);
  });

  it('refuses a transcript pointing at a FOREIGN repo and keeps the registry answer', () => {
    const { root } = makeProject('order-foreign', 'main');
    const wt = addWorktree(root, 'order-foreign-wt', 'feat/mine');
    expect(enterSessionCheckout(SESSION_A, wt, root)).toBe(true);
    const foreign = makeProject('order-foreign-other', 'main');
    const home = makeHome('order-foreign-home');
    writeTranscript(home, SESSION_A, foreign.root);

    // A refused transcript degrades to the previous answer, never to a wrong new one.
    expect(resolveSessionDir(SESSION_A, root, { home })).toBe(wt);
  });
});
