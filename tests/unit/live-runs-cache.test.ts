/**
 * goal-live / council-live read caches (src/server/routes/agent-terminal.ts) — task: the desktop
 * app stays light on an 8GB MacBook Air, plan S7.
 *
 * Both panels poll every 2 s per pane; each poll used to list `tmp/` and re-parse every live
 * file. The listing is now kept per directory mtime and each parse per file stat, while the
 * 3 h staleness check still runs on every call (a run goes stale without any write).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  goalLiveRunFor, handleAgentCouncilLive, liveFileParses, resetLiveRunCachesForTests,
} from '../../src/server/routes/agent-terminal.js';

const SESSION = '11111111-2222-3333-4444-555555555555';
let root: string;
let tmp: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-live-cache-'));
  tmp = join(root, 'tmp');
  mkdirSync(tmp, { recursive: true });
  resetLiveRunCachesForTests();
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

function writeGoal(phase: string, mtimeSec?: number): string {
  const p = join(tmp, `.goal-skill-live.${SESSION}.json`);
  const now = new Date().toISOString();
  writeFileSync(p, JSON.stringify({ session: SESSION, started: now, updated: now, phase }));
  if (mtimeSec !== undefined) utimesSync(p, mtimeSec, mtimeSec);
  return p;
}

async function council(): Promise<unknown> {
  let body: unknown = null;
  const res = { writeHead() {}, setHeader() {}, end(d: string) { body = JSON.parse(d); } } as unknown as ServerResponse;
  const req = { method: 'GET', url: `/api/agent/council-live?claudeId=${SESSION}`, headers: { host: 'localhost' } } as unknown as IncomingMessage;
  await handleAgentCouncilLive(req, res, {}, root);
  return body;
}

describe('goalLiveRunFor cache', () => {
  it('an unchanged live file is parsed once over many polls', () => {
    writeGoal('plan');
    for (let i = 0; i < 20; i++) expect(goalLiveRunFor(root, SESSION)?.phase).toBe('plan');
    expect(liveFileParses()).toBe(1);
  });

  it('a rewritten live file is seen on the next poll', () => {
    writeGoal('plan', 1_000);
    expect(goalLiveRunFor(root, SESSION)?.phase).toBe('plan');
    writeGoal('build', 2_000);
    expect(goalLiveRunFor(root, SESSION)?.phase).toBe('build');
  });

  it('a new live file appearing in tmp is listed on the next poll', () => {
    expect(goalLiveRunFor(root, SESSION)).toBeNull();
    writeGoal('plan');
    expect(goalLiveRunFor(root, SESSION)?.phase).toBe('plan');
  });

  it('the 3 h staleness check runs on every call, not once', () => {
    writeGoal('plan');
    expect(goalLiveRunFor(root, SESSION)).not.toBeNull();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 4 * 60 * 60 * 1000);
    expect(goalLiveRunFor(root, SESSION)).toBeNull();
    expect(liveFileParses()).toBe(1);
  });

  it('a malformed file is skipped, and read again once rewritten', () => {
    const p = join(tmp, `.goal-skill-live.${SESSION}.json`);
    writeFileSync(p, '{not json');
    utimesSync(p, 1_000, 1_000);
    expect(goalLiveRunFor(root, SESSION)).toBeNull();
    expect(goalLiveRunFor(root, SESSION)).toBeNull();
    expect(liveFileParses()).toBe(1);
    writeGoal('plan', 2_000);
    expect(goalLiveRunFor(root, SESSION)?.phase).toBe('plan');
  });
});

describe('council-live cache', () => {
  it('parses an unchanged file once and sees a rewrite', async () => {
    const p = join(tmp, '.council-live.json');
    const now = new Date().toISOString();
    writeFileSync(p, JSON.stringify({ session: SESSION, started: now, updated: now, round: 1 }));
    utimesSync(p, 1_000, 1_000);
    for (let i = 0; i < 5; i++) expect(await council()).toMatchObject({ active: true, state: { round: 1 } });
    expect(liveFileParses()).toBe(1);
    writeFileSync(p, JSON.stringify({ session: SESSION, started: now, updated: now, round: 2 }));
    utimesSync(p, 2_000, 2_000);
    expect(await council()).toMatchObject({ active: true, state: { round: 2 } });
  });

  it('no file is inactive', async () => {
    expect(await council()).toEqual({ active: false });
  });
});
