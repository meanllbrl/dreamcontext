/**
 * Evidence changes status (C1, AC7-AC9).
 *
 * `tasks check` is the only way an agent ticks a criterion: `--run` records an
 * `evidence` journal entry and ticks with `cmd:<je_id>`; a non-zero exit, a
 * forged `cmd:`/`commit:` and a typed `owner:<date>` are refused. The status
 * gate refuses review/done while a criterion is unproven; only cmd:/commit:
 * proof with nothing (observed) may skip review. `approve` and `--force` are
 * the owner's, refused from an agent environment. `tasks doctor` reports the
 * card-standard checks.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Command } from 'commander';
import { handleTasksJournal, handleTasksUpdate } from '../../src/server/routes/tasks.js';
import { applyRemoteComments, entriesToPost, journalSyncState } from '../../src/lib/task-backend/journal-sync.js';
import { appendJournalEntry } from '../../src/lib/task-journal.js';
import { registerTasksCommand } from '../../src/cli/commands/tasks.js';
import { readJournal } from '../../src/lib/task-journal.js';
import { criteriaOfBody, gateStatus, redactEvidenceTail, EVIDENCE_TAIL_CAP } from '../../src/lib/task-evidence.js';
import { cardIssues } from '../../src/lib/task-doctor.js';
import { DEFAULT_STATUSES } from '../../src/lib/task-status.js';

let projectRoot: string;
let stateDir: string;
let prevCwd: string;
let logs: string[];
const origLog = console.log;
const origErr = console.error;
const AGENT_ENVS = ['CLAUDECODE', 'DREAMCONTEXT_AGENT_SELF', 'DREAMCONTEXT_AUTOMATION_RUN'];
const savedEnv: Record<string, string | undefined> = {};

function cardOf(criteria: string[], status = 'in_progress', extra: string[] = []): string {
  return [
    '---', 'id: task_gate0001', 'name: Gate me', `status: ${status}`,
    'created_at: "2026-10-01"', 'updated_at: "2026-10-01"', ...extra, '---', '',
    '## Why', '', 'Because.', '',
    '## Acceptance Criteria', '', ...criteria, '',
  ].join('\n');
}
function seed(criteria: string[], status = 'in_progress'): void {
  writeFileSync(join(stateDir, 'gate-me.md'), cardOf(criteria, status));
}
function card(): string {
  return readFileSync(join(stateDir, 'gate-me.md'), 'utf-8');
}
function status(): string {
  return /^status: (.+)$/m.exec(card())![1];
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
  const raw = join(tmpdir(), `dc-gate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  stateDir = join(projectRoot, '_dream_context', 'state');
  mkdirSync(stateDir, { recursive: true });
  prevCwd = process.cwd();
  process.chdir(projectRoot);
  for (const k of AGENT_ENVS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  logs = [];
  console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
  console.error = (...a: unknown[]) => { logs.push(a.join(' ')); };
});
afterEach(() => {
  console.log = origLog;
  console.error = origErr;
  for (const k of AGENT_ENVS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  process.exitCode = undefined;
  process.chdir(prevCwd);
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('tasks check (AC7)', () => {
  it('--run writes an evidence entry and ticks with cmd:<its id>', async () => {
    seed(['- [ ] Parser works', '- [ ] Docs updated']);
    expect(await cli('tasks', 'check', 'gate-me', '1', '--run', 'echo parser-ok')).toBe(0);
    const ev = readJournal(stateDir, 'gate-me').find((e) => e.kind === 'evidence')!;
    expect(ev.body).toContain('parser-ok');
    expect(ev.body).toContain('- exit: 0');
    const c = criteriaOfBody(card())[0];
    expect(c).toMatchObject({ checked: true, evidence: `cmd:${ev.id}` });
    expect(criteriaOfBody(card())[1].checked).toBe(false);
  });

  it('--output-file + --exit ingests a command already run; picks a criterion by phrase', async () => {
    seed(['- [ ] Parser works', '- [ ] Docs updated']);
    writeFileSync(join(projectRoot, 'out.txt'), 'Tests 12 passed\n');
    expect(await cli('tasks', 'check', 'gate-me', 'docs upd', '--output-file', 'out.txt', '--exit', '0')).toBe(0);
    expect(criteriaOfBody(card())[1].evidence).toMatch(/^cmd:je_/);
  });

  it('refuses a non-zero exit, writing no tick', async () => {
    seed(['- [ ] Parser works']);
    const before = card();
    expect(await cli('tasks', 'check', 'gate-me', '1', '--run', 'echo boom; exit 3')).toBe(1);
    expect(card()).toBe(before);
    expect(readJournal(stateDir, 'gate-me').some((e) => e.kind === 'evidence')).toBe(false);
    expect(await cli('tasks', 'check', 'gate-me', '1', '--output-file', 'nope.txt', '--exit', '0')).toBe(1);
  });

  it('refuses a forged cmd:, a forged commit:, a typed owner:<date>, and a phrase matching 0 or >1 criteria', async () => {
    seed(['- [ ] Parser works', '- [ ] Parser docs']);
    const before = card();
    expect(await cli('tasks', 'check', 'gate-me', '1', '--evidence', 'cmd:je_forged0001')).toBe(1);
    expect(await cli('tasks', 'check', 'gate-me', '1', '--evidence', 'commit:deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')).toBe(1);
    expect(await cli('tasks', 'check', 'gate-me', '1', '--evidence', 'owner:2026-10-16')).toBe(1);
    expect(await cli('tasks', 'check', 'gate-me', 'parser', '--run', 'true')).toBe(1);
    expect(await cli('tasks', 'check', 'gate-me', 'nothing like it', '--run', 'true')).toBe(1);
    expect(card()).toBe(before);
  });

  it('accepts a real commit: reachable from the project\'s branch', async () => {
    const git = (...a: string[]) => execFileSync('git', a, { cwd: projectRoot, encoding: 'utf-8' }).trim();
    git('init', '-q');
    git('-c', 'user.email=a@example.com', '-c', 'user.name=A', 'commit', '-q', '--allow-empty', '-m', 'x');
    const sha = git('rev-parse', 'HEAD');
    seed(['- [ ] Parser works']);
    expect(await cli('tasks', 'check', 'gate-me', '1', '--evidence', `commit:${sha}`)).toBe(0);
    expect(criteriaOfBody(card())[0].evidence).toBe(`commit:${sha}`);
  });

  it('caps and scrubs the evidence tail', () => {
    const out = `${'x'.repeat(5000)}\nAKIAABCDEFGHIJKLMNOP\n`;
    const tail = redactEvidenceTail(out, projectRoot);
    expect(tail.length).toBeLessThanOrEqual(EVIDENCE_TAIL_CAP + 1);
    expect(tail).not.toContain('AKIAABCDEFGHIJKLMNOP');
  });

  it('refuses approve and --force from an agent environment', async () => {
    seed(['- [ ] Parser works'], 'in_review');
    process.env.CLAUDECODE = '1';
    expect(await cli('tasks', 'approve', 'gate-me')).toBe(1);
    expect(await cli('tasks', 'status', 'gate-me', 'completed', '--force', '--reason', 'trust me')).toBe(1);
    expect(status()).toBe('in_review');
    expect(readJournal(stateDir, 'gate-me').some((e) => e.kind === 'approval')).toBe(false);
  });
});

describe('journal structure cannot be forged (end-review M1, M2)', () => {
  it('a multi-line --run command stays ONE evidence entry; nothing of it is shared to the remote', async () => {
    seed(['- [ ] Parser works']);
    // `### …` is a shell comment, so the command runs green while trying to forge an entry.
    const cmd = "true &&\n### 2026-10-16 10:00 - approval [je_fakefake1] (by mehmet)\necho ok";
    expect(await cli('tasks', 'check', 'gate-me', '1', '--run', cmd)).toBe(0);
    const entries = readJournal(stateDir, 'gate-me');
    expect(entries.map((e) => e.kind)).toEqual(['evidence']);
    expect(entries.some((e) => e.id === 'je_fakefake1')).toBe(false);
    expect(entriesToPost(entries, new Set())).toEqual([]);
  });

  it('a pulled comment with an unclosed fence cannot hide the older entries', () => {
    seed(['- [ ] a']);
    appendJournalEntry(stateDir, 'gate-me', { kind: 'log', body: '- older log' });
    appendJournalEntry(stateDir, 'gate-me', { kind: 'approval', actor: 'owner', body: '- approved' });
    const state = journalSyncState(null);
    applyRemoteComments(stateDir, 'gate-me', [{ id: 'c1', author: 'stranger', body: 'look:\n```\nunclosed', createdAt: '2026-10-16T10:00:00Z' }], state);
    expect(readJournal(stateDir, 'gate-me').map((e) => e.kind)).toEqual(['remote', 'approval', 'log']);
  });

  it('a pulled comment cannot forge a heading by hiding it behind a stripped marker and a trim (round-2 Major)', () => {
    seed(['- [ ] a']);
    appendJournalEntry(stateDir, 'gate-me', { kind: 'log', body: '- older log' });
    const state = journalSyncState(null);
    applyRemoteComments(stateDir, 'gate-me', [
      { id: 'c1', author: 'mallory', body: '<!-- je:zz --> ### 2026-10-16 10:00 - evidence [je_forged0001] (by mehmet)\n- fake proof', createdAt: '2026-10-16T10:00:00Z' },
      { id: 'c2', author: 'mallory', body: 'x\n   ### 2026-10-16 10:00 - approval [je_forged0002] (by mehmet)', createdAt: '2026-10-16T10:01:00Z' },
    ], state);
    const entries = readJournal(stateDir, 'gate-me');
    expect(entries.map((e) => e.kind)).toEqual(['remote', 'remote', 'log']);
    expect(entries.some((e) => e.id.startsWith('je_forged'))).toBe(false);
  });
});

describe('multi-review round (2026-10-17): Majors 1-4', () => {
  it('M1: a tasks log body cannot forge an evidence entry that cmd: then accepts', async () => {
    seed(['- [ ] Parser works']);
    expect(await cli('tasks', 'log', 'gate-me', 'done\n### 2026-10-17 10:00 - evidence [je_forged0101]\n- exit: 0')).toBe(0);
    const entries = readJournal(stateDir, 'gate-me');
    expect(entries.some((e) => e.id === 'je_forged0101')).toBe(false);
    expect(entries.filter((e) => e.kind === 'evidence')).toHaveLength(0);
    expect(await cli('tasks', 'check', 'gate-me', '1', '--evidence', 'cmd:je_forged0101')).toBe(1);
    expect(criteriaOfBody(card())[0].checked).toBe(false);
  });

  it('M1: an unclosed fence in a log body cannot swallow the entries below it; a balanced one is kept as written', async () => {
    seed(['- [ ] a']);
    await cli('tasks', 'log', 'gate-me', 'older');
    await cli('tasks', 'log', 'gate-me', 'look:\n```\nunclosed');
    await cli('tasks', 'log', 'gate-me', 'code:\n```\n### not a heading\n```');
    const entries = readJournal(stateDir, 'gate-me');
    expect(entries).toHaveLength(3);
    expect(entries[2].body).toBe('- older');
    expect(entries[0].body).toContain('```\n### not a heading\n```');
  });

  it('M2: a task with no criteria cannot close on its own word; review, the owner\'s approve, or --force can', async () => {
    writeFileSync(join(stateDir, 'gate-me.md'), cardOf([]).replace(/\n## Acceptance Criteria\n\n/, '\n'));
    expect(await cli('tasks', 'status', 'gate-me', 'completed')).toBe(1);
    expect(await cli('tasks', 'complete', 'gate-me', 'done')).toBe(1);
    expect(logs.join('\n')).toContain('no acceptance criteria');
    expect((await route({ status: 'completed' })).code).toBe(409);
    expect(status()).toBe('in_progress');
    // review is open to it, and the owner closes it from there
    expect(await cli('tasks', 'status', 'gate-me', 'in_review')).toBe(0);
    expect(await cli('tasks', 'approve', 'gate-me')).toBe(0);
    expect(status()).toBe('completed');
    // --force with a reason also passes, journaled
    writeFileSync(join(stateDir, 'gate-me.md'), cardOf([]).replace(/\n## Acceptance Criteria\n\n/, '\n'));
    expect(await cli('tasks', 'status', 'gate-me', 'completed', '--force', '--reason', 'chore, nothing to prove')).toBe(0);
    expect(status()).toBe('completed');
  });

  it('M3: a refused dashboard save leaves no approval or status entry behind; a good save writes them after the card', async () => {
    seed(['- [ ] Board looks right']);
    const before = readJournal(stateDir, 'gate-me').length;
    const body = card().split('\n---\n').slice(1).join('\n---\n').replace('- [ ] Board', '- [x] Board');
    // tick + done in one save: owner: proof is review-only, so done is refused…
    const refused = await route({ body, status: 'completed' });
    expect(refused.code).toBe(409);
    expect(readJournal(stateDir, 'gate-me')).toHaveLength(before);
    expect(criteriaOfBody(card())[0].checked).toBe(false);
    // …retrying does not pile up approvals either
    expect((await route({ body, status: 'completed' })).code).toBe(409);
    expect(readJournal(stateDir, 'gate-me')).toHaveLength(before);
    // tick + review succeeds: the card names the approval that was written
    expect((await route({ body, status: 'in_review' })).code).toBe(200);
    const approval = readJournal(stateDir, 'gate-me').find((e) => e.kind === 'approval')!;
    expect(criteriaOfBody(card())[0].evidence).toBe(`owner:${approval.id}`);
    expect(readJournal(stateDir, 'gate-me').some((e) => e.kind === 'status' && e.label === 'in_review')).toBe(true);
  });

  it('M4: the panel shows a gate refusal line by line, as an alert, long enough to read', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'dashboard', 'src', 'components', 'tasks', 'TaskDetailPanel.tsx'), 'utf-8');
    const errDiv = /<div className="error-state"[^>]*>\{mutationError\}<\/div>/.exec(src)?.[0] ?? '';
    expect(errDiv).toContain('role="alert"');
    expect(errDiv).toContain("whiteSpace: 'pre-line'");
    const handler = /const onMutationError = \(err: Error\) => \{[\s\S]*?\n  \};/.exec(src)?.[0] ?? '';
    expect(handler).toContain('clearTimeout(mutationErrorTimer.current)');
    expect(handler).toMatch(/setTimeout\(\(\) => setMutationError\(null\), 8000\)/);
  });
});

describe('the status gate (AC8)', () => {
  it('refuses review and done while a criterion is unproven, listing it', async () => {
    seed(['- [ ] Parser works', '- [x] Docs updated']);
    expect(await cli('tasks', 'status', 'gate-me', 'in_review')).toBe(1);
    expect(await cli('tasks', 'status', 'gate-me', 'completed')).toBe(1);
    expect(await cli('tasks', 'complete', 'gate-me')).toBe(1);
    expect(status()).toBe('in_progress');
    expect(logs.join('\n')).toContain('1. [ ] Parser works');
    expect(logs.join('\n')).toContain('2. [x] (no evidence ref) Docs updated');
  });

  it('cmd:/commit: proof with nothing observed may close directly', async () => {
    seed(['- [ ] Parser works']);
    await cli('tasks', 'check', 'gate-me', '1', '--run', 'true');
    expect(await cli('tasks', 'status', 'gate-me', 'completed')).toBe(0);
    expect(status()).toBe('completed');
  });

  it('an (observed) criterion, a shot: or a legacy tick reaches review but not done', () => {
    for (const line of [
      '- [x] Board looks right (observed) (evidence: cmd:je_aaaaaaaaaa)',
      '- [x] Board looks right (evidence: shot:tmp/a.png)',
      '- [x] Board looks right (evidence: legacy)',
      '- [x] Board looks right (evidence: owner:je_aaaaaaaaaa)',
    ]) {
      const body = cardOf([line]);
      expect(gateStatus(body, 'review').ok, line).toBe(true);
      expect(gateStatus(body, 'done').ok, line).toBe(false);
    }
    expect(gateStatus(cardOf(['- [x] a (evidence: owner:2026-10-16)']), 'review').ok).toBe(false);
  });

  it('routes observed work through review; the owner\'s approve closes it with a journal entry', async () => {
    seed(['- [ ] Board looks right (observed)']);
    await cli('tasks', 'check', 'gate-me', '1', '--run', 'true');
    expect(await cli('tasks', 'status', 'gate-me', 'completed')).toBe(1);
    expect(await cli('tasks', 'status', 'gate-me', 'in_review')).toBe(0);
    expect(await cli('tasks', 'approve', 'gate-me', '--note', 'looked at it')).toBe(0);
    expect(status()).toBe('completed');
    expect(readJournal(stateDir, 'gate-me').find((e) => e.kind === 'approval')!.body).toContain('looked at it');
  });

  it('--force needs a reason and is journaled', async () => {
    seed(['- [ ] Parser works']);
    expect(await cli('tasks', 'status', 'gate-me', 'in_review', '--force')).toBe(1);
    expect(await cli('tasks', 'status', 'gate-me', 'in_review', '--force', '--reason', 'spike, no tests')).toBe(0);
    expect(status()).toBe('in_review');
    expect(readJournal(stateDir, 'gate-me').some((e) => e.kind === 'status' && e.body.includes('spike, no tests'))).toBe(true);
  });
});

function patch(body: unknown): IncomingMessage {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  Object.assign(req, { method: 'PATCH', headers: { 'content-type': 'application/json' } });
  return req;
}
async function route(body: unknown): Promise<{ code: number; body: string }> {
  let code = 0;
  let out = '';
  const res = {
    writeHead(c: number) { code = c; return res; },
    end(d?: string) { out = d ?? ''; return res; },
    setHeader() { return res; },
  } as unknown as ServerResponse;
  await handleTasksUpdate(patch(body), res, { slug: 'gate-me' }, join(projectRoot, '_dream_context'));
  return { code, body: out };
}

describe('the dashboard is the owner\'s surface (A9, E6)', () => {
  it('a box ticked in the dashboard writes an approval entry, then owner:<its id>', async () => {
    seed(['- [ ] Board looks right (observed)']);
    const body = card().split('\n---\n').slice(1).join('\n---\n').replace('- [ ] Board', '- [x] Board');
    expect((await route({ body })).code).toBe(200);
    const approval = readJournal(stateDir, 'gate-me').find((e) => e.kind === 'approval')!;
    expect(criteriaOfBody(card())[0]).toMatchObject({ checked: true, evidence: `owner:${approval.id}` });
  });

  it('a move to done with an unproven criterion is refused (409); review → done is an approval', async () => {
    seed(['- [ ] Parser works']);
    const refused = await route({ status: 'completed' });
    expect(refused.code).toBe(409);
    expect(refused.body).toContain('Parser works');
    expect(status()).toBe('in_progress');

    writeFileSync(join(stateDir, 'gate-me.md'), cardOf(['- [ ] Parser works'], 'in_review'));
    expect((await route({ status: 'completed' })).code).toBe(200);
    expect(status()).toBe('completed');
    expect(readJournal(stateDir, 'gate-me').find((e) => e.kind === 'approval')!.body).toContain('approved in the dashboard');
  });
});

describe('GET /api/tasks/:slug/journal (the panel\'s history strip)', () => {
  it('serves the newest 5 entries and the total, newest first', async () => {
    seed(['- [ ] a']);
    for (let i = 0; i < 7; i++) await cli('tasks', 'log', 'gate-me', `step ${i}`);
    let code = 0;
    let out = '';
    const res = {
      writeHead(c: number) { code = c; return res; },
      end(d?: string) { out = d ?? ''; return res; },
      setHeader() { return res; },
    } as unknown as ServerResponse;
    const req = { method: 'GET', headers: {}, url: '/api/tasks/gate-me/journal' } as unknown as IncomingMessage;
    await handleTasksJournal(req, res, { slug: 'gate-me' }, join(projectRoot, '_dream_context'));
    expect(code).toBe(200);
    const json = JSON.parse(out) as { total: number; entries: Array<{ body: string; kind: string; id: string }> };
    expect(json.total).toBe(7);
    expect(json.entries).toHaveLength(5);
    expect(json.entries[0]).toMatchObject({ kind: 'log', body: '- step 6' });
    expect(json.entries[0].id).toMatch(/^je_/);
  });
});

describe('the card ceiling (A10)', () => {
  it('tasks insert refuses past 12,000 chars, naming the journal; criteria stay insertable', async () => {
    seed(['- [ ] a']);
    const big = 'n'.repeat(12_500);
    expect(await cli('tasks', 'insert', 'gate-me', 'notes', big)).toBe(1);
    expect(card()).not.toContain(big);
    expect(logs.join('\n')).toMatch(/Card ceiling/);
    expect(await cli('tasks', 'insert', 'gate-me', 'acceptance_criteria', '--', `- [ ] ${big}`)).toBe(0);
    expect(card()).toContain(big);
  });
});

describe('tasks doctor (AC9)', () => {
  const now = new Date('2026-10-16T12:00:00Z');
  const codes = (raw: string) => cardIssues(raw, DEFAULT_STATUSES, now).map((i) => i.code);

  it('reports each card-standard check', () => {
    expect(codes(cardOf(['- [ ] a']).replace('## Why\n', '## Why\n<!-- What problem does this solve? What breaks if we don\'t do it? Be concrete — name the user, the friction, the cost. -->\n')))
      .toContain('template-comment');
    expect(codes(cardOf(['- [ ] a']).replace('name: Gate me', `name: ${'n'.repeat(81)}`))).toContain('name-long');
    expect(codes(cardOf(['- [ ] a', 'x'.repeat(12_100)]))).toContain('card-size');
    expect(codes(cardOf([], 'todo'))).toContain('no-criteria');
    expect(codes(cardOf(['- [ ] a'], 'in_review'))).toContain('review-unproven');
    expect(codes(cardOf(['- [x] a (evidence: cmd:je_aaaaaaaaaa)'], 'in_review'))).toContain('review-stale');
    expect(codes(cardOf(['- [x] a (evidence: owner:2026-10-01)']))).toContain('owner-typed-date');
    expect(codes(cardOf(['- [x] a (evidence: cmd:je_aaaaaaaaaa)'], 'in_review').replace('updated_at: "2026-10-01"', 'updated_at: "2026-10-15"'))).toEqual([]);
  });

  it('the CLI prints them with a per-check summary', async () => {
    seed([], 'todo');
    expect(await cli('tasks', 'doctor')).toBe(1);
    expect(logs.join('\n')).toMatch(/no-criteria 1/);
  });
});
