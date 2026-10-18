/**
 * The commit point of an owner decision (end review, finding 1). The status write — or the
 * create, for an accept, or the change, for an apply — is the first mutation. A card someone
 * else is writing refuses BEFORE it with 409 `busy` and nothing written. After it, a journal or
 * audit record that cannot follow is a warning on a 200 (`auditWarning`), never a refusal of a
 * decision that happened. Only a preflight failure is `audit_unavailable`.
 *
 * A held lock is a lock file a live process (this one) owns; the writer gives up after
 * LOCK_WAIT_MS (3 s), so the busy cases take that long.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleTaskVerdict, handleTasksUpdate } from '../../src/server/routes/tasks.js';
import { handleTaskChangeApply, handleTaskProposalAccept } from '../../src/server/routes/task-proposals.js';
import { addProposal, readProposals } from '../../src/lib/task-proposals.js';
import { runBacklogStep, suggestChange } from '../../src/lib/backlog-migration.js';
import { LocalTaskBackend, resetTaskReadMemo } from '../../src/lib/task-backend/local.js';
import { listAudit } from '../../src/lib/task-audit.js';
import { readJournal } from '../../src/lib/task-journal.js';
import { call } from '../helpers/fake-http.js';

let projectRoot: string;
let ctx: string;
let stateDir: string;
let prevCwd: string;
const origErr = console.error;
const origLog = console.log;

function seed(slug: string, status: string, criteria = ['- [x] Parser works (evidence: commit:abc)']): void {
  writeFileSync(join(stateDir, `${slug}.md`), [
    '---', `id: task_${slug.replace(/[^a-z]/g, '').slice(0, 8)}`, `name: ${slug}`, `status: ${status}`,
    'created_at: "2026-10-01"', 'updated_at: "2026-10-01"', '---', '',
    '## Why', '', 'Because.', '', '## Acceptance Criteria', '', ...criteria, '',
  ].join('\n'));
}
const statusOf = (slug: string) => /^status: (.+)$/m.exec(readFileSync(join(stateDir, `${slug}.md`), 'utf-8'))![1];
const snapshot = (slug: string) => ({
  card: existsSync(join(stateDir, `${slug}.md`)) ? readFileSync(join(stateDir, `${slug}.md`), 'utf-8') : null,
  journal: existsSync(join(stateDir, 'journal', `${slug}.md`)) ? readFileSync(join(stateDir, 'journal', `${slug}.md`), 'utf-8') : null,
});
/** Hold a task-file lock (a card's slug, or `.task-audit`) as a live writer would. */
function hold(key: string): () => void {
  const lock = join(stateDir, '.locks', `${key}.lock`);
  mkdirSync(join(stateDir, '.locks'), { recursive: true });
  writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }));
  return () => rmSync(lock, { force: true });
}

