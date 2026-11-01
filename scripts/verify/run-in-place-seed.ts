/**
 * The fixtures of scripts/verify/run-in-place.mjs, written through the app's own library under the
 * scratch HOME (`tsx run-in-place-seed.ts <project> <verb>`). A fictional project and member only.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createAgent } from '../../src/lib/agents/store.js';
import { createQuestion } from '../../src/lib/automations/hitl.js';
import { recordAutomationSession } from '../../src/lib/automations/session-registry.js';
import { noteRunSession } from '../../src/lib/automations/run-session.js';
import { recordRun, writeRunSidecar } from '../../src/lib/automations/store.js';
import { appendThreadEntry } from '../../src/lib/automations/threads.js';
import { recordTeamJob } from '../../src/lib/super/team.js';
import { updateSuperState } from '../../src/lib/super/store.js';
import type { RunEvent } from '../../src/lib/automations/types.js';
import { claudeProjectDirName } from '../../src/lib/transcript-sessions.js';

const [proj, verb, arg] = process.argv.slice(2);
const ctx = join(proj, '_dream_context');
const home = homedir();
const SLUG = 'lookout';
export const TOKEN = 'FIXTURE-TOKEN-5f3a';
const PROMPT_MARK = 'COMPOSED-PROMPT-MARK';

const ids = { bound: '11111111-1111-4111-8111-111111111111', live: '22222222-2222-4222-8222-222222222222', asked: '33333333-3333-4333-8333-333333333333' };
const ago = (min: number): string => new Date(Date.now() - min * 60_000).toISOString();

const transcriptOf = (id: string): string => {
  const dir = join(home, '.claude', 'projects', claudeProjectDirName(proj));
  mkdirSync(dir, { recursive: true });
  return join(dir, `${id}.jsonl`);
};
const row = (id: string, o: Record<string, unknown>): void => {
  appendFileSync(transcriptOf(id), `${JSON.stringify({ ...o, cwd: proj, sessionId: id, uuid: `${id}-${Math.random()}`, timestamp: new Date().toISOString() })}\n`);
};
const said = (id: string, words: string): void => row(id, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: words }] } });
const bash = (id: string, n: number): void => {
  row(id, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${n}`, name: 'Bash', input: { command: `curl -H "Authorization: ${TOKEN}" https://acme.example/${n}` } }] } });
  row(id, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${n}`, content: `reply ${TOKEN}` }] } });
};
const opened = (id: string): void => row(id, { type: 'user', message: { role: 'user', content: `${PROMPT_MARK} watch the Acme line ${TOKEN}` } });

function run(firedAt: string, over: Partial<RunEvent>, result: string | null, event = 'ok', text = 'Finished in 1m 16s.'): void {
  appendThreadEntry(ctx, SLUG, { runId: firedAt, kind: 'system', event: 'started', text: 'Run started.', via: 'runner' });
  appendThreadEntry(ctx, SLUG, { runId: firedAt, kind: 'system', event: event as 'ok', text, via: 'runner', ...(result ? { result } : {}) });
  recordRun(ctx, SLUG, { firedAt, startedAt: firedAt, status: event === 'ok' ? 'ok' : 'failed', durationMs: 76_000, sessionId: null, outputPath: null, error: null, costUsd: 0, numTurns: 1, permissionDenials: 0, ...over } as RunEvent);
}

function doc(name: string, body: string): string {
  const dir = join(ctx, 'automations', 'output', SLUG);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
}

async function seed(): Promise<void> {
  createAgent(ctx, { slug: SLUG, title: 'Lookout', prompt: 'Lookout watches the fictional Acme line.', learning: false }, { approve: { now: new Date(), home } });

  // Answered, posted nothing, published a document; a real session this machine bound.
  const bound = ago(180);
  opened(ids.bound); said(ids.bound, 'RUN-WORDS checked the Acme line.'); bash(ids.bound, 1); said(ids.bound, 'RUN-WORDS three messages sent.');
  run(bound, { sessionId: ids.bound, outputPath: doc('bound.md', '# Acme report\n\nACME-REPORT-BODY three messages sent.\n') }, 'Acme is healthy: 3 messages sent.');
  recordAutomationSession(SLUG, ids.bound, home, Date.now(), undefined, bound);

  // No session at all: a light run. Its full report must open all the same.
  const light = ago(120);
  run(light, { outputPath: doc('light.md', '# Light report\n\nLIGHT-REPORT-BODY no steps here.\n') }, 'Light check: nothing changed.');

  // A failure with no session.
  run(ago(100), {}, null, 'failed', 'The Acme line did not answer.');

  // A question waiting on its run.
  const asked = ago(90);
  opened(ids.asked); said(ids.asked, 'RUN-WORDS which line?');
  appendThreadEntry(ctx, SLUG, { runId: asked, kind: 'system', event: 'started', text: 'Run started.', via: 'runner' });
  recordRun(ctx, SLUG, { firedAt: asked, startedAt: asked, status: 'awaiting-review', durationMs: 1000, sessionId: ids.asked, outputPath: null, error: null, costUsd: 0, numTurns: 1, permissionDenials: 0 } as RunEvent);
  recordAutomationSession(SLUG, ids.asked, home, Date.now(), undefined, asked);
  createQuestion(ctx, { slug: SLUG, runFiredAt: asked, sessionId: ids.asked, kind: 'flow-hitl', channel: 'chat', question: 'Which line should I watch?', choices: ['Line A', 'Line B'] } as never);

  // Running now: a live child, the session known only from its hook's note.
  const live = ago(2);
  opened(ids.live); said(ids.live, 'RUN-WORDS started the sweep.'); bash(ids.live, 2);
  appendThreadEntry(ctx, SLUG, { runId: live, kind: 'system', event: 'started', text: 'Run started.', via: 'runner' });
  noteRunSession(ctx, SLUG, live, ids.live, Date.now(), home);
  const child = spawn('sleep', ['900'], { detached: true, stdio: 'ignore' });
  child.unref();
  writeRunSidecar(ctx, SLUG, { slug: SLUG, runnerPid: child.pid!, childPid: child.pid!, childPgid: child.pid!, fireAt: live, startedAt: live, timeoutAt: new Date(Date.now() + 1_800_000).toISOString() } as never);
  process.stdout.write(`${JSON.stringify({ bound, light, live, asked, sleep: child.pid })}\n`);
}

const verbs: Record<string, () => void | Promise<void>> = {
  seed,
  /** A step of the running run lands. */
  step: () => { said(ids.live, `RUN-WORDS live step ${arg}.`); },
  /** A routine fires while the owner types. */
  fire: () => {
    const at = new Date().toISOString();
    appendThreadEntry(ctx, SLUG, { runId: at, kind: 'system', event: 'started', text: 'Run started.', via: 'runner' });
    appendThreadEntry(ctx, SLUG, { runId: at, kind: 'system', event: 'ok', text: 'Finished.', via: 'runner', result: 'A routine fired meanwhile.' });
  },
  /** The manifest-diff ask: the reply route refuses while it is open. */
  approval: () => { createQuestion(ctx, { slug: SLUG, runFiredAt: new Date().toISOString(), sessionId: null, kind: 'approval', channel: 'chat', question: 'Approve the change?', choices: [] } as never); },
  question: () => { createQuestion(ctx, { slug: SLUG, runFiredAt: arg, sessionId: ids.asked, kind: 'flow-hitl', channel: 'chat', question: 'Which line next?', choices: ['Line C', 'Line D'] } as never); },
  team: async () => {
    await updateSuperState(ctx, (s) => {
      recordTeamJob(s, { id: 'team-verify-000001', member: SLUG, runId: arg, jobKind: 'run', queued: false, brief: 'Check the line', startedAt: Date.now() - 60_000 } as never);
    });
  },
};

await verbs[verb]();
