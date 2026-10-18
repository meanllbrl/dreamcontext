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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleTaskVerdict, handleTasksUpdate } from '../../src/server/routes/tasks.js';
import {
  handleFiledTaskKeep, handleTaskChangeApply, handleTaskChangeKeep, handleTaskProposalAccept, handleTaskProposalReject,
} from '../../src/server/routes/task-proposals.js';
import {
  acceptProposal, addProposal, keepFiled, mutateProposals, readProposals, recordFiled, rejectFiled, ProposalError,
} from '../../src/lib/task-proposals.js';
import { DEFAULT_STATUSES, type StatusDef } from '../../src/lib/task-status.js';
import { Command } from 'commander';
import { registerTasksCommand } from '../../src/cli/commands/tasks.js';
import { readFeedback } from '../../src/lib/task-feedback.js';
import { readDeclined } from '../../src/lib/task-declined.js';
import { readSleepState } from '../../src/cli/commands/sleep.js';
import { runBacklogStep, suggestChange } from '../../src/lib/backlog-migration.js';
import { LocalTaskBackend, readTaskFile, resetTaskReadMemo } from '../../src/lib/task-backend/local.js';
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
  vi.restoreAllMocks();
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

/**
 * Second-pass review, Major 1: an accept whose final store write found the store busy left the
 * proposal pending with its claim, over a task that exists. Past the claim's TTL it was listed
 * and counted again; accept answered `exists` and reject recorded a "no" for a kept task. An
 * accept now finishes it; a reject refuses; a proposal that changed meanwhile is a warning.
 */
describe('an accept that created its task but could not mark the proposal', () => {
  const NAME = 'Add a CSV export';
  const SLUG = 'add-a-csv-export';
  const CLAIM_TTL_MS = 5 * 60_000;
  const propose = () => addProposal(ctx, { name: NAME, why: 'The owner asked for it.', quote: 'can we export this as csv', basis: 'ask' });

  /** Run `after` right after the task file is written, inside the accept. */
  function afterCreate(after: () => void): void {
    const create = LocalTaskBackend.prototype.create;
    vi.spyOn(LocalTaskBackend.prototype, 'create').mockImplementation(async function (this: LocalTaskBackend, input: Parameters<LocalTaskBackend["create"]>[0]) {
      const task = await create.call(this, input);
      after();
      return task;
    });
  }

  /** Leave the proposal pending with a claim on a task that exists, as a busy final write does. */
  async function leftover(): Promise<string> {
    const p = propose();
    let release = () => {};
    afterCreate(() => { release = hold('.task-proposals'); });
    const first = await call(handleTaskProposalAccept, ctx, { id: p.id }, { body: {} });
    release();
    vi.restoreAllMocks();
    expect(first.code).toBe(200);
    expect(String(first.body.warning)).toMatch(/could not be marked accepted/);
    expect(existsSync(join(stateDir, `${SLUG}.md`))).toBe(true);
    const live = readProposals(ctx).proposals.find((x) => x.id === p.id)!;
    expect(live.status).toBe('pending');
    expect(live.claim?.slug).toBe(SLUG);
    return p.id;
  }

  it('past the claim TTL, accepting again finishes it: 200 accepted, keep feedback, nothing declined', async () => {
    const id = await leftover();
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + CLAIM_TTL_MS + 60_000);
    const again = await call(handleTaskProposalAccept, ctx, { id }, { body: {} });
    expect(again.code).toBe(200);
    expect(again.body.slug).toBe(SLUG);
    expect(String(again.body.warning)).toMatch(/earlier accept/);
    const live = readProposals(ctx).proposals.find((x) => x.id === id)!;
    expect(live).toMatchObject({ status: 'accepted', slug: SLUG });
    expect(live.claim).toBeUndefined();
    const feedback = readFeedback(ctx).filter((e) => e.id === id);
    expect(feedback.map((e) => e.verdict)).toEqual(['keep']);
    expect(readDeclined(ctx)).toEqual([]);
  }, 20_000);

  it('a reject of that proposal is refused: accept it to finish', async () => {
    const id = await leftover();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + CLAIM_TTL_MS + 60_000);
    const r = await call(handleTaskProposalReject, ctx, { id }, { body: { reason: 'not-work' } });
    expect(r.code).toBe(409);
    expect(String(r.body.message)).toMatch(/accept it to finish/);
    expect(readProposals(ctx).proposals.find((x) => x.id === id)!.status).toBe('pending');
    expect(readFeedback(ctx).filter((e) => e.verdict === 'reject')).toEqual([]);
    expect(readDeclined(ctx)).toEqual([]);
  }, 20_000);

  it('a proposal that changed during the create: 200 with a warning, and the change and the audit are recorded', async () => {
    const p = propose();
    // Someone else's write took the claim away while the task was being created.
    afterCreate(() => mutateProposals(ctx, (store) => { delete store.proposals.find((x) => x.id === p.id)!.claim; }));
    const r = await call(handleTaskProposalAccept, ctx, { id: p.id }, { body: {} });
    expect(r.code).toBe(200);
    expect(r.body.slug).toBe(SLUG);
    expect(String(r.body.warning)).toMatch(/changed while it was being accepted/);
    expect(existsSync(join(stateDir, `${SLUG}.md`))).toBe(true);
    expect((readSleepState(ctx).dashboard_changes ?? []).some((c) => c.target === SLUG && c.action === 'create')).toBe(true);
    expect(listAudit(ctx).filter((e) => e.kind === 'accept' && e.slug === SLUG)).toHaveLength(1);
  });
});

