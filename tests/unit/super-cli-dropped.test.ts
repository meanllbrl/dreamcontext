/**
 * `dreamcontext super …` when the app takes the call and closes it without an answer (field
 * 2026-11-15: `delegate` said "the app is not reachable: socket hang up" while the worktree had
 * been made). A dropped call is `no_answer`, "it may have acted"; an app that is not there is
 * still `unreachable`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { callSuper, droppedOrUnreachable } from '../../src/cli/commands/super.js';

let server: Server | null = null;
afterEach(async () => { await new Promise<void>((done) => (server ? server.close(() => done()) : done())); server = null; });

const env = (url: string) => ({ DREAMCONTEXT_WINDOW_URL: url, DREAMCONTEXT_WINDOW_TOKEN: 'a'.repeat(48) });

describe('super CLI, a dropped call', () => {
  it('a connection closed with no answer is no_answer and says to check state first', async () => {
    server = createServer((req) => { req.resume(); req.on('end', () => req.socket.destroy()); });
    await new Promise<void>((done) => server!.listen(0, '127.0.0.1', () => done()));
    const r = await callSuper('delegate', { prompt: 'x' }, env(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
    expect(r.status).toBe(0);
    expect(r.body.error).toBe('no_answer');
    expect(String(r.body.message)).toMatch(/may have acted.*super state/);
  });

  it('a refused connection is still unreachable', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' });
    expect(droppedOrUnreachable(err)).toMatchObject({ error: 'unreachable' });
  });
});
