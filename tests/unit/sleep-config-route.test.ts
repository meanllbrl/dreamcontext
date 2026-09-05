import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleConfigUpdate } from '../../src/server/routes/config.js';
import { writeSetupConfig, readSetupConfig } from '../../src/lib/setup-config.js';
import { resolveSleepThresholds, DEFAULT_SLEEP_THRESHOLDS } from '../../src/lib/sleep-consolidation.js';

/**
 * A5: the dashboard writes sleep settings through `PATCH /api/config`, and it
 * must accept EXACTLY what `dreamcontext sleep config set` accepts — a UI that
 * saves a ladder the CLI would refuse (and the reader silently discards) is the
 * "setting that does nothing" failure this workstream exists to remove.
 */

function makeRes(): { res: ServerResponse; status: () => number; body: () => any } {
  let statusCode = 0;
  let responseBody: unknown = null;
  const res = {
    writeHead(code: number) { statusCode = code; },
    end(data: string) { try { responseBody = JSON.parse(data); } catch { responseBody = data; } },
    setHeader() {},
  } as unknown as ServerResponse;
  return { res, status: () => statusCode, body: () => responseBody as any };
}

function makePatchReq(bodyObj: unknown): IncomingMessage {
  const readable = Readable.from([Buffer.from(JSON.stringify(bodyObj))]);
  return Object.assign(readable, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
  }) as unknown as IncomingMessage;
}

let tmpDir: string;
let contextRoot: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `sleep-cfg-rt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  contextRoot = join(tmpDir, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  writeSetupConfig(tmpDir, {
    platforms: ['claude'], packs: [], multiProduct: false, setupVersion: '1.0.0', disableNativeMemory: true,
  });
});
afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

async function patch(body: unknown) {
  const r = makeRes();
  await handleConfigUpdate(makePatchReq(body), r.res, {}, contextRoot);
  return r;
}

describe('PATCH /api/config — sleep block', () => {
  it('saves a complete, monotonic ladder', async () => {
    const r = await patch({ sleep: { thresholds: { drowsy: 10, sleepy: 20, mustSleep: 30 } } });
    expect(r.status()).toBe(200);
    expect(readSetupConfig(tmpDir)?.sleep?.thresholds).toEqual({ drowsy: 10, sleepy: 20, mustSleep: 30 });
    expect(resolveSleepThresholds(readSetupConfig(tmpDir)?.sleep).deepAuthority).toBe(45);
  });

  it('REFUSES a non-monotonic ladder with 400 and the reason, saving nothing', async () => {
    const r = await patch({ sleep: { thresholds: { mustSleep: 30 } } });
    expect(r.status()).toBe(400);
    expect(r.body().error).toBe('invalid_sleep');
    expect(r.body().message).toContain('sleepy (40) must be less than must-sleep (30)');
    expect(readSetupConfig(tmpDir)?.sleep).toBeUndefined();
  });

  it('accepts lowering all three at once — a simultaneous edit is not judged on an intermediate state', async () => {
    await patch({ sleep: { thresholds: { drowsy: 24, sleepy: 40, mustSleep: 60 } } });
    const r = await patch({ sleep: { thresholds: { drowsy: 8, sleepy: 16, mustSleep: 24 } } });
    expect(r.status()).toBe(200);
    expect(readSetupConfig(tmpDir)?.sleep?.thresholds).toEqual({ drowsy: 8, sleepy: 16, mustSleep: 24 });
  });

  it('MERGES rather than replaces — an untouched field survives another PATCH', async () => {
    await patch({ sleep: { maxNewTasksPerCycle: 2 } });
    await patch({ sleep: { specialists: { 'sleep-tasks': { model: 'claude-opus-5' } } } });
    const sleep = readSetupConfig(tmpDir)?.sleep;
    expect(sleep?.maxNewTasksPerCycle).toBe(2);
    expect(sleep?.specialists?.['sleep-tasks']?.model).toBe('claude-opus-5');
  });

  it('null resets a field back to the default', async () => {
    await patch({ sleep: { thresholds: { drowsy: 10, sleepy: 20, mustSleep: 30 }, maxNewTasksPerCycle: 1 } });
    const r = await patch({ sleep: { thresholds: null } });
    expect(r.status()).toBe(200);
    const sleep = readSetupConfig(tmpDir)?.sleep;
    expect(sleep?.thresholds).toBeUndefined();
    expect(sleep?.maxNewTasksPerCycle).toBe(1);          // untouched
    expect(resolveSleepThresholds(sleep)).toEqual(DEFAULT_SLEEP_THRESHOLDS);
  });

  it('refuses an unknown specialist, an unknown model and a bad effort', async () => {
    for (const [body, needle] of [
      [{ specialists: { 'sleep-nonsense': { effort: 'low' } } }, 'Unknown specialist'],
      [{ specialists: { 'sleep-tasks': { model: 'claude-opus-9' } } }, 'not a model this build knows'],
      [{ specialists: { 'sleep-tasks': { effort: 'xhigh' } } }, 'effort must be one of'],
    ] as const) {
      const r = await patch({ sleep: body });
      expect(r.status()).toBe(400);
      expect(r.body().message).toContain(needle);
    }
    expect(readSetupConfig(tmpDir)?.sleep).toBeUndefined();
  });

  it('refuses a shell-unsafe model over HTTP', async () => {
    const r = await patch({ sleep: { specialists: { 'sleep-tasks': { model: 'opus; rm -rf /' } } } });
    expect(r.status()).toBe(400);
    expect(readSetupConfig(tmpDir)?.sleep).toBeUndefined();
  });

  it.each([
    ['a non-object', 'nope'],
    ['an array', [1, 2]],
    ['null', null],
  ])('refuses %s as the sleep block', async (_n, sleep) => {
    const r = await patch({ sleep });
    expect(r.status()).toBe(400);
  });

  it('refuses an out-of-range cap but accepts 0', async () => {
    expect((await patch({ sleep: { maxNewTasksPerCycle: 51 } })).status()).toBe(400);
    expect((await patch({ sleep: { maxNewTasksPerCycle: -1 } })).status()).toBe(400);
    expect((await patch({ sleep: { maxNewTasksPerCycle: 0 } })).status()).toBe(200);
    expect(readSetupConfig(tmpDir)?.sleep?.maxNewTasksPerCycle).toBe(0);
  });

  it('never touches the rest of the config', async () => {
    await patch({ sleep: { maxNewTasksPerCycle: 3 } });
    const cfg = readSetupConfig(tmpDir);
    expect(cfg?.platforms).toEqual(['claude']);
    expect(cfg?.setupVersion).toBe('1.0.0');
  });

  it('an empty patch is still rejected as no_changes', async () => {
    const r = await patch({});
    expect(r.status()).toBe(400);
    expect(r.body().error).toBe('no_changes');
    expect(r.body().message).toContain('sleep');
  });
});
