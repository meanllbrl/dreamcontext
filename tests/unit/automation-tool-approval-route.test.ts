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

// Owner 2026-11-07: nothing made on this Mac asks. Another tool is a widening change, and the
// owner's own save of it IS the approval: no inline confirm, no card.
describe('saving an automation whose tool changed', () => {
  it('his save of a new tool writes it and stamps it at once: no 409, no confirm', async () => {
    const r = await save({ tool: 'codex' });
    expect(r.error).toBeUndefined();
    expect(r.needsApproval).toBeUndefined();
    expect(getAutomation(contextRoot, 'digest')?.tool).toBe('codex');
    expect(approved()).toBe(true);
  });

  it('the owner\'s save stamps the new tool; later saves keep it approved', async () => {
    expect((await save({ tool: 'codex' })).needsApproval).toBeUndefined();
    expect(approved()).toBe(true);
    expect(getApproval(projectRoot, 'digest')?.tool).toBe('codex');
    // The dialog resends the same tool with any later edit: no widening, no confirm.
    expect((await save({ tool: 'codex', title: 'Digest again' })).needsApproval).toBeUndefined();
    expect(approved()).toBe(true);
  });

  it('going back to Claude is a tool change too: stamped the same way', async () => {
    await save({ tool: 'codex' });
    const back = await save({ tool: 'claude' });
    expect(back.error).toBeUndefined();
    expect(back.needsApproval).toBeUndefined();
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
