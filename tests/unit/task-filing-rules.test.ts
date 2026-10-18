/**
 * The task-filing rules pattern (C4): learned from rejects, shaped by code.
 *
 * Every rule cites the real rejects it rests on and counts them; it gives a
 * don't and a do example; a near-duplicate is refused in favour of a merge; the
 * file never passes its cap; every change is history the owner can revert in
 * one click. While a sleep runs, filing and proposing refuse until the CURRENT
 * rules were read in THIS cycle.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Command } from 'commander';
import { registerTasksCommand } from '../../src/cli/commands/tasks.js';
import { writeFeedback, type FeedbackReason, type TaskFeedbackEntry } from '../../src/lib/task-feedback.js';
import {
  mergeRules,
  readRuleHistory,
  readRules,
  readRulesText,
  recentRuleChanges,
  revertRule,
  RuleError,
  RULES_MAX_CHARS,
  RULES_REL_PATH,
  rulesForBrief,
  rulesReadRefusal,
  setRule,
  stampRulesRead,
  uncitedRejects,
} from '../../src/lib/task-filing-rules.js';
import { assertTaskFilingBar } from '../../src/lib/task-filing-bar.js';
import { handleTaskFilingRuleRevert, handleTaskProposalsList } from '../../src/server/routes/task-proposals.js';
import { TaskFileBusyError, withTaskFileLock } from '../../src/lib/task-file-lock.js';

function jsonReq(body: unknown): IncomingMessage {
  const r = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  Object.assign(r, { method: 'POST', headers: { 'content-type': 'application/json' } });
  return r;
}

let projectRoot: string;
let root: string;
let logs: string[];
let prevCwd: string;
const origLog = console.log;
const origErr = console.error;
const saved: Record<string, string | undefined> = {};
const AGENT_ENVS = ['CLAUDECODE', 'DREAMCONTEXT_AGENT_SELF', 'DREAMCONTEXT_AUTOMATION_RUN', 'DREAMCONTEXT_AUTO_SLEEP'];

function reject(id: string, reason: FeedbackReason, name: string): TaskFeedbackEntry {
  return { id, at: new Date().toISOString(), source: 'proposal', verdict: 'reject', reason, proposal: { name, why: 'w' }, basis: 'discussion', quote: 'q' };
}
function liveSleep(): void {
  writeFileSync(join(root, 'state', '.sleep.json'), JSON.stringify({ debt: 5, sleep_started_at: new Date().toISOString(), sessions: [] }));
}
async function cli(...argv: string[]): Promise<number> {
  process.exitCode = undefined;
  const program = new Command();
  program.exitOverride();
  registerTasksCommand(program);
  await program.parseAsync(['node', 'dreamcontext', ...argv]);
  const code = Number(process.exitCode ?? 0);
  process.exitCode = undefined;
  return code;
}

beforeEach(() => {
  const raw = join(tmpdir(), `dc-rules-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  root = join(projectRoot, '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFeedback(root, [
    reject('fb_a', 'too-small', 'Document the --since flag in the README'),
    reject('fb_b', 'too-small', 'Document the column rename in the README'),
    reject('fb_c', 'not-work', 'Ask whether the board should be blue'),
    { ...reject('fb_k', 'too-small', 'kept one'), verdict: 'keep', reason: null },
  ]);
  for (const k of AGENT_ENVS) { saved[k] = process.env[k]; delete process.env[k]; }
  prevCwd = process.cwd();
  process.chdir(projectRoot);
  logs = [];
  console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
  console.error = (...a: unknown[]) => { logs.push(a.join(' ')); };
});
afterEach(() => {
  console.log = origLog;
  console.error = origErr;
  process.chdir(prevCwd);
  for (const k of AGENT_ENVS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(projectRoot, { recursive: true, force: true });
});

const README_RULE = {
  title: 'A README touch-up is a criterion, not a task',
  dont: 'File "Document the --since flag in the README" as its own task',
  do: 'Add "README documents --since" as a criterion on the task that shipped the flag',
  by: 'sleep' as const,
};

describe('a rule rests on real rejects and says don\'t / do', () => {
  it('cites the rejects, counts them by reason, and renders a pattern file', () => {
    const r = setRule(root, null, { ...README_RULE, restsOn: ['fb_a', 'fb_b'] });
    expect(r.id).toBe('R1');
    expect(r.reasons).toEqual({ 'too-small': 2 });
    const text = readRulesText(root);
    expect(text).toMatch(/^---\nid: know_/);
    expect(text).toContain("'kind:pattern'");
    expect(text).toContain('### R1 · A README touch-up is a criterion, not a task');
    expect(text).toContain('Rests on 2 rejects: too small for a task of its own ×2.');
    expect(text).toContain("- **Don't:** File \"Document the --since flag in the README\" as its own task");
    expect(text).toContain('- **Do:** Add');
    expect(readRules(root)[0]).toMatchObject({ id: 'R1', restsOn: ['fb_a', 'fb_b'] });
    expect(uncitedRejects(root).map((e) => e.id)).toEqual(['fb_c']);
  });

  it('refuses a rule with no rejects, an unknown id, or a keep cited as a reject', () => {
    expect(() => setRule(root, null, { ...README_RULE, restsOn: [] })).toThrow(/rests on the owner/);
    expect(() => setRule(root, null, { ...README_RULE, restsOn: ['fb_nope'] })).toThrow(/Not a reject on record: fb_nope/);
    expect(() => setRule(root, null, { ...README_RULE, restsOn: ['fb_k'] })).toThrow(/fb_k/);
  });

  it('refuses a near-duplicate (merge instead), merges two rules, and caps the file', () => {
    setRule(root, null, { ...README_RULE, restsOn: ['fb_a'] });
    expect(() => setRule(root, null, { ...README_RULE, title: 'README touch-ups are criteria, not tasks', restsOn: ['fb_b'] }))
      .toThrow(/resembles R1/);
    const r2 = setRule(root, null, {
      title: 'A question is not work', dont: 'Ask whether the board should be blue', do: 'Answer it in the session; file nothing', restsOn: ['fb_c'], by: 'sleep',
    });
    const merged = mergeRules(root, 'R1', r2.id, { by: 'sleep' });
    expect(merged.restsOn.sort()).toEqual(['fb_a', 'fb_c']);
    expect(readRules(root).map((r) => r.id)).toEqual(['R1']);
    expect(() => setRule(root, 'R1', { dont: 'x'.repeat(300), by: 'sleep' })).toThrow(/under 240/);
    expect(RULES_MAX_CHARS).toBe(8000);
  });

  it('an edit adds citations and keeps the old ones', () => {
    setRule(root, null, { ...README_RULE, restsOn: ['fb_a'] });
    const r = setRule(root, 'R1', { restsOn: ['fb_b'], by: 'sleep' });
    expect(r.restsOn).toEqual(['fb_a', 'fb_b']);
  });
});

describe('the owner reverts a rule in one click', () => {
  it('undoes an add (gone), an update (back), and a merge (the dropped rule returns); each revert is history', () => {
    setRule(root, null, { ...README_RULE, restsOn: ['fb_a'] });
    setRule(root, 'R1', { title: 'README edits are never tasks', by: 'sleep' });
    expect(revertRule(root, 'R1')?.title).toBe(README_RULE.title);
    expect(readRules(root)[0].title).toBe(README_RULE.title);
    const r2 = setRule(root, null, { title: 'A question is not work', dont: 'Ask whether the board should be blue', do: 'Answer it in the session', restsOn: ['fb_c'], by: 'sleep' });
    mergeRules(root, 'R1', r2.id, { by: 'sleep' });
    revertRule(root, r2.id);
    expect(readRules(root).map((r) => r.id)).toEqual(['R1', 'R2']);
    const history = readRuleHistory(root);
    expect(history[0]).toMatchObject({ action: 'revert', id: 'R2', by: 'owner' });
    expect(recentRuleChanges(root, 5).map((c) => c.id)).toEqual(['R2', 'R1']);
    expect(() => revertRule(root, 'R9')).toThrow(RuleError);
  });

  it('`tasks rules revert` is refused from an agent environment; the dashboard route is the owner\'s', async () => {
    setRule(root, null, { ...README_RULE, restsOn: ['fb_a'] });
    process.env.CLAUDECODE = '1';
    expect(await cli('tasks', 'rules', 'revert', 'R1')).toBe(1);
    expect(readRules(root)).toHaveLength(1);
    let code = 0;
    let out = '';
    const res = { writeHead(c: number) { code = c; return res; }, end(d?: string) { out = d ?? ''; return res; }, setHeader() { return res; } } as unknown as ServerResponse;
    await handleTaskFilingRuleRevert(Readable.from([]) as unknown as IncomingMessage, res, { id: 'R1' }, root);
    expect(code).toBe(400); // the change being reverted must be named
    expect(readRules(root)).toHaveLength(1);
    await handleTaskFilingRuleRevert(jsonReq({ at: readRuleHistory(root)[0].at }), res, { id: 'R1' }, root);
    expect(code).toBe(200);
    expect(JSON.parse(out)).toEqual({ id: 'R1', restored: null });
    expect(readRules(root)).toHaveLength(0);
    // The section lists the change, with who made it.
    await handleTaskProposalsList(Readable.from([]) as unknown as IncomingMessage, res, {}, root);
    expect(JSON.parse(out).rules[0]).toMatchObject({ id: 'R1', action: 'revert', by: 'owner', removed: true });
  });
});

describe('a rule change is locked, history-first, and a stale revert is refused', () => {
  it('a revert names the change it saw: a double tap does not undo its own revert', async () => {
    setRule(root, null, { ...README_RULE, restsOn: ['fb_a'] });
    setRule(root, 'R1', { title: 'README edits are never tasks', by: 'sleep' });
    const seen = readRuleHistory(root)[0].at;
    expect(revertRule(root, 'R1', 'owner', seen)?.title).toBe(README_RULE.title);
    expect(() => revertRule(root, 'R1', 'owner', seen)).toThrow(/changed since you looked/);
    expect(readRules(root)[0].title).toBe(README_RULE.title);
    // Through the route: 409, nothing changes.
    let code = 0;
    const res = { writeHead(c: number) { code = c; return res; }, end() { return res; }, setHeader() { return res; } } as unknown as ServerResponse;
    await handleTaskFilingRuleRevert(jsonReq({ at: seen }), res, { id: 'R1' }, root);
    expect(code).toBe(409);
    expect(readRules(root)[0].title).toBe(README_RULE.title);
  });

  it('a change waits for the rules lock (it never writes past another writer)', () => {
    expect(() => withTaskFileLock(root, '.task-filing-rules', () => setRule(root, null, { ...README_RULE, restsOn: ['fb_a'] })))
      .toThrow(TaskFileBusyError);
    expect(readRules(root)).toHaveLength(0);
    expect(readRuleHistory(root)).toHaveLength(0);
  });

  it('history is written before the file; an unreadable history refuses the change', () => {
    setRule(root, null, { ...README_RULE, restsOn: ['fb_a'] });
    // The file write fails (its folder is read-only): the change is already in history,
    // so it is never an unrevertable edit, and reverting it is harmless.
    const folder = dirname(join(root, RULES_REL_PATH));
    chmodSync(folder, 0o555);
    try {
      expect(() => setRule(root, 'R1', { title: 'README edits are never tasks', by: 'sleep' })).toThrow();
    } finally {
      chmodSync(folder, 0o755);
    }
    expect(readRuleHistory(root)[0]).toMatchObject({ id: 'R1', action: 'update' });
    expect(readRules(root)[0].title).toBe(README_RULE.title);
    // A history that cannot be read is never replaced.
    const HISTORY = join(root, 'state', '.task-filing-rules-history.json');
    writeFileSync(HISTORY, '[{"id": <<<<<<<');
    expect(() => setRule(root, 'R1', { title: 'README edits are never tasks', by: 'sleep' })).toThrow(RuleError);
    expect(readFileSync(HISTORY, 'utf-8')).toBe('[{"id": <<<<<<<');
    expect(readRules(root)[0].title).toBe(README_RULE.title);
  });
});

describe('reading the rules is enforced while a sleep runs', () => {
  it('no sleep running: nothing to enforce', () => {
    expect(rulesReadRefusal(root)).toBeNull();
  });

  it('a live sleep refuses filing and proposing until `tasks rules` was run; a rule change needs a re-read', async () => {
    liveSleep();
    expect(rulesReadRefusal(root)).toMatch(/Read the task-filing rules/);
    const bar = await assertTaskFilingBar({ contextRoot: root, actor: 'sleep', mode: 'propose', name: 'x', why: 'w'.repeat(50), quote: 'q q q q q q' });
    expect(bar.allowed).toBe(false);
    expect(bar.reason).toMatch(/tasks rules/);
    logs = [];
    expect(await cli('tasks', 'rules')).toBe(0);
    expect(logs.join('\n')).toContain('Task-filing rules: none yet');
    expect(rulesReadRefusal(root)).toBeNull();
    // A writer saw what it wrote: setRule via the CLI re-stamps.
    expect(await cli('tasks', 'rules', 'set', '--title', README_RULE.title, '--dont', README_RULE.dont, '--do', README_RULE.do, '--rests-on', 'fb_a,fb_b')).toBe(0);
    expect(rulesReadRefusal(root)).toBeNull();
    // A change made elsewhere (the owner's revert) needs a fresh read.
    revertRule(root, 'R1');
    expect(rulesReadRefusal(root)).toMatch(/changed since you read them/);
    stampRulesRead(root);
    expect(rulesReadRefusal(root)).toBeNull();
  });

  it('the brief carries every rule in one line each', () => {
    setRule(root, null, { ...README_RULE, restsOn: ['fb_a', 'fb_b'] });
    const brief = rulesForBrief(root);
    expect(brief).toContain('R1 A README touch-up is a criterion, not a task');
    expect(brief).toContain('(2 rejects)');
  });

  it('a hand-edited file keeps its rules readable but writes go through the CLI', () => {
    setRule(root, null, { ...README_RULE, restsOn: ['fb_a'] });
    const p = join(root, 'knowledge', 'patterns', 'task-filing-rules.md');
    writeFileSync(p, readFileSync(p, 'utf-8').replace('### R1 · ', '### R1 · Edited: '));
    expect(readRules(root)[0].title.startsWith('Edited:')).toBe(true);
  });
});