/** Second-pass review, Minor 10: the two keep routes are owner-only, like accept and apply. */
describe('the keep routes need the browser Origin', () => {
  it('filed keep: 403 without an Origin, nothing kept', async () => {
    seed('filed-two', 'todo');
    recordFiled(ctx, { slug: 'filed-two', name: 'Filed two', why: 'Because.', quote: 'q q q q', basis: 'ask', parent: null });
    const r = await call(handleFiledTaskKeep, ctx, { slug: 'filed-two' }, { origin: null });
    expect(r.code).toBe(403);
    expect(readProposals(ctx).filed.find((f) => f.slug === 'filed-two')!.outcome).toBe('open');
    expect((await call(handleFiledTaskKeep, ctx, { slug: 'filed-two' })).code).toBe(200);
  });

  it('change keep: 403 without an Origin, the suggestion still waiting', async () => {
    seed('park-me', 'todo', ['- [ ] Something']);
    runBacklogStep(ctx);
    const rec = await suggestChange(ctx, new LocalTaskBackend(stateDir), 'park-me', { change: 'later', why: 'Not now.', by: 'agent' });
    const id = rec.suggestion!.id;
    const r = await call(handleTaskChangeKeep, ctx, { slug: 'park-me' }, { origin: null, body: { id } });
    expect(r.code).toBe(403);
    expect((await call(handleTaskChangeKeep, ctx, { slug: 'park-me' }, { body: { id } })).code).toBe(200);
  });
});

/**
 * Owner decision 2026-10-19 (the third pass's third flag on the accept path): a provenance
 * marker. The card an accept creates carries `from_proposal: <id>` in its first write, and a
 * leftover claim is finished ONLY for that card, and only once the claim is stale. Any other
 * card on the slug is someone else's: the stale claim goes, the accept is `exists`, a reject
 * goes through.
 */
