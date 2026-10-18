/**
 * The Inbox over HTTP (plan r3 § W4; r3 security S2; orchestrator addition 2): what
 * waits for the owner, the records of every owner override with actor and `via`,
 * held-open flags, what sleep learned and its revert. The owner-only writes (seen,
 * learned revert, proposal accept, change apply) refuse an Origin-less request.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleInbox, handleInboxCount, handleInboxSeen, handleLearnedRevert } from '../../src/server/routes/inbox.js';
import { handleTaskChangeApply, handleTaskProposalAccept, proposalsWaiting } from '../../src/server/routes/task-proposals.js';
import { handleTaskVerdict } from '../../src/server/routes/tasks.js';
import { addProposal } from '../../src/lib/task-proposals.js';
import { listAudit, recordAudit, recordHeldOpen, type AuditEntry } from '../../src/lib/task-audit.js';
import { ingestSessions } from '../../src/lib/owner-corrections.js';
import { learnRule, openGroups } from '../../src/lib/learned-patterns.js';
import { resetTaskReadMemo } from '../../src/lib/task-backend/local.js';
import { call } from '../helpers/fake-http.js';

const FIX = join(__dirname, '..', 'fixtures', 'owner-corrections');
let projectRoot: string;
let ctx: string;
let stateDir: string;
let prevCwd: string;
const origLog = console.log;
const origErr = console.error;

function seed(slug: string, status: string, criteria: string[]): void {
  writeFileSync(join(stateDir, `${slug}.md`), [
    '---', `id: task_${slug.replace(/[^a-z]/g, '').slice(0, 8)}`, `name: ${slug}`, `status: ${status}`,
    'created_at: "2026-10-01"', 'updated_at: "2026-10-01"', '---', '',
    '## Why', '', 'Because.', '', '## Acceptance Criteria', '', ...criteria, '',
  ].join('\n'));
}

beforeEach(() => {
  const raw = join(tmpdir(), `dc-inbox-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  ctx = join(projectRoot, '_dream_context');
  stateDir = join(ctx, 'state');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(ctx, 'knowledge', 'patterns'), { recursive: true });
  resetTaskReadMemo();
  prevCwd = process.cwd();
  process.chdir(projectRoot);
  console.log = () => {};
  console.error = () => {};
  seed('ready-review', 'in_review', ['- [x] One (evidence: commit:abc)', '- [x] Two (evidence: commit:def)']);
  seed('half-review', 'in_review', ['- [x] One (evidence: commit:abc)', '- [ ] Two']);
  seed('working', 'in_progress', ['- [ ] One']);
});

afterEach(() => {
  console.log = origLog;
  console.error = origErr;
  process.chdir(prevCwd);
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('what the Inbox shows and counts', () => {
  it('the badge is the C4 count + fully evidenced reviews + unseen held-open flags', async () => {
    addProposal(ctx, { name: 'Add a CSV export', why: 'The owner asked for it.', quote: 'can we export this as csv', basis: 'ask' });
    recordHeldOpen(ctx, 'some-parent', 2, () => {});
    expect(proposalsWaiting(ctx)).toBe(1);
    const count = await call(handleInboxCount, ctx, {}, { method: 'GET' });
    expect(count.body.waiting).toBe(1 + 1 + 1);
    const inbox = await call(handleInbox, ctx, {}, { method: 'GET' });
    expect((inbox.body.reviews as Array<{ slug: string }>).map((r) => r.slug).sort()).toEqual(['half-review', 'ready-review']);
    expect((inbox.body.flags as AuditEntry[]).map((f) => f.slug)).toEqual(['some-parent']);
    expect((inbox.body.proposals as { waiting: number }).waiting).toBe(1);
  });

  it('records carry approvals, accepts, forces and exemptions with actor and via; held-open is a flag, not a record', async () => {
    expect((await call(handleTaskVerdict, ctx, { slug: 'ready-review' }, { body: { verdict: 'approve' } })).code).toBe(200);
    const p = addProposal(ctx, { name: 'Add a CSV export', why: 'The owner asked for it.', quote: 'can we export this as csv', basis: 'ask' });
    expect((await call(handleTaskProposalAccept, ctx, { id: p.id }, { body: {} })).code).toBe(200);
    recordAudit(ctx, { kind: 'force', slug: 'working', actor: 'owner', via: 'cli', note: 'spike', journalId: 'je_force00001' });
    recordAudit(ctx, { kind: 'exempt', slug: 'working', actor: 'owner', via: 'cli', note: 'no sleep change', journalId: 'je_exempt0001' });
    recordHeldOpen(ctx, 'some-parent', 1, () => {});
    const inbox = await call(handleInbox, ctx, {}, { method: 'GET' });
    const records = inbox.body.records as AuditEntry[];
    expect(records.map((r) => `${r.kind}:${r.via}`).sort()).toEqual(['accept:dashboard', 'approval:dashboard', 'exempt:cli', 'force:cli']);
    expect(records.every((r) => typeof r.actor === 'string' && r.actor.length > 0)).toBe(true);
  });

  it('a held-open parent is flagged once, not on every pull', () => {
    recordHeldOpen(ctx, 'some-parent', 2, () => {});
    recordHeldOpen(ctx, 'some-parent', 2, () => {});
    expect(listAudit(ctx, { kinds: ['held_open'] })).toHaveLength(1);
  });

  it('a held-open record that cannot be written warns and writes nothing (the sync goes on)', () => {
    mkdirSync(join(ctx, '.gitignore'));
    const warnings: string[] = [];
    recordHeldOpen(ctx, 'some-parent', 2, (m) => warnings.push(m));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('some-parent');
    expect(existsSync(join(stateDir, '.task-audit.json'))).toBe(false);
  });
});

describe('the owner-only Inbox writes', () => {
  it('seen marks a flag seen with actor and via, and clears it from the badge; no Origin is refused', async () => {
    recordHeldOpen(ctx, 'some-parent', 2, () => {});
    const flag = listAudit(ctx, { kinds: ['held_open'] })[0];
    expect((await call(handleInboxSeen, ctx, {}, { body: { id: flag.id }, origin: null })).code).toBe(403);
    const r = await call(handleInboxSeen, ctx, {}, { body: { id: flag.id } });
    expect(r.code).toBe(200);
    expect((r.body.entry as AuditEntry).seen).toMatchObject({ via: 'dashboard' });
    expect((await call(handleInbox, ctx, {}, { method: 'GET' })).body.flags).toEqual([]);
    expect((await call(handleInboxSeen, ctx, {}, { body: { id: 'ta_missing00' } })).code).toBe(404);
  });

  it('proposal accept and change apply refuse a request with no Origin', async () => {
    const p = addProposal(ctx, { name: 'Add a CSV export', why: 'The owner asked for it.', quote: 'can we export this as csv', basis: 'ask' });
    const accept = await call(handleTaskProposalAccept, ctx, { id: p.id }, { body: {}, origin: null });
    expect(accept.code).toBe(403);
    expect(accept.body.error).toBe('origin_required');
    expect(proposalsWaiting(ctx)).toBe(1);
    const apply = await call(handleTaskChangeApply, ctx, { slug: 'working' }, { body: { id: 'bs_x1' }, origin: null });
    expect(apply.code).toBe(403);
    expect(listAudit(ctx)).toEqual([]);
  });

  it('a learned rule and a filing-rule change revert through the Inbox; a stale expectAt is 409; no Origin is 403', async () => {
    ingestSessions(ctx, [{ id: 's1-larkspur', path: join(FIX, 's1.jsonl') }, { id: 's2-larkspur', path: join(FIX, 's2.jsonl') }], 'owner-fixture', 'epoch');
    const learned = learnRule(ctx, { pattern: 'named-exports', title: 'Named exports only', rule: 'Always use named exports, never default exports.', cites: openGroups(ctx)[0].ids });
    const at = '2026-10-17T08:00:00.000Z';
    const rule = { id: 'R1', title: 'File only what the owner asked for', dont: 'Do not file a chore.', do: 'Propose it.', restsOn: [], reasons: {}, updated: at, by: 'sleep' };
    writeFileSync(join(stateDir, '.task-filing-rules-history.json'), JSON.stringify([{ at, by: 'sleep', action: 'add', id: 'R1', before: null, after: rule }]));

    const items = (await call(handleInbox, ctx, {}, { method: 'GET' })).body.learned as Array<{ id: string }>;
    expect(items.map((i) => i.id)).toContain(learned.id);

    expect((await call(handleLearnedRevert, ctx, { id: learned.id }, { body: {}, origin: null })).code).toBe(403);
    expect((await call(handleLearnedRevert, ctx, { id: learned.id }, { body: {} })).code).toBe(200);
    expect(existsSync(join(ctx, 'knowledge', 'patterns', 'named-exports.md'))).toBe(false);

    expect((await call(handleLearnedRevert, ctx, { id: `R1@${at}` }, { body: { expectAt: '2026-01-01T00:00:00.000Z' } })).code).toBe(409);
    expect((await call(handleLearnedRevert, ctx, { id: `R1@${at}` }, { body: { expectAt: at } })).code).toBe(200);
    expect((await call(handleLearnedRevert, ctx, { id: '../x' }, { body: {} })).code).toBe(400);
  });
});
