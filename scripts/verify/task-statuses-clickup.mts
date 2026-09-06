/**
 * Declared statuses over the ClickUp wire, against the in-memory ClickUp fake — the
 * three cases that decide whether you must MAP anything.
 *
 *   npx tsx scripts/verify/task-statuses-clickup.mts
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import matter from 'gray-matter';
import { ClickUpTaskBackend } from '../../src/lib/task-backend/clickup.js';
import { ApiAdapter } from '../../src/lib/task-backend/api-adapter.js';
import type { SetupConfig } from '../../src/lib/setup-config.js';
import { makeFakeClickUp } from '../../tests/unit/clickup-fake.js';

const CONFIG: SetupConfig = {
  platforms: [], packs: [], multiProduct: false, setupVersion: '0.0.0', disableNativeMemory: true,
  taskBackend: 'clickup', cloudTaskManagement: true,
  clickup: { teamId: 't1', spaceId: 's1', listId: 'l1', changelogTarget: 'comments' },
};

const lines: string[] = [];
const say = (s = '') => { lines.push(s); console.log(s); };

/** One scenario: a list status set + an override, pushed and pulled for real. */
async function scenario(title: string, listStatuses: string[], aliases: string[] | null) {
  const root = mkdtempSync(join(tmpdir(), 'dc-cu-proof-'));
  const ctx = join(root, '_dream_context');
  mkdirSync(join(ctx, 'state'), { recursive: true });
  mkdirSync(join(ctx, 'overrides'), { recursive: true });
  writeFileSync(join(ctx, 'overrides', 'task.md'), `---
statuses:
  - { name: Cancelled, key: cancelled, kind: cancelled, order: 99${aliases ? `, clickup: [${aliases.map((a) => JSON.stringify(a)).join(', ')}]` : ''} }
---
`);
  const fake = makeFakeClickUp();
  fake.listStatuses = listStatuses;
  let clock = 1000;
  const now = () => (clock += 7);
  const sleep = async () => { clock += 1; };
  const backend = new ClickUpTaskBackend(ctx, CONFIG, {
    adapter: new ApiAdapter({ baseUrl: 'https://api.clickup.com/api/v2', authHeaders: () => ({ Authorization: 'pk_x' }), fetchImpl: fake.fetchImpl, now, sleep }),
    now, sleep,
  });

  say(`── ${title}`);
  say(`   list statuses:  [${listStatuses.join(', ')}]`);
  say(`   declared alias: ${aliases ? aliases.join(', ') : '(none — label "Cancelled" only)'}`);
  await backend.create({ name: 'Abandoned Work', variant: 'cli' });
  await backend.sync('push');
  await backend.updateFields('abandoned-work', { status: 'cancelled', updated_at: '2026-09-06' });
  const report = await backend.sync('push');
  const remote = [...fake.tasks.values()][0];
  const tags = (remote.tags ?? []).map((t: { name: string }) => t.name).filter((n: string) => n.startsWith('dc:'));
  say(`   PUSH → remote status = ${remote.status?.status ? `"${remote.status.status}"` : '(omitted — list keeps its own)'}`
    + `   tags: [${tags.join(', ') || '—'}]`);
  const warn = report.warnings.find((w) => w.includes("status 'cancelled'"));
  say(`   warning: ${warn ? warn.replace(/\s+/g, ' ').slice(0, 150) + '…' : '(none)'}`);
  // Pull it back: does the remote spelling resolve to `cancelled` again?
  fake.editTask(remote.id, { name: 'Abandoned Work' });
  await backend.sync('pull');
  const local = String(matter(readFileSync(join(ctx, 'state', 'abandoned-work.md'), 'utf-8')).data.status);
  say(`   PULL → local status = ${local}   ${local === 'cancelled' ? '✅ round-trips' : '⚠️  NOT the declared status'}`);
  if (title.startsWith('D.')) {
    // A human moves it out of the parent status in ClickUp: the tag is now stale
    // and must lose to the human's move.
    fake.editTask(remote.id, { status: { status: 'in progress' } });
    await backend.sync('pull');
    const moved = String(matter(readFileSync(join(ctx, 'state', 'abandoned-work.md'), 'utf-8')).data.status);
    say(`   human drags it to "in progress" in ClickUp, stale dc:cancelled tag still on the task:`);
    say(`   PULL → local status = ${moved}   ${moved === 'in_progress' ? '✅ the human wins, stale tag ignored' : '⚠️  stale tag won'}`);
  }
  say();
  rmSync(root, { recursive: true, force: true });
}

say('ClickUp cannot CREATE a list status — so a declared status never asks it to. It pushes as');
say('its PARENT (one of the shipped four, which every list can express) and its own identity');
say('rides beside it as a `dc:<key>` TAG. Nothing has to be created on the provider, ever.');
say();
await scenario('A. the list already has "Cancelled" — it binds to the real status', ['to do', 'in progress', 'complete', 'Cancelled'], null);
await scenario('B. the list calls it "Won\'t do" — an ALIAS binds it', ['to do', 'in progress', 'complete', "Won't do"], ["won't do"]);
await scenario('C. the list has NO such status — the PARENT carries it', ['to do', 'in progress', 'complete'], ['cancelled']);
await scenario('D. …and a human dragging it in ClickUp still wins over the tag', ['to do', 'in progress', 'complete'], null);

if (process.env.PROOF_OUT) writeFileSync(process.env.PROOF_OUT, lines.join('\n'));
