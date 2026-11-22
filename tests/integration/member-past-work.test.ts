/**
 * The exam of a member's past work (plan uye-gecmis-is, criterion 1): the eight real cases of
 * olcum.md rebuilt with fictional words. A fake machine with three projects (kestrel, lumen,
 * fjord), a global member mira and a project member oren; their chats written as real transcript
 * records (SDK prompt fields), swept by the server's index, and asked through the real loopback
 * client on a real http server. For each must-arrive case the base (today's 8-line history block)
 * has no trace of the earlier job and the new block names it; each precision case gets nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { handleAgentWorkSelect, sweepMember } from '../../src/server/routes/agent-work.js';
import { workIndex } from '../../src/lib/agents/work-index.js';
import { readAllTraces, workRoot, writeRunTrace, type WorkTrace } from '../../src/lib/agents/work-trace.js';
import { recordAgentSession } from '../../src/lib/local-store.js';
import { addVault } from '../../src/lib/vaults.js';
import { pastWorkForTurn } from '../../src/cli/commands/hook.js';
import { composePrompt, runPastWork } from '../../src/lib/automations/runner.js';
import { agentRecentBlock } from '../../src/lib/whiteboards/card-chat.js';
import { appendThreadEntry } from '../../src/lib/automations/threads.js';
import type { AutomationManifest } from '../../src/lib/automations/types.js';
import { Tx, makeMachine, globalMember, projectMember, putClaude, type Machine } from '../helpers/work-trace-fixtures.js';

const SDK = { promptSource: 'sdk', turnOrigin: 'sdk', entrypoint: 'sdk-cli' };

let m: Machine;
let server: Server;
let port: number;
const prevHome = process.env.HOME;
const prevPort = process.env.DREAMCONTEXT_DASHBOARD_PORT;
const ctx = (p: string) => join(m.project(p), '_dream_context');

/** One member conversation: the asks and what the member answered and wrote. */
function chat(slug: string, project: string, id: string, start: string, turns: Array<{ ask: string; did: string; file?: string }>): void {
  const tx = new Tx(Date.parse(start));
  for (const t of turns) {
    tx.user(t.ask, SDK).think().say(t.did);
    if (t.file) tx.write(join(m.project(project), t.file));
  }
  putClaude(m, id, tx.jsonl());
  recordAgentSession(m.project(project), slug, id, 'chat', m.home);
}

/** The trace a transcript's job became (by its transcript id). */
const traceOf = (slug: string, project: string, transcript: string): WorkTrace => {
  const t = readAllTraces(workRoot(slug, m.project(project), m.home)!).find((x) => x.transcript === transcript);
  if (!t) throw new Error(`no trace for ${transcript}`);
  return t;
};
const marker = (t: WorkTrace) => `[w_${t.id.slice(0, 8)}]`;

/** A chat turn as the hook delivers it (the real loopback client against the real route). */
const turn = (project: string, prompt: string, env: NodeJS.ProcessEnv = {}, slug = 'mira') =>
  pastWorkForTurn(ctx(project), prompt, { session_id: `now-${project}-${slug}` }, {
    env: { DREAMCONTEXT_AGENT_CHAT: slug, DREAMCONTEXT_DASHBOARD_PORT: String(port), ...env }, home: m.home,
  });

