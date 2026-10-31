/** Track T W4, end-review finding: a later save must not stamp away a tool waiting for approval. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { approveAutomation, checkApproval, getApproval } from '../../src/lib/automations/registry.js';
import { createAutomation, getAutomation } from '../../src/lib/automations/store.js';
import { handleAutomationsUpdate } from '../../src/server/routes/automations.js';

let projectRoot: string;
let contextRoot: string;
let fakeHome: string;
let realHome: string | undefined;

function req(body: unknown): IncomingMessage {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(body), 'utf-8')]), { method: 'POST', headers: {} }) as unknown as IncomingMessage;
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

describe('saving an automation whose tool changed', () => {
  it('waits for the owner, across every later save', async () => {
    expect((await save({ tool: 'codex' })).needsApproval).toBe(true);
    expect(approved()).toBe(false);
    // The dialog resends the same tool with any later edit.
    expect((await save({ tool: 'codex', title: 'Digest again' })).needsApproval).toBe(true);
    expect((await save({ title: 'Digest once more' })).needsApproval).toBe(true);
    expect(approved()).toBe(false);
  });

  it('the owner approves, then ordinary saves re-approve as they always did', async () => {
    await save({ tool: 'codex' });
    approveAutomation(projectRoot, getAutomation(contextRoot, 'digest')!, new Date());
    expect(getApproval(projectRoot, 'digest')?.tool).toBe('codex');
    expect((await save({ tool: 'codex', title: 'Digest again' })).needsApproval).toBeUndefined();
    expect(approved()).toBe(true);
  });

  it('going back to Claude waits too', async () => {
    await save({ tool: 'codex' });
    approveAutomation(projectRoot, getAutomation(contextRoot, 'digest')!, new Date());
    expect((await save({ tool: 'claude' })).needsApproval).toBe(true);
    expect((await save({ title: 'Digest x' })).needsApproval).toBe(true);
    expect(approved()).toBe(false);
  });

  it('an ordinary save of a Claude automation changes nothing', async () => {
    expect((await save({ title: 'Digest x' })).needsApproval).toBeUndefined();
    expect(approved()).toBe(true);
    expect(getApproval(projectRoot, 'digest')).not.toHaveProperty('tool');
  });
});