beforeEach(() => {
  const raw = join(tmpdir(), `dc-commit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  ctx = join(projectRoot, '_dream_context');
  stateDir = join(ctx, 'state');
  mkdirSync(stateDir, { recursive: true });
  resetTaskReadMemo();
  prevCwd = process.cwd();
  process.chdir(projectRoot);
  console.error = () => {};
  console.log = () => {};
});

afterEach(() => {
  console.error = origErr;
  console.log = origLog;
  process.chdir(prevCwd);
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('the verdict', () => {
  it('a busy audit lock after the status write: the task is done, 200 with audit_not_recorded', async () => {
    seed('in-review', 'in_review');
    const release = hold('.task-audit');
    const r = await call(handleTaskVerdict, ctx, { slug: 'in-review' }, { body: { verdict: 'approve' } });
    release();
    expect(r.code).toBe(200);
    expect(r.body.auditWarning).toBe('audit_not_recorded');
    expect(statusOf('in-review')).toBe('completed');
    expect(readJournal(stateDir, 'in-review').some((e) => e.kind === 'approval')).toBe(true);
    expect(listAudit(ctx)).toEqual([]);
  }, 20_000);

  it('a busy card before anything is written: 409 busy with a retry hint, nothing written', async () => {
    seed('in-review', 'in_review');
    const before = snapshot('in-review');
    const release = hold('in-review');
    const r = await call(handleTaskVerdict, ctx, { slug: 'in-review' }, { body: { verdict: 'send_back', note: 'not yet' } });
    release();
    expect(r.code).toBe(409);
    expect(r.body.error).toBe('busy');
    expect(String(r.body.message)).toMatch(/try again/i);
    expect(snapshot('in-review')).toEqual(before);
    expect(listAudit(ctx)).toEqual([]);
  }, 20_000);
});

describe('the PATCH approval', () => {
  it('a busy audit lock after the save: 200 with the warning, the task is done', async () => {
    seed('in-review', 'in_review');
    const release = hold('.task-audit');
    const r = await call(handleTasksUpdate, ctx, { slug: 'in-review' }, { method: 'PATCH', body: { status: 'completed' } });
    release();
    expect(r.code).toBe(200);
    expect(r.body.auditWarning).toBe('audit_not_recorded');
    expect(statusOf('in-review')).toBe('completed');
  }, 20_000);

  it('a busy card: 409 busy, nothing written', async () => {
    seed('in-review', 'in_review');
    const before = snapshot('in-review');
    const release = hold('in-review');
    const r = await call(handleTasksUpdate, ctx, { slug: 'in-review' }, { method: 'PATCH', body: { status: 'completed' } });
    release();
    expect(r.code).toBe(409);
    expect(r.body.error).toBe('busy');
    expect(snapshot('in-review')).toEqual(before);
  }, 20_000);
});

describe('a proposal accept', () => {
  const NAME = 'Add a CSV export';
  const SLUG = 'add-a-csv-export';

  it('a busy audit lock after the create: 200 with the warning, the task exists and the proposal is accepted', async () => {
    const p = addProposal(ctx, { name: NAME, why: 'The owner asked for it.', quote: 'can we export this as csv', basis: 'ask' });
    const release = hold('.task-audit');
    const r = await call(handleTaskProposalAccept, ctx, { id: p.id }, { body: {} });
    release();
    expect(r.code).toBe(200);
    expect(r.body.auditWarning).toBe('audit_not_recorded');
    expect(existsSync(join(stateDir, `${SLUG}.md`))).toBe(true);
    expect(readProposals(ctx).proposals.find((x) => x.id === p.id)?.status).toBe('accepted');
  }, 20_000);

  it('a busy card: 409 busy, no task created, the proposal still waiting', async () => {
    const p = addProposal(ctx, { name: NAME, why: 'The owner asked for it.', quote: 'can we export this as csv', basis: 'ask' });
    const release = hold(SLUG);
    const r = await call(handleTaskProposalAccept, ctx, { id: p.id }, { body: {} });
    release();
    expect(r.code).toBe(409);
    expect(r.body.error).toBe('busy');
    expect(existsSync(join(stateDir, `${SLUG}.md`))).toBe(false);
    const live = readProposals(ctx).proposals.find((x) => x.id === p.id);
    expect(live?.status).toBe('pending');
    expect(live?.claim).toBeUndefined();
    expect(listAudit(ctx)).toEqual([]);
  }, 20_000);
});

describe('a change apply', () => {
  async function suggested(): Promise<string> {
    seed('park-me', 'todo', ['- [ ] Something']);
    runBacklogStep(ctx);
    const rec = await suggestChange(ctx, new LocalTaskBackend(stateDir), 'park-me', { change: 'later', why: 'Not now.', by: 'agent' });
    return rec.suggestion!.id;
  }

  it('a busy audit lock after the change: 200 with the warning, the card is in Later', async () => {
    const id = await suggested();
    const release = hold('.task-audit');
    const r = await call(handleTaskChangeApply, ctx, { slug: 'park-me' }, { body: { id } });
    release();
    expect(r.code).toBe(200);
    expect(r.body.auditWarning).toBe('audit_not_recorded');
    expect(readFileSync(join(stateDir, 'park-me.md'), 'utf-8')).toMatch(/\nqueue: later\b/);
  }, 20_000);

  it('a busy card: 409 busy, the card unchanged', async () => {
    const id = await suggested();
    const before = snapshot('park-me');
    const release = hold('park-me');
    const r = await call(handleTaskChangeApply, ctx, { slug: 'park-me' }, { body: { id } });
    release();
    expect(r.code).toBe(409);
    expect(r.body.error).toBe('busy');
    expect(snapshot('park-me')).toEqual(before);
    expect(listAudit(ctx)).toEqual([]);
  }, 20_000);
});