beforeAll(async () => {
  m = makeMachine();
  process.env.HOME = m.home;
  for (const p of ['kestrel', 'lumen', 'fjord']) addVault(p, m.project(p), m.home);
  globalMember(m, 'mira');
  projectMember(m, 'kestrel', 'oren');

  // V1: kestrel, the one tap upsell (then a busy week of other rows pushes it out of the history block).
  chat('mira', 'kestrel', 'k-upsell', '2026-11-03T09:00:00Z', [
    { ask: 'Add a one tap upsell right after checkout, charged once to the saved card', did: 'Added the one tap upsell offer after checkout: one tap, charged once to your saved card, with a skip link.', file: 'src/upsell/OneTapUpsell.tsx' },
  ]);
  // V2: lumen, the stripe test keys go in the secret card.
  chat('mira', 'lumen', 'l-keys', '2026-11-04T09:00:00Z', [
    { ask: 'Where should the stripe test keys live? Never in the repo', did: 'Moved the stripe test keys into the secret card (STRIPE_TEST_SECRET) and removed them from the repo config.', file: 'config/payments.ts' },
  ]);
  // V3: lumen, the stripe price by lookup_key with a coupon.
  chat('mira', 'lumen', 'l-price', '2026-11-05T09:00:00Z', [
    { ask: 'Create the yearly stripe price for the launch with a coupon', did: 'Created the yearly stripe price with lookup_key lumen_pro_yearly and the coupon LAUNCHLUMEN; the checkout reads the price by its lookup_key.', file: 'scripts/stripe-prices.ts' },
  ]);
  // V4: lumen, trust badges and reviews under the paywall.
  chat('mira', 'lumen', 'l-trust', '2026-11-06T09:00:00Z', [
    { ask: 'Put trust badges and three customer reviews under the paywall plans', did: 'Added the trust badges row and three customer reviews under the paywall plans.', file: 'src/paywall/TrustBadges.tsx' },
  ]);
  // V5: fjord, the branch delivery board.
  chat('mira', 'fjord', 'f-board', '2026-11-07T09:00:00Z', [
    { ask: 'Build a delivery board that shows every branch and its open deliveries', did: 'Built the branch delivery board: one column per branch, open deliveries as cards, late ones in red.', file: 'src/board/BranchDeliveryBoard.tsx' },
  ]);
  // Other work of mira's (the past the gate must keep out of unrelated asks).
  chat('mira', 'kestrel', 'k-misc', '2026-11-10T09:00:00Z', [
    { ask: 'Rename the settings tab to Preferences', did: 'Renamed the settings tab to Preferences everywhere.', file: 'src/nav/Tabs.tsx' },
  ]);
  chat('mira', 'fjord', 'f-misc', '2026-11-11T09:00:00Z', [
    { ask: 'Fix the invoice date format to day month year', did: 'Invoices now print dates as day month year.', file: 'src/invoice/format.ts' },
  ]);
  // oren's own work in kestrel (mira must never get it).
  chat('oren', 'kestrel', 'k-oren', '2026-11-08T09:00:00Z', [
    { ask: 'Add a referral leaderboard with weekly prizes', did: 'Added the referral leaderboard: weekly prizes for the top three referrers.', file: 'src/referral/Leaderboard.tsx' },
  ]);

  // Today's base for V1: the upsell row, then twelve later rows in mira's kestrel thread.
  const day = (d: number) => new Date(Date.parse('2026-11-03T10:00:00Z') + d * 3_600_000);
  appendThreadEntry(ctx('kestrel'), 'mira', { runId: 'r0', kind: 'agent', text: 'Added the one tap upsell offer after checkout.', via: 'dashboard', now: day(0) });
  for (let i = 1; i <= 12; i++) {
    appendThreadEntry(ctx('kestrel'), 'mira', { runId: `r${i}`, kind: 'agent', text: `Weekly note ${i}: copy tweaks on the onboarding screens.`, via: 'dashboard', now: day(i) });
  }

  // R1: a routine run of mira's whose next run must see it.
  mkdirSync(join(ctx('kestrel'), 'automations'), { recursive: true });
  await writeRunTrace({
    member: 'mira', projectRoot: m.project('kestrel'), slug: 'mira-price-watch', fireIso: '2026-11-16T08:00:00.000Z',
    finishedAt: new Date('2026-11-16T08:04:00.000Z'), ask: { by: 'schedule', text: 'Weekly competitor price watch for kestrel' },
    result: 'Checked four competitors: vexa raised its monthly plan to 12.99, the others held.', document: null,
    status: 'ok', sessionId: null, tool: 'claude', home: m.home,
  });

  workIndex.reset();
  workIndex.hooks = { home: m.home, sweep: (s, r) => sweepMember(s, r, m.home) };
  server = createServer((req, res) => void handleAgentWorkSelect(req, res, {}, ctx('kestrel')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as AddressInfo).port;
  process.env.DREAMCONTEXT_DASHBOARD_PORT = String(port);
  await workIndex.whenBuilt('mira', m.project('kestrel'));
  await workIndex.whenBuilt('oren', m.project('kestrel'));
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  workIndex.reset();
  workIndex.hooks = {};
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevPort === undefined) delete process.env.DREAMCONTEXT_DASHBOARD_PORT; else process.env.DREAMCONTEXT_DASHBOARD_PORT = prevPort;
  m.dispose();
});

