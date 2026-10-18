/**
 * The synthetic brain `scripts/verify/task-ui.mjs` drives (plan r3 § 5f). Written through the
 * REAL libraries (cycles, proposals, the backlog migration, the audit, owner corrections and
 * learned patterns), so the fixture is exactly what those features write, never a guessed shape.
 *
 *   npx tsx scripts/verify/fixtures/task-ui-seed.mts <context root> <scratch dir>
 *
 * Prints one JSON line: the ids the verify script needs (cycles, proposal, learned change).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newCycle, recordClose, startCycle, addDays } from '../../../src/lib/cycles.js';
import { addProposal } from '../../../src/lib/task-proposals.js';
import { runBacklogStep, suggestChange } from '../../../src/lib/backlog-migration.js';
import { LocalTaskBackend } from '../../../src/lib/task-backend/local.js';
import { recordAudit, recordHeldOpen } from '../../../src/lib/task-audit.js';
import { appendJournalEntry } from '../../../src/lib/task-journal.js';
import { ingestSessions } from '../../../src/lib/owner-corrections.js';
import { learnRule, openGroups } from '../../../src/lib/learned-patterns.js';

const [ctx, scratch] = process.argv.slice(2);
if (!ctx || !scratch) { console.error('usage: task-ui-seed.mts <context root> <scratch dir>'); process.exit(2); }
const stateDir = join(ctx, 'state');
mkdirSync(stateDir, { recursive: true });
mkdirSync(join(ctx, 'overrides'), { recursive: true });
mkdirSync(join(ctx, 'core'), { recursive: true });
mkdirSync(join(ctx, 'knowledge', 'patterns'), { recursive: true });

/** The five payloads: none may ever run (`window.__xss`) or reach the DOM as live markup. */
export const XSS = [
  '<img src=x onerror="window.__xss=1">',
  '<svg onload="window.__xss=1"></svg>',
  '<script>window.__xss=1</script>',
  '<iframe src="javascript:window.__xss=1"></iframe>',
  '[click me](javascript:window.__xss=1)',
];
const XSS_LINE = XSS.join(' ');

writeFileSync(join(ctx, 'overrides', 'task.md'), [
  '---', 'statuses:', '  - { name: Cancelled, key: cancelled, kind: cancelled, order: 99 }', '---', '',
].join('\n'));

const today = new Date().toISOString().slice(0, 10);

// ── cycles: one closed, one active, one planned next ───────────────────────────
const closed = newCycle(ctx, { goal: 'Ship the importer', start: addDays(today, -21), weeks: 1, today: addDays(today, -21) });
startCycle(ctx, closed.id, addDays(today, -21));
recordClose(ctx, closed.id, { carried: [], backed: [], cancelled: [], result: { done: 2, total: 3 }, closedAt: addDays(today, -14) });
const active = newCycle(ctx, { goal: 'Ödeme akışını bitir', start: today, weeks: 2, today });
startCycle(ctx, active.id, today);
const planned = newCycle(ctx, { goal: 'Polish the board', start: addDays(active.end, 1), weeks: 1, today });

// ── cards ──────────────────────────────────────────────────────────────────────
function card(slug: string, fm: Record<string, string | number | null>, body: string): void {
  const lines = ['---', `id: task_${slug.replace(/[^a-z0-9]/g, '').slice(0, 12)}`];
  for (const [k, v] of Object.entries(fm)) if (v !== null) lines.push(`${k}: ${typeof v === 'number' ? v : JSON.stringify(v)}`);
  if (!('created_at' in fm)) lines.push(`created_at: "${addDays(today, -10)}"`);
  if (!('updated_at' in fm)) lines.push(`updated_at: "${addDays(today, -1)}"`);
  lines.push('tags: []', '---', '', body.trim(), '');
  writeFileSync(join(stateDir, `${slug}.md`), lines.join('\n'));
}
const why = (w: string, criteria: string[], extra = '') =>
  `## Why\n\n${w}\n\n## Acceptance Criteria\n\n${criteria.join('\n')}\n${extra ? `\n${extra}\n` : ''}`;

