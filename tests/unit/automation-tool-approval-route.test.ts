/** Track T W4, end-review finding: a later save must not stamp away a tool waiting for approval.
 *  Saves come from the owner's page: an automation edit is owner-only since 2026-11-01. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { approveAutomation, checkApproval, getApproval } from '../../src/lib/automations/registry.js';
import { createAutomation, getAutomation } from '../../src/lib/automations/store.js';
import { handleAutomationsUpdate } from '../../src/server/routes/automations.js';
import { OWNER_PAGE_HEADERS } from '../helpers/owner-page.js';

let projectRoot: string;
let contextRoot: string;
let fakeHome: string;
let realHome: string | undefined;

function req(body: unknown): IncomingMessage {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(body), 'utf-8')]), { method: 'POST', headers: { ...OWNER_PAGE_HEADERS } }) as unknown as IncomingMessage;
}

async function save(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  let out: unknown = null;
  const res = { writeHead() {}, setHeader() {}, end(d: string) { out = JSON.parse(d); } } as unknown as ServerResponse;
  await handleAutomationsUpdate(req(body), res, { slug: 'digest' }, contextRoot);
  return out as Record<string, unknown>;
}

const approved = (): boolean => checkApproval(projectRoot, getAutomation(contextRoot, 'digest')!, undefined, 'run').approved;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-tool-route-'));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'automations'), { recursive: true });
  realHome = process.env.HOME;
  fakeHome = mkdtempSync(join(tmpdir(), 'dc-tool-route-home-'));
  process.env.HOME = fakeHome;
  const m = createAutomation(contextRoot, { slug: 'digest', title: 'Digest', days: 'daily', at: '09:00', prompt: 'Write the digest.' });
  approveAutomation(projectRoot, m, new Date());
});

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
});

// plan-r10 1e: another tool is a WIDENING change. The owner's own save says so first (409 with the
// fields, nothing written), and his save with `confirmWiden` IS the approval: no card for him.
describe('saving an automation whose tool changed', () => {
  it('without confirmWiden: 409 with the fields, nothing written, still approved', async () => {
    const r = await save({ tool: 'codex' });
    expect(r).toMatchObject({ error: 'widen_unconfirmed', fields: ['tool'] });
    expect(getAutomation(contextRoot, 'digest')?.tool ?? null).toBeNull();
    expect(approved()).toBe(true);
  });

  it('with confirmWiden the owner\'s save stamps the new tool; later saves keep it approved', async () => {
    expect((await save({ tool: 'codex', confirmWiden: ['tool'] })).needsApproval).toBeUndefined();
    expect(approved()).toBe(true);
    expect(getApproval(projectRoot, 'digest')?.tool).toBe('codex');
    // The dialog resends the same tool with any later edit: no widening, no confirm.
    expect((await save({ tool: 'codex', title: 'Digest again' })).needsApproval).toBeUndefined();
    expect(approved()).toBe(true);
  });

  it('going back to Claude is a tool change too: confirmed, then stamped', async () => {
    await save({ tool: 'codex', confirmWiden: ['tool'] });
    expect((await save({ tool: 'claude' })).error).toBe('widen_unconfirmed');
    expect((await save({ tool: 'claude', confirmWiden: ['tool'] })).needsApproval).toBeUndefined();
    expect(approved()).toBe(true);
  });

  it('a later save never stamps over a tool change that arrived from elsewhere (a synced edit)', async () => {
    // A teammate's file now names codex: the hash moved with no local stamp.
    const m = getAutomation(contextRoot, 'digest')!;
    const { readFileSync, writeFileSync } = await import('node:fs');
    writeFileSync(m.path, readFileSync(m.path, 'utf-8').replace(/^---\n/, '---\ntool: codex\n'));
    expect(approved()).toBe(false);
    expect((await save({ title: 'Digest once more' })).needsApproval).toBe(true);
    expect(approved()).toBe(false);
  });

  it('an ordinary save of a Claude automation changes nothing', async () => {
    expect((await save({ title: 'Digest x' })).needsApproval).toBeUndefined();
    expect(approved()).toBe(true);
    expect(getApproval(projectRoot, 'digest')).not.toHaveProperty('tool');
  });
});
