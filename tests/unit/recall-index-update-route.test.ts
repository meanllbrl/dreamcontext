import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answerIndexUpdate } from '../../src/server/routes/agent-sync.js';
import { noteIndexStop, readIndexStop } from '../../src/lib/embeddings/index-stop.js';

/** A request as the local dashboard sends it (loopback Host, matching Origin, loopback peer). */
const local = (patch: Partial<{ host: string; origin: string | undefined; peer: string }> = {}): IncomingMessage => {
  const host = patch.host ?? '127.0.0.1:4242';
  const headers: Record<string, string> = { host };
  const origin = 'origin' in patch ? patch.origin : `http://${host}`;
  if (origin !== undefined) headers.origin = origin;
  return { headers, socket: { remoteAddress: patch.peer ?? '127.0.0.1' } } as unknown as IncomingMessage;
};

describe('the owner\'s Update on a stopped cloud index', () => {
  let tmp: string;
  let home: string;
  let root: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'dc-index-update-'));
    home = join(tmp, 'home');
    root = join(tmp, 'vault', '_dream_context');
    mkdirSync(join(root, '.embeddings'), { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(root, '.embeddings', 'voyage-4.meta.json'), JSON.stringify({ updatedAt: '2026-11-01T00:00:00.000Z' }));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('refuses anything but the local dashboard, and starts nothing', () => {
    const kick = vi.fn(() => null);
    noteIndexStop(root, { reason: 'daily_index_cap' }, home);
    expect(answerIndexUpdate(local({ origin: undefined }), root, kick)).toMatchObject({ ok: false, status: 403 });
    expect(answerIndexUpdate(local({ origin: 'http://evil.example' }), root, kick)).toMatchObject({ ok: false, status: 403 });
    expect(answerIndexUpdate(local({ peer: '10.0.0.7' }), root, kick)).toMatchObject({ ok: false, status: 403 });
    expect(kick).not.toHaveBeenCalled();
  });

  it('a cap or failure stop runs at the normal per-build cap; a per-build cap stop gets its estimate +25%', () => {
    const kick = vi.fn(() => null);
    noteIndexStop(root, { reason: 'daily_index_cap' }, home);
    expect(answerIndexUpdate(local(), root, kick)).toEqual({ ok: true });
    expect(kick).toHaveBeenLastCalledWith(root, {});
    noteIndexStop(root, { reason: 'max_usd', estUsd: 2 }, home);
    expect(answerIndexUpdate(local(), root, kick)).toEqual({ ok: true });
    expect(kick).toHaveBeenLastCalledWith(root, { maxUsd: 2.5 });
  });

  it('re-arms the stop so a build that stops again raises his row again', () => {
    noteIndexStop(root, { reason: 'failed', error: 'auth' }, home);
    expect(readIndexStop(root)!.notifiedAt).not.toBeNull();
    answerIndexUpdate(local(), root, () => null);
    expect(readIndexStop(root)!.notifiedAt).toBeNull();
  });

  it('answers 409 for a vault with cloud recall off', () => {
    noteIndexStop(root, { reason: 'failed', error: 'auth' }, home);
    expect(answerIndexUpdate(local(), root, () => 'not_consented')).toMatchObject({ ok: false, status: 409, code: 'not_consented' });
    // nothing ran: the stop keeps its notified row
    expect(readIndexStop(root)!.notifiedAt).not.toBeNull();
  });
});