// Turkish names, verbatim (İ, ı, ş, ğ, ö).
card('odeme-akisi', { name: 'Gölge İşleri: ığdır şubesi ödemesi', status: 'todo', priority: 'high', queue: 'next', rank: 10 },
  why('Şube ödemeleri elle yapılıyor.', ['- [ ] Ödeme geçer', '- [ ] İade çalışır']));
card('turkce-later', { name: 'İstanbul Şişli şube raporu', status: 'todo', priority: 'medium', queue: 'later' },
  why('Rapor sonra.', ['- [ ] Rapor üretilir']));

// A 300 KB legacy card: its whole history still in the card, and two mermaid fences.
const history = Array.from({ length: 4200 }, (_, i) =>
  `### 2026-01-${String((i % 28) + 1).padStart(2, '0')} - Session update\n- step ${i} of a long legacy history, padded to weigh like the real one`).join('\n\n');
const mermaid = (id: string) => ['```mermaid', 'flowchart TD', `  ${id}a[Start]:::done --> ${id}b[Middle]`, `  ${id}b --> ${id}c[End]:::todo`, '```'].join('\n');
card('legacy-giant', { name: 'Legacy giant', status: 'in_progress', cycle: active.id, rank: 20 },
  why('A card from before the journal existed.', ['- [x] Old work (evidence: legacy)', '- [ ] More work'],
    `## Technical Details\n\n${mermaid('m1')}\n\nAnd a second diagram:\n\n${mermaid('m2')}\n\n## Changelog\n\n${history}`));

// A parent with three open sub-tasks and one done.
card('epic-parent', { name: 'Checkout rebuild', status: 'in_progress', cycle: active.id, rank: 30 },
  why('The checkout is slow.', ['- [ ] The whole flow passes']));
for (const [i, s] of ['child-cart', 'child-pay', 'child-receipt'].entries()) {
  card(s, { name: `Checkout step ${i + 1}`, status: 'todo', parent_task: 'epic-parent', cycle: active.id, rank: 40 + i }, why('A step.', ['- [ ] Works']));
}
card('child-done', { name: 'Checkout step 0', status: 'completed', parent_task: 'epic-parent', cycle: active.id, rank: 35 },
  why('Done step.', ['- [x] Works (evidence: commit:abc1234)']));

// Finished and cancelled work that was never planned: never in Next or Later.
card('done-unplaced', { name: 'Old finished thing', status: 'completed' }, why('Done long ago.', ['- [x] Done (evidence: legacy)']));
card('cancelled-unplaced', { name: 'Abandoned idea', status: 'cancelled' }, why('Dropped.', ['- [ ] Never']));
card('cancelled-later', { name: 'Abandoned later', status: 'cancelled', queue: 'later' }, why('Dropped.', ['- [ ] Never']));

// Reviews: one fully evidenced, one with an unticked criterion.
card('review-ready', { name: 'Ready for your verdict', status: 'in_review', queue: 'next' },
  why('All proven.', ['- [x] Parser works (evidence: commit:abc1234)', '- [x] Docs updated (evidence: commit:def5678)']));
card('review-partial', { name: 'Half proven', status: 'in_review', queue: 'next' },
  why('Half proven.', ['- [x] Parser works (evidence: commit:abc1234)', '- [ ] Docs updated']));

// The XSS card: payloads in a section, a criterion and (below) a journal entry.
card('xss-card', { name: 'Payload card', status: 'todo', queue: 'next', rank: 50 },
  why(`Plain why. ${XSS_LINE}`, [`- [ ] Criterion with ${XSS_LINE}`], `## Notes\n\n${XSS_LINE}\n\n## Constraints & Decisions\n\n${XSS_LINE}`));