describe('must arrive: the base has no trace of the earlier job, the new block names it', () => {
  const base = (project: string) => agentRecentBlock(ctx(project), 'mira', null);

  it('V1 kestrel: the one tap upsell, pushed out of the history block by twelve later rows', async () => {
    const t = traceOf('mira', 'kestrel', 'k-upsell');
    expect(base('kestrel')).toContain('YOUR RECENT HISTORY');
    expect(base('kestrel')).not.toContain('one tap upsell');
    const pw = await turn('kestrel', 'Add the one tap upsell to the new paywall too, charged once to the saved card');
    expect(pw?.text).toContain(marker(t));
  });

  it('V2 kestrel -> lumen: where the stripe test keys went', async () => {
    const t = traceOf('mira', 'lumen', 'l-keys');
    expect(base('kestrel')).not.toContain('stripe');
    const pw = await turn('kestrel', 'Where do the stripe test keys go for kestrel?');
    expect(pw?.text).toContain(marker(t));
  });

  it('V3 fjord -> lumen: the stripe price by lookup_key with a coupon', async () => {
    const t = traceOf('mira', 'lumen', 'l-price');
    expect(base('fjord')).not.toContain('lookup_key');
    const pw = await turn('fjord', 'Set up the fjord stripe price with a lookup_key and a launch coupon');
    expect(pw?.text).toContain(marker(t));
  });

  it('V4 kestrel -> lumen: trust badges and reviews', async () => {
    const t = traceOf('mira', 'lumen', 'l-trust');
    expect(base('kestrel')).not.toContain('trust badges');
    const pw = await turn('kestrel', 'Add trust badges and customer reviews to the kestrel paywall');
    expect(pw?.text).toContain(marker(t));
  });

  it('V5 kestrel -> fjord: the branch delivery board', async () => {
    const t = traceOf('mira', 'fjord', 'f-board');
    expect(base('kestrel')).not.toContain('delivery board');
    const pw = await turn('kestrel', 'Make a delivery board per branch for kestrel too');
    expect(pw?.text).toContain(marker(t));
  });

  it('R1: a routine run sees its previous run\'s trace, once, in its prompt', async () => {
    const run = readAllTraces(workRoot('mira', m.project('kestrel'), m.home)!).find((x) => x.kind === 'run')!;
    const block = await runPastWork('mira', m.project('kestrel'), 'Weekly competitor price watch for kestrel', null, m.home);
    expect(block).toContain(marker(run));
    const manifest = {
      slug: 'mira', id: 'agt_1', title: 'Mira', mode: 'call', enabled: true, schedule: null, scheduleError: null,
      model: null, effort: null, timeoutMinutes: 15, catchupHours: 6, outputDir: null, shared: false, notify: true,
      learning: true, review: 'off', flow: null, whiteboard: null, pattern: '', prompt: 'Watch competitor prices.', outputInstructions: '',
      job: '', soul: '', runKind: 'agent', agent: 'mira', agentTitle: 'Mira', bindings: [], legacyKey: false,
      path: join(m.home, '.dreamcontext', 'agents', 'mira.md'), body: '',
    } as unknown as AutomationManifest;
    const prompt = composePrompt(manifest, m.project('kestrel'), new Date('2026-11-23T08:00:00Z'), '/o.md', undefined, null, null, null, undefined, undefined, null, false, null, block);
    expect(prompt.split(marker(run)).length - 1).toBe(1);
  });
});

describe('precision: these get no block', () => {
  it('an unrelated ask', async () => {
    expect(await turn('kestrel', 'Translate the onboarding copy into German')).toBeNull();
  });

  it('oren\'s matching work never reaches mira (and does reach oren)', async () => {
    const t = traceOf('oren', 'kestrel', 'k-oren');
    expect(await turn('kestrel', 'Add a referral leaderboard with weekly prizes')).toBeNull();
    expect((await turn('kestrel', 'Add a referral leaderboard with weekly prizes', {}, 'oren'))?.text).toContain(marker(t));
  });

  it('an app run sees only that app\'s runs', async () => {
    expect(await runPastWork('mira', m.project('kestrel'), 'one tap upsell charged once to the saved card', 'funnel-desk', m.home)).toBe('');
  });

  it('an app chat', async () => {
    expect(await turn('kestrel', 'Add the one tap upsell charged once to the saved card', { DREAMCONTEXT_AGENT_CHAT: 'app-funnel-desk' })).toBeNull();
  });

  it('a pure child-event batch', async () => {
    expect(await turn('kestrel', '[super events] batch=b7 items=1\n- item=n1 child=c1 event=done\nThe one tap upsell child finished.')).toBeNull();
  });

  it('a run\'s own hook (the automation env is set)', async () => {
    expect(await turn('kestrel', 'Add the one tap upsell charged once to the saved card', { DREAMCONTEXT_AUTOMATION_SLUG: 'mira-price-watch' })).toBeNull();
  });
});