describe('the provenance marker', () => {
  const NAME = 'Add a CSV export';
  const SLUG = 'add-a-csv-export';
  const TTL = 5 * 60_000;
  const propose = () => addProposal(ctx, { name: NAME, why: 'The owner asked for it.', quote: 'can we export this as csv', basis: 'ask' });
  const staleAt = () => new Date(Date.now() - TTL - 60_000).toISOString();
  function claim(id: string, at: string): void {
    mutateProposals(ctx, (store) => { store.proposals.find((x) => x.id === id)!.claim = { slug: SLUG, at }; });
  }
  /** A card on the proposal's slug, with or without the marker. */
  function cardOnSlug(marker: string | null): void {
    seed(SLUG, 'todo', ['- [ ] Something']);
    if (marker) {
      const path = join(stateDir, `${SLUG}.md`);
      writeFileSync(path, readFileSync(path, 'utf-8').replace('\nstatus: todo\n', `\nstatus: todo\nfrom_proposal: "${marker}"\n`));
    }
  }
  const declined = () => readDeclined(ctx);
  const keeps = (id: string) => readFeedback(ctx).filter((e) => e.id === id && e.verdict === 'keep');

  it('an accept writes the proposal id onto the card in the create itself', async () => {
    const p = propose();
    let atCreate = '';
    const create = LocalTaskBackend.prototype.create;
    vi.spyOn(LocalTaskBackend.prototype, 'create').mockImplementation(async function (this: LocalTaskBackend, input: Parameters<LocalTaskBackend['create']>[0]) {
      const task = await create.call(this, input);
      atCreate = readFileSync(join(stateDir, `${SLUG}.md`), 'utf-8');
      return task;
    });
    expect((await call(handleTaskProposalAccept, ctx, { id: p.id }, { body: {} })).code).toBe(200);
    expect(atCreate).toContain(`from_proposal: "${p.id}"`);
    expect(readTaskFile(join(stateDir, `${SLUG}.md`)).from_proposal).toBe(p.id);
  });

  it('a stale claim and a hand-made card on the slug (no marker): accept is `exists`, reject goes through', async () => {
    const p = propose();
    claim(p.id, staleAt());
    cardOnSlug(null);
    const r = await call(handleTaskProposalAccept, ctx, { id: p.id }, { body: {} });
    expect(r.code).toBe(409);
    expect(r.body.error).toBe('exists');
    expect(readProposals(ctx).proposals.find((x) => x.id === p.id)?.claim).toBeUndefined();
    const rej = await call(handleTaskProposalReject, ctx, { id: p.id }, { body: { reason: 'already-exists' } });
    expect(rej.code).toBe(200);
    expect(readProposals(ctx).proposals.find((x) => x.id === p.id)?.status).toBe('rejected');
  });

  it('a stale claim on a card that carries the marker: accept finishes it (accepted, one keep, nothing declined)', async () => {
    const p = propose();
    claim(p.id, staleAt());
    cardOnSlug(p.id);
    const r = await call(handleTaskProposalAccept, ctx, { id: p.id }, { body: {} });
    expect(r.code).toBe(200);
    expect(String(r.body.warning)).toMatch(/earlier accept/);
    expect(readProposals(ctx).proposals.find((x) => x.id === p.id)).toMatchObject({ status: 'accepted', slug: SLUG });
    expect(keeps(p.id)).toHaveLength(1);
    expect(declined()).toEqual([]);
  });

  it('a fresh claim on a card that carries the marker: refused, being accepted right now', async () => {
    const p = propose();
    claim(p.id, new Date().toISOString());
    cardOnSlug(p.id);
    const r = await call(handleTaskProposalAccept, ctx, { id: p.id }, { body: {} });
    expect(r.code).toBe(409);
    expect(String(r.body.message)).toMatch(/being accepted right now; try again shortly/);
    expect(readProposals(ctx).proposals.find((x) => x.id === p.id)?.status).toBe('pending');
  });

  it('a create that throws, with a busy store for the release: the create\'s own error surfaces', async () => {
    const p = propose();
    let release = () => {};
    vi.spyOn(LocalTaskBackend.prototype, 'create').mockImplementation(async () => {
      release = hold('.task-proposals');
      throw new Error('disk full while creating the card');
    });
    const accepting = acceptProposal(ctx, new LocalTaskBackend(stateDir), DEFAULT_STATUSES, p.id, {}, 'dashboard');
    await expect(accepting).rejects.toThrow('disk full while creating the card');
    release();
  }, 20_000);

  it('a final write that fails (EACCES): 200 with the warning, and the audit and the dashboard change are recorded', async () => {
    const p = propose();
    // The feedback store's temp file is unwritable, so the final store write throws EACCES.
    const tmp = join(stateDir, `.task-feedback.json.${process.pid}.tmp`);
    const create = LocalTaskBackend.prototype.create;
    vi.spyOn(LocalTaskBackend.prototype, 'create').mockImplementation(async function (this: LocalTaskBackend, input: Parameters<LocalTaskBackend['create']>[0]) {
      const task = await create.call(this, input);
      writeFileSync(tmp, '');
      chmodSync(tmp, 0o444);
      return task;
    });
    try {
      const r = await call(handleTaskProposalAccept, ctx, { id: p.id }, { body: {} });
      expect(r.code).toBe(200);
      expect(String(r.body.warning)).toMatch(/could not be marked accepted \(.*(EACCES|permission denied)/i);
      expect(existsSync(join(stateDir, `${SLUG}.md`))).toBe(true);
      expect(listAudit(ctx).filter((e) => e.kind === 'accept' && e.slug === SLUG)).toHaveLength(1);
      expect((readSleepState(ctx).dashboard_changes ?? []).some((c) => c.target === SLUG && c.action === 'create')).toBe(true);
    } finally {
      chmodSync(tmp, 0o644);
      rmSync(tmp, { force: true });
    }
  });
});

describe('a filed reject that stopped before its record', () => {
  const DEFS: StatusDef[] = [...DEFAULT_STATUSES, { key: 'cancelled', label: 'Cancelled', kind: 'cancelled', order: 99 }];
  const SLUG = 'filed-cancelled';
  function leftoverFiled(): void {
    seed(SLUG, 'cancelled', ['- [ ] Something']);
    recordFiled(ctx, { slug: SLUG, name: 'Filed cancelled', why: 'Because.', quote: 'q q q q', basis: 'ask', parent: null });
    mutateProposals(ctx, (store) => { store.filed.find((f) => f.slug === SLUG)!.claim = { at: new Date(Date.now() - 6 * 60_000).toISOString() }; });
  }

  it('a reject finishes the record: rejected, no second status write or journal note', async () => {
    leftoverFiled();
    const before = snapshot(SLUG);
    const f = await rejectFiled(ctx, new LocalTaskBackend(stateDir), DEFS, SLUG, { reason: 'not-work' });
    expect(f).toMatchObject({ slug: SLUG, outcome: 'rejected' });
    expect(f.warning).toBeUndefined();
    expect(snapshot(SLUG)).toEqual(before);
    expect(readFeedback(ctx).filter((e) => e.source === 'sleep-filed' && e.verdict === 'reject')).toHaveLength(1);
  });

  it('keep is refused for a card already at the cancelled status', () => {
    leftoverFiled();
    expect(() => keepFiled(ctx, SLUG, DEFS)).toThrow(ProposalError);
    expect(() => keepFiled(ctx, SLUG, DEFS)).toThrow(/cancelled/);
    expect(readProposals(ctx).filed.find((f) => f.slug === SLUG)?.outcome).toBe('open');
  });
});

/**
 * `--force` (the second flag of the same write-order rule): recorded only after the status
 * write. A busy card records no force and says the force was not applied; a retry records one.
 */
describe('tasks complete --force', () => {
  const AGENT_ENVS = ['CLAUDECODE', 'DREAMCONTEXT_AGENT_SELF', 'DREAMCONTEXT_AUTOMATION_RUN'];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => { for (const k of AGENT_ENVS) { saved[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => { for (const k of AGENT_ENVS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

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
  const forces = () => listAudit(ctx).filter((e) => e.kind === 'force' && e.slug === 'force-me');
  const forcedEntries = () => readJournal(stateDir, 'force-me').filter((e) => e.label.startsWith('forced'));

  it('a busy card records no force; the retry records exactly one, and a second retry none', async () => {
    seed('force-me', 'in_progress', ['- [ ] Unproven']);
    const release = hold('force-me');
    expect(await cli('tasks', 'complete', 'force-me', 'Done.', '--force', '--reason', 'a spike, no tests')).toBe(1);
    release();
    expect(statusOf('force-me')).toBe('in_progress');
    expect(forces()).toEqual([]);
    expect(forcedEntries()).toEqual([]);

    expect(await cli('tasks', 'complete', 'force-me', 'Done.', '--force', '--reason', 'a spike, no tests')).toBe(0);
    expect(statusOf('force-me')).toBe('completed');
    expect(forces()).toHaveLength(1);
    expect(forcedEntries()).toHaveLength(1);
    expect(forcedEntries()[0].id).toBe(forces()[0].journalId);

    // Already completed: nothing moves, so nothing is forced again.
    await cli('tasks', 'complete', 'force-me', 'Done.', '--force', '--reason', 'a spike, no tests');
    expect(forces()).toHaveLength(1);
    expect(forcedEntries()).toHaveLength(1);
  }, 20_000);
});
