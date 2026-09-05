import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleSleepAutoGet, handleSleepAutoPut, handleSleepAutoCancel, handleSleepSpecialistsGet } from '../../src/server/routes/sleep.js';
import { mkdirSync as mkdir, writeFileSync } from 'node:fs';
import { readBrainLocal, writeSetupConfig, updateSetupConfig } from '../../src/lib/setup-config.js';
import { writeAutoSleepSidecar } from '../../src/lib/auto-sleep-runner.js';
import { currentAutoSleepFingerprint } from '../../src/lib/auto-sleep.js';

/**
 * The dashboard half of C4. What matters here is that the API cannot arm
 * background sleep in a state the Stop hook would then refuse to act on — an
 * "ON" toggle over a brain that never consolidates is the worst outcome.
 */

function makeRes() {
  let statusCode = 0;
  let body: any = null;
  const res = {
    writeHead(c: number) { statusCode = c; },
    end(d: string) { try { body = JSON.parse(d); } catch { body = d; } },
    setHeader() {},
  } as unknown as ServerResponse;
  return { res, status: () => statusCode, body: () => body };
}
const req = (b?: unknown) => (b === undefined
  ? ({ method: 'GET', headers: {} } as unknown as IncomingMessage)
  : Object.assign(Readable.from([Buffer.from(JSON.stringify(b))]), {
      method: 'PUT', headers: { 'content-type': 'application/json' },
    }) as unknown as IncomingMessage);

let project = '';
let ctx = '';
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'dc-auto-rt-'));
  ctx = join(project, '_dream_context');
  mkdirSync(join(ctx, 'state'), { recursive: true });
  writeSetupConfig(project, { platforms: ['claude'], packs: [], multiProduct: false, setupVersion: '1.0.0', disableNativeMemory: true });
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

async function get() { const r = makeRes(); await handleSleepAutoGet(req(), r.res, {}, ctx); return r; }
async function put(b: unknown) { const r = makeRes(); await handleSleepAutoPut(req(b), r.res, {}, ctx); return r; }
async function cancel() { const r = makeRes(); await handleSleepAutoCancel(req(), r.res, {}, ctx); return r; }

describe('GET /api/sleep/auto', () => {
  it('reports off on a fresh brain', async () => {
    const r = await get();
    expect(r.status()).toBe(200);
    expect(r.body()).toMatchObject({ enabled: false, consentStale: false, job: null, jobLive: false });
  });
});

describe('PUT /api/sleep/auto', () => {
  it('arms it and stores an approval that the hook will accept', async () => {
    const r = await put({ enabled: true, trigger: 'must-sleep' });
    expect(r.status()).toBe(200);
    const stored = readBrainLocal(project).autoSleep!;
    expect(stored.enabled).toBe(true);
    // The stored fingerprint must MATCH what the hook computes right now, or
    // the toggle would say ON while every cycle refuses as consent-stale.
    expect(stored.approvedFingerprint).toBe(currentAutoSleepFingerprint(project));
    expect((await get()).body()).toMatchObject({ enabled: true, consentStale: false });
  });

  it('stores the trigger BEFORE fingerprinting, so `sleepy` is not instantly stale', async () => {
    await put({ enabled: true, trigger: 'sleepy' });
    const stored = readBrainLocal(project).autoSleep!;
    expect(stored.trigger).toBe('sleepy');
    expect(stored.approvedFingerprint).toBe(currentAutoSleepFingerprint(project));
    expect((await get()).body().consentStale).toBe(false);
  });

  it('reports consentStale once an approved setting changes underneath it', async () => {
    await put({ enabled: true });
    updateSetupConfig(project, { sleep: { maxNewTasksPerCycle: 2 } });
    expect((await get()).body()).toMatchObject({ enabled: true, consentStale: true });
  });

  it('re-approving clears it', async () => {
    await put({ enabled: true });
    updateSetupConfig(project, { sleep: { maxNewTasksPerCycle: 2 } });
    await put({ enabled: true });
    expect((await get()).body().consentStale).toBe(false);
  });

  it('disables without losing the record', async () => {
    await put({ enabled: true });
    const r = await put({ enabled: false });
    expect(r.status()).toBe(200);
    expect(readBrainLocal(project).autoSleep?.enabled).toBe(false);
    expect((await get()).body()).toMatchObject({ enabled: false, consentStale: false });
  });

  it('refuses a bad body', async () => {
    expect((await put({})).status()).toBe(400);
    expect((await put({ enabled: 'yes' })).status()).toBe(400);
    expect((await put({ enabled: true, trigger: 'whenever' })).status()).toBe(400);
  });
});

