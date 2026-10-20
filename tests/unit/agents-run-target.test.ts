/**
 * The run path picks its target (wave 3a, lane T3).
 *
 *   1. `runAutomation(…, { target: 'agent' })` runs the agent's CALL target even when a same-slug
 *      automation exists, and checks it for the strict `'run'` use: a binding's approval lends the
 *      agent its identity for conversations only, and the refusal names the Agents page, never a
 *      command. Without `target`, the slug still runs what `getAutomation` resolves (the job).
 *   2. A5b: a synced STRIP of a migrated call agent's call settings, with a bound and approved
 *      automation, blocks `'run'` while `'identity'` still passes; the targets and briefings of
 *      `prepareAgentChat` / `prepareCardChat` never carry output instructions, a flow or an
 *      output folder.
 *   3. The feed names the agent behind every message and roster row.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import matter from 'gray-matter';
import { runAutomation, type SpawnImpl } from '../../src/lib/automations/runner.js';
import {
  createAutomation, deriveFlowFromManifest, getAutomation, getRunTarget, lockPathFor, writeFlowSection,
} from '../../src/lib/automations/store.js';
import { queuedFire } from '../../src/lib/automations/queue.js';
import { createQuestion, listQuestions, pendingQuestionFor } from '../../src/lib/automations/hitl.js';
import { recordAutomationSession } from '../../src/lib/automations/session-registry.js';
import { resumeWithAnswer } from '../../src/lib/automations/verdict.js';
import { approveAutomation, checkApproval } from '../../src/lib/automations/registry.js';
import { buildFeed, buildFeedMessage } from '../../src/lib/automations/feed.js';
import { agentPath, createAgent } from '../../src/lib/agents/store.js';
import { splitLegacyManifest } from '../../src/lib/agents/split.js';
import { DEFAULT_CALL_SETTINGS } from '../../src/lib/agents/types.js';
import { prepareAgentChat, prepareCardChat } from '../../src/lib/whiteboards/card-chat.js';
import { createWhiteboard } from '../../src/lib/whiteboards/store.js';
import type { AutomationManifest } from '../../src/lib/automations/types.js';

let projectRoot: string;
let contextRoot: string;
let home: string;
const NOW = new Date('2026-10-12T09:00:00.000Z');

const CLAUDE_JSON_OK = JSON.stringify({
  session_id: 'sess_target', result: '# Done\n\nAll good.\n', is_error: false, permission_denials: [],
  total_cost_usd: 0.01, num_turns: 2, duration_ms: 1000, subtype: 'success',
});

/** A spawn that records each argv and answers with `json`; the prompt is the `-p` value. */
function capturingSpawn(json: string) {
  const calls: string[][] = [];
  const impl = vi.fn((_cmd: string, args: string[]) => {
    calls.push(args);
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = Object.assign(new EventEmitter(), { pid: 4242, stdout, stderr, kill: () => {} });
    setImmediate(() => { stdout.emit('data', Buffer.from(json, 'utf-8')); child.emit('close', 0); });
    return child;
  }) as unknown as SpawnImpl;
  return { impl, calls, prompt: (i = 0) => calls[i][calls[i].indexOf('-p') + 1] };
}