appendJournalEntry(stateDir, 'xss-card', { kind: 'log', actor: 'agent', body: `- a remote comment: ${XSS_LINE}` });
appendJournalEntry(stateDir, 'legacy-giant', { kind: 'log', actor: 'owner', body: '- moved to the new journal' });

// A task for a change card, and one to accept a proposal into.
card('change-me', { name: 'Maybe park this', status: 'todo' }, why('Not urgent.', ['- [ ] Something']));

// ── proposals and a change card ────────────────────────────────────────────────
const proposal = addProposal(ctx, {
  name: `Export as CSV ${XSS[0]}`, why: `The owner asked for it. ${XSS_LINE}`, quote: 'can we export this as csv', basis: 'ask',
});
let change: string | null = null;
try {
  runBacklogStep(ctx);
  const rec = await suggestChange(ctx, new LocalTaskBackend(stateDir), 'change-me', { change: 'later', why: 'Parked until the importer ships.', by: 'agent' });
  change = rec.suggestion?.id ?? null;
} catch (err) {
  console.error(`[seed] change card: ${err instanceof Error ? err.message : String(err)}`);
}

// ── the audit: force, accept, held open, and an approval with no browser Origin ─
recordAudit(ctx, { kind: 'force', slug: 'legacy-giant', actor: 'owner', via: 'cli', note: `spike ${XSS[0]}`, journalId: null });
recordAudit(ctx, { kind: 'accept', slug: 'odeme-akisi', actor: 'owner', via: 'dashboard', note: null, journalId: null });
recordAudit(ctx, { kind: 'approval', slug: 'review-ready', actor: 'agent', via: 'no-origin', note: 'ticked: Parser works', journalId: null });
recordHeldOpen(ctx, 'epic-parent', 3, (m) => console.error(`[seed] ${m}`));

// ── what sleep learned: a rule from two sessions, and a filing-rule change ─────
const quote = `Never put ${XSS[0]} markup in a commit message.`;
const transcript = (session: string, at: string) => [
  { type: 'user', sessionId: session, uuid: `u-${session}-1`, timestamp: at, message: { role: 'user', content: 'Let us write the release notes.' } },
  { type: 'assistant', sessionId: session, uuid: `a-${session}-1`, timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: 'Drafting them.' }] } },
  { type: 'user', sessionId: session, uuid: `u-${session}-2`, timestamp: at, message: { role: 'user', content: quote } },
].map((l) => JSON.stringify(l)).join('\n');
mkdirSync(join(scratch, 'transcripts'), { recursive: true });
const s1 = join(scratch, 'transcripts', 's1.jsonl');
const s2 = join(scratch, 'transcripts', 's2.jsonl');
writeFileSync(s1, transcript('s1-taskui', `${addDays(today, -3)}T09:00:00.000Z`));
writeFileSync(s2, transcript('s2-taskui', `${addDays(today, -2)}T09:00:00.000Z`));
ingestSessions(ctx, [{ id: 's1-taskui', path: s1 }, { id: 's2-taskui', path: s2 }], 'owner', 'epoch');
let learned: string | null = null;
try {
  const group = openGroups(ctx)[0];
  learned = learnRule(ctx, { pattern: 'commit-messages', title: 'Plain commit messages', rule: 'Never put markup in a commit message.', cites: group.ids }).id;
} catch (err) {
  console.error(`[seed] learned rule: ${err instanceof Error ? err.message : String(err)}`);
}
const ruleAt = `${addDays(today, -1)}T08:00:00.000Z`;
const rule = { id: 'R1', title: 'File only what the owner asked for', dont: 'Do not file a chore.', do: 'Propose it.', restsOn: [], reasons: {}, updated: ruleAt, by: 'sleep' };
writeFileSync(join(stateDir, '.task-filing-rules-history.json'), JSON.stringify([{ at: ruleAt, by: 'sleep', action: 'add', id: 'R1', before: null, after: rule }]));

console.log(JSON.stringify({ active: active.id, closed: closed.id, planned: planned.id, proposal: proposal.id, change, learned }));