describe('POST /api/sleep/auto/cancel', () => {
  it('404s when nothing is running', async () => {
    expect((await cancel()).status()).toBe(404);
  });

  it('409s with the reason when the kill is refused', async () => {
    writeAutoSleepSidecar(ctx, { pid: process.pid, pgid: 1, startedAt: new Date().toISOString(), status: 'running', epoch: null });
    const r = await cancel();
    expect(r.status()).toBe(409);
    expect(r.body().message).toContain('refusing to kill');
  });

  it('409s for a job that already finished', async () => {
    writeAutoSleepSidecar(ctx, { pid: process.pid, pgid: process.pid, startedAt: new Date().toISOString(), status: 'ok', epoch: null });
    expect((await cancel()).status()).toBe(409);
  });

  it('surfaces a live job through GET', async () => {
    writeAutoSleepSidecar(ctx, { pid: process.pid, pgid: process.pid, startedAt: new Date().toISOString(), status: 'running', epoch: null });
    expect((await get()).body()).toMatchObject({ jobLive: true });
  });
});


describe('GET /api/sleep/specialists — what "Package default" actually means', () => {
  /**
   * Six dropdowns all reading "Package default" tell you the brain is
   * unconfigured, not what it will run. This route is what lets the picker name
   * the value it falls back to — the same thing `dreamcontext sleep config`
   * prints, from the same source (the installed agent frontmatter).
   */
  async function specialists() {
    const r = makeRes();
    await handleSleepSpecialistsGet(req(), r.res, {}, ctx);
    return r;
  }

  function installAgent(name: string, model: string, effort?: string) {
    mkdir(join(project, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(project, '.claude', 'agents', `${name}.md`),
      `---\nname: ${name}\nmodel: ${model}\n${effort ? `effort: ${effort}\n` : ''}---\n\n# Body\n`);
  }

  it('reports every specialist, with nulls when nothing is installed', async () => {
    const r = await specialists();
    expect(r.status()).toBe(200);
    const d = r.body().defaults;
    expect(Object.keys(d)).toHaveLength(6);
    expect(d['sleep-tasks']).toEqual({ model: null, effort: null });
  });

  it('reads the model and effort the installed agent actually declares', async () => {
    installAgent('sleep-tasks', 'claude-opus-5', 'medium');
    installAgent('sleep-state', 'claude-sonnet-5', 'low');
    const d = (await specialists()).body().defaults;
    expect(d['sleep-tasks']).toEqual({ model: 'claude-opus-5', effort: 'medium' });
    expect(d['sleep-state']).toEqual({ model: 'claude-sonnet-5', effort: 'low' });
  });

  it('an agent with no effort key reports a null effort, not a guess', async () => {
    installAgent('sleep-learn', 'claude-sonnet-5');
    expect((await specialists()).body().defaults['sleep-learn']).toEqual({ model: 'claude-sonnet-5', effort: null });
  });

  it('malformed frontmatter degrades to nulls rather than throwing', async () => {
    mkdir(join(project, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(project, '.claude', 'agents', 'sleep-product.md'), '---\nname: [broken\n  : : :\n---\n# B\n');
    const r = await specialists();
    expect(r.status()).toBe(200);
    expect(r.body().defaults['sleep-product'].model).toBeNull();
  });
});