function target(slug: string, kind: 'agent' | 'automation'): AutomationManifest {
  const t = getRunTarget(contextRoot, slug, kind);
  if (!t) throw new Error(`no ${kind} target for ${slug}`);
  return t;
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-agents-run-target-'));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'automations'), { recursive: true });
  home = mkdtempSync(join(tmpdir(), 'dc-agents-run-target-home-'));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("runAutomation picks the target, and an agent's call target needs a direct grant", () => {
  /** Same-slug pair `scout`: an agent nobody approved directly, and its approved daily job. */
  function seedPair(): void {
    createAgent(contextRoot, { slug: 'scout', title: 'Scout', prompt: 'Scout the market for new entrants.' });
    createAutomation(
      contextRoot,
      { slug: 'scout', title: 'Scout daily', agent: 'scout', days: 'daily', at: '09:00', job: 'Do the daily part.' },
      { approve: { now: NOW, home } },
    );
  }

  it('without a target, the slug runs its job: the agent prompt, then THIS JOB', async () => {
    seedPair();
    const spawn = capturingSpawn(CLAUDE_JSON_OK);
    const outcome = await runAutomation(contextRoot, 'scout', { home, spawnImpl: spawn.impl, now: () => NOW, fireAt: NOW });
    expect(outcome.status).toBe('ok');
    const prompt = spawn.prompt();
    expect(prompt).toContain('Scout the market for new entrants.');
    expect(prompt).toContain('--- THIS JOB ---');
    expect(prompt).toContain('Do the daily part.');
  });

  it("target 'agent' is blocked on the job's approval alone, naming the Agents page and no command", async () => {
    seedPair();
    expect(checkApproval(projectRoot, target('scout', 'agent'), home, 'identity').approved).toBe(true);
    const spawn = capturingSpawn(CLAUDE_JSON_OK);
    const outcome = await runAutomation(contextRoot, 'scout', {
      home, spawnImpl: spawn.impl, now: () => NOW, fireAt: NOW, target: 'agent',
    });
    expect(outcome.status).toBe('blocked');
    expect(outcome.error).toContain('Scout needs approval on the AI Team page');
    expect(outcome.error).not.toContain('automations approve');
    expect(outcome.error).not.toContain('agents approve');
    expect(spawn.calls).toHaveLength(0);
  });

  it("target 'agent' runs the call target once it is approved directly, never the job, and the job stays approved", async () => {
    seedPair();
    approveAutomation(projectRoot, target('scout', 'agent'), NOW, home);
    const spawn = capturingSpawn(CLAUDE_JSON_OK);
    const outcome = await runAutomation(contextRoot, 'scout', {
      home, spawnImpl: spawn.impl, now: () => NOW, fireAt: NOW, target: 'agent',
    });
    expect(outcome.status).toBe('ok');
    const prompt = spawn.prompt();
    expect(prompt).toContain('Scout the market for new entrants.');
    expect(prompt).not.toContain('THIS JOB');
    expect(prompt).not.toContain('Do the daily part.');
    // The agent's grant never overwrote the job's record in the same slot.
    expect(checkApproval(projectRoot, target('scout', 'automation'), home).approved).toBe(true);
  });

  it('a lock-busy agent-target run is deferred and NOT queued: a replayed bare slug would fire the job', async () => {
    seedPair();
    approveAutomation(projectRoot, target('scout', 'agent'), NOW, home);
    const lockPath = lockPathFor(contextRoot, 'scout');
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: NOW.getTime() }), 'utf-8');
    const spawn = capturingSpawn(CLAUDE_JSON_OK);
    const outcome = await runAutomation(contextRoot, 'scout', {
      home, spawnImpl: spawn.impl, now: () => NOW, fireAt: NOW, target: 'agent',
      task: { slug: 'fix-login', name: 'Fix the login' },
    });
    expect(outcome.status).toBe('deferred');
    expect(queuedFire(projectRoot, 'scout', home)).toBeNull();
    // The same refusal for the job itself is still owed.
    const plain = await runAutomation(contextRoot, 'scout', { home, spawnImpl: spawn.impl, now: () => NOW, fireAt: NOW });
    expect(plain.status).toBe('deferred');
    expect(queuedFire(projectRoot, 'scout', home)).not.toBeNull();
    expect(spawn.calls).toHaveLength(0);
  });

  it("a job's slug names no agent under target 'agent', even though an automation file has it", async () => {
    createAgent(contextRoot, { slug: 'writer', title: 'Writer', prompt: 'Write.' });
    createAutomation(
      contextRoot,
      { slug: 'daily-notes', title: 'Daily notes', agent: 'writer', days: 'daily', at: '08:00' },
      { approve: { now: NOW, home } },
    );
    const spawn = capturingSpawn(CLAUDE_JSON_OK);
    const outcome = await runAutomation(contextRoot, 'daily-notes', {
      home, spawnImpl: spawn.impl, now: () => NOW, fireAt: NOW, target: 'agent',
    });
    expect(outcome).toMatchObject({ status: 'failed', error: 'no such automation' });
    expect(spawn.calls).toHaveLength(0);
  });
});

