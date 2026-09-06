/**
 * Declared statuses over the GitHub wire, end to end against the in-memory GitHub fake —
 * prints a transcript scripts/verify/task-statuses-ui.mjs renders into a screenshot.
 *
 *   npx tsx scripts/verify/task-statuses-github.mts
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import matter from 'gray-matter';
import { GitHubTaskBackend } from '../../src/lib/task-backend/github.js';
import { ApiAdapter } from '../../src/lib/task-backend/api-adapter.js';
import type { SetupConfig } from '../../src/lib/setup-config.js';
import { makeFakeGitHub } from '../../tests/unit/github-fake.js';

const CONFIG: SetupConfig = {
  platforms: [], packs: [], multiProduct: false, setupVersion: '0.0.0', disableNativeMemory: true,
  taskBackend: 'github', cloudTaskManagement: true,
  github: { owner: 'acme', repo: 'demo', changelogTarget: 'comments' },
};
const OVERRIDE = `---
statuses:
  - { name: Planned, key: planned, kind: open, order: 5, color: c5def5 }
  - { name: Cancelled, key: cancelled, kind: cancelled, order: 99, color: cfd3d7 }
---
`;

const root = mkdtempSync(join(tmpdir(), 'dc-gh-proof-'));
const ctx = join(root, '_dream_context');
mkdirSync(join(ctx, 'state'), { recursive: true });
mkdirSync(join(ctx, 'overrides'), { recursive: true });
writeFileSync(join(ctx, 'overrides', 'task.md'), OVERRIDE);

const fake = makeFakeGitHub();
let clock = 1000;
const now = () => (clock += 7);
const sleep = async () => { clock += 1; };
const mk = (contextRoot: string) => new GitHubTaskBackend(contextRoot, CONFIG, {
  adapter: new ApiAdapter({ baseUrl: 'https://api.github.com', authHeaders: () => ({ Authorization: 'Bearer x' }), fetchImpl: fake.fetchImpl, now, sleep }),
  fetchImpl: fake.fetchImpl, now, sleep,
});

const lines: string[] = [];
const say = (s: string) => { lines.push(s); console.log(s); };
const issue = () => [...fake.issues.values()][0];
const wire = () => `state=${issue().state.padEnd(6)} reason=${String(issue().state_reason).padEnd(9)} labels=[${issue().labels.map((l) => l.name).sort().join(', ')}]`;

const a = mk(ctx);
say('$ overrides/task.md declares  planned (open)  +  cancelled (cancelled)');
say('');
await a.create({ name: 'Round Trip', variant: 'cli' });
await a.sync('push');
say(`todo         →  ${wire()}`);
for (const st of ['in_progress', 'cancelled', 'in_progress', 'completed', 'cancelled']) {
  fake.requests.length = 0;
  await a.updateFields('round-trip', { status: st, updated_at: `2026-09-0${clock % 9 + 1}` });
  const r = await a.sync('push');
  const patch = fake.requests.find((q) => q.method === 'PATCH');
  const body = patch?.body as Record<string, unknown> | undefined;
  const extra = body?.state_reason === 'reopened' ? '   ← state_reason: reopened' : '';
  say(`${st.padEnd(12)} →  ${wire()}${extra}${r.errors.length ? '  ERRORS ' + r.errors.join(';') : ''}`);
}
say('');
say('labels provisioned on the repo (declared colour):');
for (const l of ['dc:planned', 'dc:cancelled']) {
  const label = fake.labels.get(l);
  say(`  ${l.padEnd(13)} ${label ? '#' + label.color : 'MISSING'}`);
}
say('');
say('not_planned is STILL the delete signal (stale dc:cancelled label present):');
fake.editIssue(issue().number, { state: 'closed', state_reason: 'not_planned' });
const del = await a.sync('pull');
say(`  pull → mirrorDeleted=${del.mirrorDeleted}  file exists=${existsSync(join(ctx, 'state', 'round-trip.md'))}`);
say('');
say('schema drift — a machine WITHOUT the override pulls a cancelled task:');
const b = mk(ctx);
await b.create({ name: 'Drifted', variant: 'cli' });
await b.sync('push');
await b.updateFields('drifted', { status: 'cancelled', updated_at: '2026-09-06' });
await b.sync('push');
const rootB = mkdtempSync(join(tmpdir(), 'dc-gh-proof-b-'));
mkdirSync(join(rootB, '_dream_context', 'state'), { recursive: true });
const c = mk(join(rootB, '_dream_context'));
const drift = await c.sync('pull');
const mirror = join(rootB, '_dream_context', 'state', 'drifted.md');
say(`  recorded status=${String(matter(readFileSync(mirror, 'utf-8')).data.status)}  deleted=${drift.mirrorDeleted}`);
say(`  warning: ${drift.warnings.find((w) => w.includes('dc:cancelled'))?.slice(0, 110)}…`);
mkdirSync(join(rootB, '_dream_context', 'overrides'), { recursive: true });
writeFileSync(join(rootB, '_dream_context', 'overrides', 'task.md'), OVERRIDE);
fake.editIssue([...fake.issues.values()].find((i) => i.title === 'Drifted')!.number, { body: '## Why\n\nnudge\n' });
await mk(join(rootB, '_dream_context')).sync('pull');
say(`  after pulling the override: status=${String(matter(readFileSync(mirror, 'utf-8')).data.status)}  (self-corrected)`);

rmSync(root, { recursive: true, force: true });
rmSync(rootB, { recursive: true, force: true });
if (process.env.PROOF_OUT) writeFileSync(process.env.PROOF_OUT, lines.join('\n'));
