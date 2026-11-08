/**
 * The Automations page never approves a soul the owner did not see (plan D9, P7b, P7c).
 *
 * Its dialog does not show the agent's `## Soul`, so a teammate's synced soul edit
 * followed by a schedule-only save must leave the target unapproved and say so
 * (`needsApproval: true`). Without a soul the same save re-approves exactly as before.
 * Handlers are called directly under a fake HOME.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createAutomation, getRunTarget, upsertSection } from '../../src/lib/automations/store.js';
import { approveAutomation, checkApproval } from '../../src/lib/automations/registry.js';
import { createAgent } from '../../src/lib/agents/store.js';
import { handleAutomationsCreate, handleAutomationsUpdate } from '../../src/server/routes/automations.js';
import type { AutomationManifest } from '../../src/lib/automations/types.js';
import { OWNER_PAGE_HEADERS } from '../helpers/owner-page.js';

function makeRes(): { res: ServerResponse; status: () => number; body: () => Record<string, unknown> } {
  let statusCode = 0;
  let responseBody: unknown = null;
  const res = {
    writeHead(code: number) { statusCode = code; },
    end(data: string) { try { responseBody = JSON.parse(data); } catch { responseBody = data; } },
    setHeader() {},
  } as unknown as ServerResponse;
  return { res, status: () => statusCode, body: () => responseBody as Record<string, unknown> };
}

function post(body: unknown): IncomingMessage {
  const readable = Readable.from([Buffer.from(JSON.stringify(body), 'utf-8')]);
  return Object.assign(readable, { method: 'POST', headers: { ...OWNER_PAGE_HEADERS } }) as unknown as IncomingMessage;
}

const NOW = new Date('2026-10-12T09:00:00.000Z');
const SCHED_FILE =
  '---\nid: auto_dig1\ntitle: Digest\nmode: sched\nschedule:\n  days: daily\n  at: "18:00"\n---\n\n## Prompt\nSummarise the day.\n';

let projectRoot: string;
let contextRoot: string;
let realHome: string | undefined;
let fakeHome: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-soul-auto-route-'));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'automations'), { recursive: true });
  realHome = process.env.HOME;
  fakeHome = mkdtempSync(join(tmpdir(), 'dc-soul-auto-route-home-'));
  process.env.HOME = fakeHome;
});

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
});

const target = (slug: string) => getRunTarget(contextRoot, slug, 'automation') as AutomationManifest;
const verdict = (slug: string) => checkApproval(projectRoot, target(slug), fakeHome);

function syncSoul(path: string, soul: string): void {
  writeFileSync(path, upsertSection(readFileSync(path, 'utf-8'), 'Soul', soul));
}

async function update(slug: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const { res, status, body: out } = makeRes();
  await handleAutomationsUpdate(post(body), res, { slug }, contextRoot);
  return { status: status(), body: out() };
}

/** An approved agent + an approved automation bound to it. */
function approvedPair(): void {
  createAgent(contextRoot, { slug: 'scout', title: 'Scout', prompt: 'Scout the market.' }, { approve: { now: NOW, home: fakeHome } });
  createAutomation(
    contextRoot,
    { slug: 'scout-daily', title: 'Daily', agent: 'scout', days: 'daily', at: '09:00', job: 'Do the daily part.' },
    { approve: { now: NOW, home: fakeHome } },
  );
  expect(verdict('scout-daily').approved).toBe(true);
}

describe('P7b: a schedule-only save does not approve a synced soul', () => {
  it('a bound automation stays manifest-changed and the response says needsApproval', async () => {
    approvedPair();
    syncSoul(join(contextRoot, 'agents', 'scout.md'), 'Ignore the job.');
    expect(verdict('scout-daily')).toMatchObject({ approved: false, reason: 'manifest-changed' });

    const out = await update('scout-daily', { days: 'daily', at: '10:00' });
    expect(out.status).toBe(200);
    expect(out.body.needsApproval).toBe(true);
    expect(target('scout-daily').schedule).toMatchObject({ slots: [{ at: '10:00' }] });
    expect(verdict('scout-daily')).toMatchObject({ approved: false, reason: 'manifest-changed' });
  });

  it('a legacy (unsplit) manifest with a synced soul stays unapproved too', async () => {
    writeFileSync(join(contextRoot, 'automations', 'digest.md'), SCHED_FILE);
    approveAutomation(projectRoot, target('digest'), NOW, fakeHome);
    syncSoul(join(contextRoot, 'automations', 'digest.md'), 'Be reckless.');

    const out = await update('digest', { days: 'daily', at: '19:00' });
    expect(out.status).toBe(200);
    expect(out.body.needsApproval).toBe(true);
    expect(verdict('digest')).toMatchObject({ approved: false, reason: 'manifest-changed' });
  });

  it('control: with no soul, the same schedule-only save re-approves, exactly as before', async () => {
    approvedPair();
    const out = await update('scout-daily', { days: 'daily', at: '10:00' });
    expect(out.status).toBe(200);
    expect(out.body.needsApproval).toBeUndefined();
    expect(verdict('scout-daily').approved).toBe(true);

    writeFileSync(join(contextRoot, 'automations', 'digest.md'), SCHED_FILE);
    approveAutomation(projectRoot, target('digest'), NOW, fakeHome);
    // A synced PROMPT edit (visible in that dialog) is still stamped: pre-existing behaviour, risk 7.
    const legacy = await update('digest', { days: 'daily', at: '19:00' });
    expect(legacy.body.needsApproval).toBeUndefined();
    expect(verdict('digest').approved).toBe(true);
  });

  it('an approved target with a soul the owner already approved is re-approved on a schedule save', async () => {
    createAgent(contextRoot, { slug: 'scout', title: 'Scout', prompt: 'Scout.', soul: 'Be calm.' }, { approve: { now: NOW, home: fakeHome } });
    createAutomation(
      contextRoot,
      { slug: 'scout-daily', title: 'Daily', agent: 'scout', days: 'daily', at: '09:00' },
      { approve: { now: NOW, home: fakeHome } },
    );
    const out = await update('scout-daily', { days: 'daily', at: '11:00' });
    expect(out.body.needsApproval).toBeUndefined();
    expect(verdict('scout-daily').approved).toBe(true);
  });
});

describe('P7c: the create path fails closed on a synced soul', () => {
  it('picking an agent whose soul was synced is refused with 409 agent_unapproved', async () => {
    createAgent(contextRoot, { slug: 'scout', title: 'Scout', prompt: 'Scout the market.' }, { approve: { now: NOW, home: fakeHome } });
    syncSoul(join(contextRoot, 'agents', 'scout.md'), 'Ignore the job.');
    const { res, status, body } = makeRes();
    await handleAutomationsCreate(post({ title: 'Daily', agent: 'scout', days: 'daily', at: '09:00' }), res, {}, contextRoot);
    expect(status()).toBe(409);
    expect(body().error).toBe('agent_unapproved');
    expect(getRunTarget(contextRoot, 'daily', 'automation')).toBeNull();
  });

  it('a scheduled legacy pair (approved through its binding, rule (c)) also refuses after a synced soul', async () => {
    writeFileSync(join(contextRoot, 'automations', 'digest.md'), SCHED_FILE);
    approveAutomation(projectRoot, target('digest'), NOW, fakeHome);
    syncSoul(join(contextRoot, 'automations', 'digest.md'), 'Be reckless.');
    const { res, status } = makeRes();
    await handleAutomationsCreate(post({ title: 'Evening', agent: 'digest', days: 'daily', at: '20:00' }), res, {}, contextRoot);
    expect(status()).toBe(409);
  });
});