/**
 * A5b. Mutation-tested against two mutations of `card-chat.ts`'s `prepareEnvelope`:
 *  - returning `target` instead of `identityOnly(target)` as the prep's manifest: the prep then
 *    carries 'Write a short note.' and 'reports/adhoc', and the first test fails;
 *  - `resolveSpawnScope(…, 'identity')` swapped for the default `'run'`: after the strip the
 *    agent is approved only through its binding, so both preps refuse and the second test fails.
 */
describe('A5b: conversations never carry call settings, and a synced strip blocks only running', () => {
  const OUTPUT_INSTRUCTIONS = 'Write a short note.';
  const OUTPUT_DIR = 'reports/adhoc';

  /** A legacy on-call agent with every call setting, approved before the split, then migrated,
   *  plus a bound automation that is approved on its own. */
  function seedMigratedCallAgent(): void {
    const created = createAutomation(contextRoot, {
      slug: 'helper', title: 'Helper', mode: 'call', prompt: 'Answer when asked.', review: 'agent',
      timeoutMinutes: 30, outputInstructions: OUTPUT_INSTRUCTIONS, outputDir: OUTPUT_DIR,
    });
    const legacy = writeFlowSection(contextRoot, 'helper', deriveFlowFromManifest(created));
    expect(legacy.flow).not.toBeNull();
    approveAutomation(projectRoot, legacy, NOW, home);
    expect(splitLegacyManifest(contextRoot, 'helper', { home }).outcome).toBe('split');
    createAutomation(
      contextRoot,
      { slug: 'helper-daily', title: 'Helper daily', agent: 'helper', days: 'daily', at: '07:00', job: 'Answer the inbox.' },
      { approve: { now: NOW, home } },
    );
  }

  /** What a teammate's synced edit does: the agent file loses its call block and both sections. */
  function stripCallSettings(): void {
    const path = agentPath(contextRoot, 'helper');
    const parsed = matter(readFileSync(path, 'utf-8'), {});
    const { call: _call, ...data } = parsed.data as Record<string, unknown>;
    const body = parsed.content
      .split(/^(?=## )/m)
      .filter((section) => !/^## (Output instructions|Flow)\b/.test(section))
      .join('');
    writeFileSync(path, matter.stringify(body, data));
  }

  function expectNoCallSettings(m: AutomationManifest, briefing: string): void {
    expect(m.outputInstructions).toBe(DEFAULT_CALL_SETTINGS.outputInstructions);
    expect(m.flow).toBe(DEFAULT_CALL_SETTINGS.flow);
    expect(m.outputDir).toBe(DEFAULT_CALL_SETTINGS.outputDir);
    expect(m.review).toBe(DEFAULT_CALL_SETTINGS.review);
    expect(m.job).toBe('');
    expect(briefing).not.toContain(OUTPUT_INSTRUCTIONS);
    expect(briefing).not.toContain(OUTPUT_DIR);
    expect(briefing).not.toContain('Answer the inbox.');
  }

  it('before the strip: the call target carries its settings, the conversations do not', () => {
    seedMigratedCallAgent();
    const call = target('helper', 'agent');
    expect(call).toMatchObject({ outputInstructions: OUTPUT_INSTRUCTIONS, outputDir: OUTPUT_DIR, review: 'agent' });
    expect(call.flow).not.toBeNull();
    expect(checkApproval(projectRoot, call, home, 'run').approved).toBe(true);

    const chat = prepareAgentChat(contextRoot, 'helper', home);
    expect(chat.ok).toBe(true);
    if (!chat.ok) return;
    expectNoCallSettings(chat.manifest, chat.briefing);
    expect(chat.briefing).toContain('Answer when asked.');
    chat.dispose();

    const board = createWhiteboard(contextRoot, 'Northwind Ops').slug;
    const card = prepareCardChat(contextRoot, { agent: 'helper', board }, home);
    expect(card.ok).toBe(true);
    if (!card.ok) return;
    expectNoCallSettings(card.manifest, card.briefing);
    card.dispose();
  });

  it("after a synced strip: 'run' is blocked, 'identity' passes through the binding, conversations still open", async () => {
    seedMigratedCallAgent();
    stripCallSettings();
    const call = target('helper', 'agent');
    expect(call.outputInstructions).toBe('');
    expect(call.flow).toBeNull();
    expect(call.outputDir).toBeNull();

    expect(checkApproval(projectRoot, call, home, 'run').approved).toBe(false);
    const identity = checkApproval(projectRoot, call, home, 'identity');
    expect(identity.approved).toBe(true);
    if (identity.approved) expect(identity.entry).toBeDefined();

    // Anything that RUNS the call target is refused, whichever way it is named.
    const spawn = capturingSpawn(CLAUDE_JSON_OK);
    for (const opts of [{ target: 'agent' as const }, {}]) {
      const outcome = await runAutomation(contextRoot, 'helper', { home, spawnImpl: spawn.impl, now: () => NOW, fireAt: NOW, ...opts });
      expect(outcome.status).toBe('blocked');
      expect(outcome.error).toContain('needs approval on the AI Team page');
    }
    expect(spawn.calls).toHaveLength(0);
    // The slot is empty, so the plain slug resolves to the same call target.
    expect(getAutomation(contextRoot, 'helper')?.runKind).toBe('agent');

    const chat = prepareAgentChat(contextRoot, 'helper', home);
    expect(chat.ok).toBe(true);
    if (!chat.ok) return;
    expectNoCallSettings(chat.manifest, chat.briefing);
    chat.dispose();

    const board = createWhiteboard(contextRoot, 'Northwind Ops').slug;
    const card = prepareCardChat(contextRoot, { agent: 'helper', board }, home);
    expect(card.ok).toBe(true);
    if (!card.ok) return;
    expectNoCallSettings(card.manifest, card.briefing);
    card.dispose();
  });
});

describe('the feed names the agent behind every message', () => {
  it('a bound job reads its agent; an unsplit file and a hand-built fixture read themselves', () => {
    createAgent(contextRoot, { slug: 'writer', title: 'Writer', prompt: 'Write clearly.' });
    createAutomation(contextRoot, { slug: 'daily-notes', title: 'Daily notes', agent: 'writer', days: 'daily', at: '08:00' });
    createAutomation(contextRoot, { slug: 'digest', title: 'Digest', prompt: 'Write the digest.', days: 'daily', at: '18:00' });

    const runId = NOW.toISOString();
    const bound = buildFeedMessage(contextRoot, target('daily-notes', 'automation'), false, runId, [], null, null);
    expect(bound).toMatchObject({ slug: 'daily-notes', title: 'Daily notes', agent: 'writer', agentTitle: 'Writer' });
    const legacy = buildFeedMessage(contextRoot, target('digest', 'automation'), false, runId, [], null, null);
    expect(legacy).toMatchObject({ slug: 'digest', agent: 'digest', agentTitle: 'Digest' });
    const fixture = buildFeedMessage(contextRoot, { slug: 'hand-built', title: 'Hand built' }, false, runId, [], null, null);
    expect(fixture).toMatchObject({ agent: 'hand-built', agentTitle: 'Hand built' });

    const roster = buildFeed(contextRoot, { home }).agents;
    expect(roster.find((a) => a.slug === 'daily-notes')).toMatchObject({ agent: 'writer', agentTitle: 'Writer' });
    expect(roster.find((a) => a.slug === 'digest')).toMatchObject({ agent: 'digest', agentTitle: 'Digest' });
  });
});

/**
 * A question asked by a task run on a same-slug pair records `target: 'agent'`, and the answer
 * resumes the AGENT. Mutation-tested: dropping the recorded target (resolving the slug with
 * `getAutomation`) resumes the pair's JOB, which nobody approved, so the answer is refused.
 */
describe('resuming a question asked by an agent-target run', () => {
  function seedPairWithUnapprovedJob(): void {
    createAgent(contextRoot, { slug: 'scout', title: 'Scout', prompt: 'Scout.' }, { approve: { now: NOW, home } });
    createAutomation(contextRoot, { slug: 'scout', title: 'Scout daily', agent: 'scout', days: 'daily', at: '09:00' });
    expect(checkApproval(projectRoot, target('scout', 'automation'), home, 'run').approved).toBe(false);
  }

  function ask(recorded: boolean) {
    recordAutomationSession('scout', 'sess_target', home);
    return createQuestion(contextRoot, {
      slug: 'scout', runFiredAt: NOW.toISOString(), kind: 'flow-hitl', sessionId: 'sess_target',
      channel: 'chat', question: 'Send it?', choices: [], ...(recorded ? { target: 'agent' as const } : {}),
    });
  }

  it('the recorded agent target resumes the agent', async () => {
    seedPairWithUnapprovedJob();
    const q = ask(true);
    expect(q.target).toBe('agent');
    const spawn = capturingSpawn(CLAUDE_JSON_OK);
    const out = await resumeWithAnswer(contextRoot, q, 'yes', 'dashboard', { home, spawnImpl: spawn.impl, now: () => NOW });
    expect(out.status).not.toBe('refused');
    expect(spawn.calls).toHaveLength(1);
    expect(spawn.calls[0]).toContain('--resume');
  });

  it('a question with no recorded target resolves the slug as before (here: the unapproved job)', async () => {
    seedPairWithUnapprovedJob();
    const q = ask(false);
    expect(q.target).toBeUndefined();
    const spawn = capturingSpawn(CLAUDE_JSON_OK);
    const out = await resumeWithAnswer(contextRoot, q, 'yes', 'dashboard', { home, spawnImpl: spawn.impl, now: () => NOW });
    expect(out.status).toBe('refused');
    expect(spawn.calls).toHaveLength(0);
  });
});

/**
 * An agent call-target run whose manifest changed under an existing grant asks an APPROVAL
 * question that records `target: 'agent'` and the run's task, and the pending gate is per
 * target: on a same-slug pair, the agent's open question never holds the job's scheduled fires,
 * nor the job's question the agent. Mutations checked:
 *  - drop `target`/`task` from the runner's approval `createQuestion` ⇒ the first test fails
 *    (`q.target` / `q.task` undefined);
 *  - gate with the slug-wide `pendingQuestion(contextRoot, slug)` ⇒ the job run reads
 *    `awaiting-approval` (first test) and the agent run `awaiting-review` (second test);
 *  - the agent-target gate line keeps `automations questions <slug>` ⇒ the first test fails.
 */
describe("an agent-target approval question, and a pending gate per target", () => {
  /** Same-slug pair `scout`: the agent approved directly, then edited; the job approved. */
  function seedPairWithEditedAgent(): void {
    createAgent(contextRoot, { slug: 'scout', title: 'Scout', prompt: 'Scout the market for new entrants.' });
    createAutomation(
      contextRoot,
      { slug: 'scout', title: 'Scout daily', agent: 'scout', days: 'daily', at: '09:00', job: 'Do the daily part.' },
      { approve: { now: NOW, home } },
    );
    approveAutomation(projectRoot, target('scout', 'agent'), NOW, home);
    const path = agentPath(contextRoot, 'scout');
    writeFileSync(path, readFileSync(path, 'utf-8').replace('Scout the market for new entrants.', 'Scout every market.'));
    // The job's hash carries the agent's prompt too; the owner re-approved the job only.
    approveAutomation(projectRoot, target('scout', 'automation'), NOW, home);
    expect(checkApproval(projectRoot, target('scout', 'agent'), home, 'run').approved).toBe(false);
    expect(checkApproval(projectRoot, target('scout', 'automation'), home, 'run').approved).toBe(true);
  }

  it("records target 'agent' and the task, holds the agent (naming the page), and never the job", async () => {
    seedPairWithEditedAgent();
    const spawn = capturingSpawn(CLAUDE_JSON_OK);
    const task = { slug: 'fix-login', name: 'Fix the login' };
    const asked = await runAutomation(contextRoot, 'scout', {
      home, spawnImpl: spawn.impl, now: () => NOW, fireAt: NOW, target: 'agent', task,
    });
    expect(asked.status).toBe('awaiting-approval');
    const open = listQuestions(contextRoot, 'scout').filter((q) => q.state === 'pending');
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ kind: 'approval', target: 'agent', task });

    // The agent is held by its own question, and the line names the page, never a command.
    const again = await runAutomation(contextRoot, 'scout', {
      home, spawnImpl: spawn.impl, now: () => NOW, fireAt: NOW, target: 'agent', task,
    });
    expect(again.status).toBe('awaiting-approval');
    expect(again.error).toContain('answer it on the AI Team page');
    expect(again.error).not.toContain('dreamcontext');

    // The job's scheduled fire still runs.
    const job = await runAutomation(contextRoot, 'scout', { home, spawnImpl: spawn.impl, now: () => NOW, fireAt: NOW });
    expect(job.status).toBe('ok');
    expect(spawn.prompt(spawn.calls.length - 1)).toContain('Do the daily part.');
  });

  it("the job's open question does not hold the agent's task run", async () => {
    createAgent(contextRoot, { slug: 'scout', title: 'Scout', prompt: 'Scout.' }, { approve: { now: NOW, home } });
    createAutomation(
      contextRoot,
      { slug: 'scout', title: 'Scout daily', agent: 'scout', days: 'daily', at: '09:00' },
      { approve: { now: NOW, home } },
    );
    createQuestion(contextRoot, {
      slug: 'scout', runFiredAt: NOW.toISOString(), kind: 'flow-hitl', sessionId: null, channel: 'chat', question: 'Publish?',
    });
    expect(pendingQuestionFor(contextRoot, 'scout', 'automation')).not.toBeNull();
    expect(pendingQuestionFor(contextRoot, 'scout', 'agent')).toBeNull();
    const spawn = capturingSpawn(CLAUDE_JSON_OK);
    const outcome = await runAutomation(contextRoot, 'scout', {
      home, spawnImpl: spawn.impl, now: () => NOW, fireAt: NOW, target: 'agent',
    });
    expect(outcome.status).toBe('ok');
  });

  it('an agent with no automation of its own: an untargeted (old) question still holds it, as before', () => {
    createAgent(contextRoot, { slug: 'solo', title: 'Solo', prompt: 'Help.' }, { approve: { now: NOW, home } });
    createQuestion(contextRoot, {
      slug: 'solo', runFiredAt: NOW.toISOString(), kind: 'approval', sessionId: null, channel: 'chat', question: 'Approve?',
    });
    // Mutation checked: `runKindOf` ignoring `getAutomation` (untargeted ⇒ 'automation') fails this.
    expect(pendingQuestionFor(contextRoot, 'solo', 'agent')).not.toBeNull();
  });

  it('a recorded task with an unsafe slug is dropped, and only approval questions keep one', () => {
    const base = { slug: 'scout', runFiredAt: NOW.toISOString(), sessionId: null, channel: 'chat' as const, question: 'q' };
    // Mutation checked: skipping `isSafeTaskSlug` in `parseQuestionTask` keeps the first task.
    expect(createQuestion(contextRoot, { ...base, kind: 'approval', task: { slug: '../etc/passwd', name: 'x' } }).task).toBeUndefined();
    expect(createQuestion(contextRoot, { ...base, kind: 'flow-hitl', task: { slug: 'fix-login', name: 'x' } }).task).toBeUndefined();
    expect(createQuestion(contextRoot, { ...base, kind: 'approval', task: { slug: 'fix-login', name: 'x' } }).task)
      .toEqual({ slug: 'fix-login', name: 'x' });
  });
});
