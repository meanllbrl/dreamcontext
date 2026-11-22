/**
 * Criterion 30 of plan uye-karnesi W3 (real model): does the main Super, briefed exactly as it is,
 * end its relay of a finished member job with the rating question when the job's team line carries
 * `rate=ask`, and leave it out when it does not?
 *
 *   npx vite-node scripts/super-rate-ask-check.ts [--model opus] [--mac 5] [--telegram 5] [--held 5] [--plain 3]
 *
 * Fixtures are written on disk in a temp project (a fictional "Acme" with a member "Meta") and the
 * batch text is composed by the real `superBatchText` / `heldBlock`, so the lines are the server's.
 * Every `claude -p` runs from an empty temp dir with no tools. It prints each raw reply, the pass
 * counts and the measured cost (from the CLI's JSON result), and exits 1 when a count misses.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const args = process.argv.slice(2);
const opt = (name: string, dflt: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const MODEL = opt('model', 'opus');
const N = { mac: Number(opt('mac', '5')), telegram: Number(opt('telegram', '5')), held: Number(opt('held', '5')), plain: Number(opt('plain', '3')) };
const LINE = 'Nasıldı? 1-5 yıldız, istersen bir cümle.';

// A HOME of its own: nothing here touches the owner's ~/.dreamcontext.
const realEnv = { ...process.env };
const DRY = args.includes('--dry');
const home = realpathSync(mkdtempSync(join(tmpdir(), 'rate-ask-home-')));
process.env.HOME = home;
const project = realpathSync(mkdtempSync(join(tmpdir(), 'rate-ask-acme-')));
const root = join(project, '_dream_context');
mkdirSync(join(root, 'state'), { recursive: true });
const empty = realpathSync(mkdtempSync(join(tmpdir(), 'rate-ask-cwd-')));

const { createAgent } = await import('../src/lib/agents/store.js');
const { appendThreadEntry } = await import('../src/lib/automations/threads.js');
const { SUPER_STATE_REL } = await import('../src/lib/super/store.js');
const { emptySuperState } = await import('../src/lib/super/types.js');
const { superBatchText, heldBlock } = await import('../src/lib/super/inbox.js');
const { superBriefing, RATE_ASK_QUESTION } = await import('../src/server/chat-modes.js');

if (RATE_ASK_QUESTION !== LINE) throw new Error('the brief\'s question changed: update this check');

const RUN = '2026-11-22T08:00:00.000Z';
const SUPER = 'sup-check';
createAgent(root, { slug: 'meta', title: 'Meta', prompt: 'Meta plans the fictional Acme ad budget.', learning: false }, { approve: { now: new Date(RUN) } });
const at = (s: number) => new Date(Date.parse(RUN) + s * 1000);
const ask = appendThreadEntry(root, 'meta', { runId: RUN, kind: 'user', text: "Bu haftanın bütçe planını çıkart.", via: 'super', now: at(0) });
appendThreadEntry(root, 'meta', { runId: RUN, kind: 'system', event: 'started', text: '', via: 'runner', now: at(1) });
appendThreadEntry(root, 'meta', { runId: RUN, kind: 'agent', text: 'Haftalık bütçe planı hazır: toplam 4.200 $; Meta reklamlarına 2.800 $, yeni kitle testine 900 $, yeniden hedeflemeye 500 $. Geçen haftaya göre +%8.', via: 'cli', now: at(60) });
appendThreadEntry(root, 'meta', { runId: RUN, kind: 'system', event: 'ok', text: 'ok', via: 'runner', now: at(61) });

function state(rate: boolean, held: boolean) {
  const job = { id: 'team-meta1', member: 'meta', runId: RUN, entryId: ask.id, jobKind: 'run' as const, queued: false, brief: 'Haftalık bütçe planı', startedAt: Date.parse(RUN), awaited: true, told: 'done' as const, toldEndAt: Date.parse(RUN) + 62_000, ...(rate ? { rateAsked: true } : {}) };
  const item = { id: 'q-done1', sessionId: SUPER, kind: 'done' as const, state: 'pending' as const, createdAt: Date.parse(RUN) + 62_000, team: job.id, ...(rate ? { rateRun: `meta::${RUN}` } : {}) };
  const s = { ...emptySuperState(), session: SUPER, enabled: true, team: [job], queue: [item] } as ReturnType<typeof emptySuperState>;
  if (held) {
    s.queue.push({ id: 'q-ask1', sessionId: SUPER, kind: 'ask', state: 'escalated', createdAt: Date.parse(RUN) - 60_000 } as never);
    (s as { held?: unknown[] }).held = [{ item: item.id, child: SUPER, kind: 'done', at: item.createdAt }];
  }
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify(s));
  return { s, item };
}

const brief = superBriefing();
let cost = 0;
function claude(prompt: string, resume?: string, tries = 0): { text: string; session: string } {
  if (DRY) return { text: LINE, session: 'dry' };
  const r = spawnSync('claude', ['-p', '--model', MODEL, '--tools', '', '--output-format', 'json', '--append-system-prompt', brief, '--strict-mcp-config', '--setting-sources', '', ...(resume ? ['--resume', resume] : [])], {
    // On stdin: `--tools` takes several values and would swallow a trailing prompt.
    input: prompt,
    // The model call signs in as the owner's own CLI (his HOME); the fixtures stay in the temp one.
    cwd: empty, env: realEnv, encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024, timeout: 300_000,
  });
  if (r.status !== 0) {
    // Up to 3 retries: a killed call (143) is the machine, not the model's answer.
    if (tries < 3) { console.log(`(claude exited ${r.status} ${r.signal ?? ''} at ${new Date().toISOString()}, retry ${tries + 1} of 3)`); spawnSync('sleep', ['20']); return claude(prompt, resume, tries + 1); }
    throw new Error(`claude exited ${r.status} ${r.signal ?? ''}: ${r.stderr.slice(0, 400)} ${r.stdout.slice(0, 400)}`);
  }
  const j = JSON.parse(r.stdout) as { result?: string; session_id?: string; total_cost_usd?: number };
  cost += j.total_cost_usd ?? 0;
  return { text: (j.result ?? '').trim(), session: j.session_id ?? '' };
}

const endsWithLine = (t: string) => t.replace(/[\s`]+$/g, '').endsWith(LINE);
const voiceOk = (t: string) => {
  const m = /```dream-voice[^\n]*\n([\s\S]*?)```/.exec(t);
  return !m || m[1].trim().endsWith(LINE);
};
const all: Array<{ kind: string; ok: boolean; text: string }> = [];
// Each reply is printed as it lands, so a run cut short still leaves its evidence.
const rows = { push: (r: { kind: string; ok: boolean; text: string }) => { console.log(`=== ${r.kind} ${r.ok ? 'PASS' : 'FAIL'} ===\n${r.text}\n`); all.push(r); } };

const rated = state(true, false);
const batch = superBatchText(root, rated.s, [rated.item], 'b-check');
if (!/ rate=ask run=meta::/.test(batch)) throw new Error(`the fixture batch carries no rate=ask:\n${batch}`);
console.log(`--- batch with rate=ask ---\n${batch}\n`);

for (let i = 0; i < N.mac; i++) {
  const r = claude(batch);
  rows.push({ kind: 'mac', ok: endsWithLine(r.text) && !/super ask/.test(r.text), text: r.text });
}
for (let i = 0; i < N.telegram; i++) {
  // His ask, from Telegram. With no tools the Super can only stall over how to hand it on (measured:
  // the call never answered and was killed at ~5 min), so a harness line, outside his message,
  // says it was handed already. This turn only sets the channel; the measured turn is the next one.
  const first = claude(`Meta'ya bu haftanın bütçe planını çıkart.\n<owner-msg ref="tg${String(i).padStart(4, '0')}" via="telegram"/>\n[check harness: tools are off here; you already handed this job to Meta with \`dreamcontext super team ask\` and it runs. Reply to him in one short line.]`);
  const r = claude(batch, first.session);
  rows.push({ kind: 'telegram', ok: endsWithLine(r.text) && voiceOk(r.text) && !/super ask/.test(r.text), text: r.text });
}
const heldState = state(true, true);
const held = heldBlock(root, heldState.s);
if (!held || !/ rate=ask run=meta::/.test(held.text)) throw new Error(`the held block carries no rate=ask:\n${held?.text}`);
console.log(`--- held block ---\n${held.text}\n`);
for (let i = 0; i < N.held; i++) {
  const r = claude(`Evet, ikisini de yayınla.\n<owner-msg ref="hd${String(i).padStart(4, '0')}"/>\n${held.text}`);
  rows.push({ kind: 'held', ok: endsWithLine(r.text) && !/super ask/.test(r.text), text: r.text });
}
const plain = state(false, false);
const plainBatch = superBatchText(root, plain.s, [plain.item], 'b-plain');
if (/rate=ask/.test(plainBatch)) throw new Error('the plain batch carries rate=ask');
for (let i = 0; i < N.plain; i++) {
  const r = claude(plainBatch);
  rows.push({ kind: 'plain', ok: !r.text.includes('1-5 yıldız'), text: r.text });
}

const tally = (k: string) => `${all.filter((r) => r.kind === k && r.ok).length}/${all.filter((r) => r.kind === k).length}`;
console.log(`RESULT mac ${tally('mac')} telegram ${tally('telegram')} held ${tally('held')} plain ${tally('plain')} cost $${cost.toFixed(3)} model ${MODEL}`);
rmSync(project, { recursive: true, force: true });
rmSync(home, { recursive: true, force: true });
rmSync(empty, { recursive: true, force: true });
process.exit(all.every((r) => r.ok) ? 0 : 1);
