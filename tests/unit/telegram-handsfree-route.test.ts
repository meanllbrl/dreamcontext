/**
 * `/api/handsfree/mac/stop` names why and whether the stop was keyed (plan E3): a request with no
 * Origin is an HTTP stop, unkeyed without the owner key (its Telegram message says so); the Mac
 * panel's own page reads "Mac'ten kapatıldı".
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handsfreeMacRoutes, setMacSessionForTests } from '../../src/server/routes/handsfree-mac.js';

function req(headers: Record<string, string> = {}): IncomingMessage {
  const r = new EventEmitter() as IncomingMessage & EventEmitter;
  Object.assign(r, { method: 'POST', url: '/api/handsfree/mac/stop', headers: { host: '127.0.0.1:41000', ...headers }, socket: { remoteAddress: '127.0.0.1' } });
  setImmediate(() => r.emit('end'));
  return r;
}
async function call(q: IncomingMessage): Promise<number> {
  let status = 0;
  const res = { setHeader() {}, writeHead(s: number) { status = s; return this; }, end() {}, write() { return true; } };
  await handsfreeMacRoutes.stop(q, res as unknown as ServerResponse);
  return status;
}
beforeAll(() => { process.env.DREAMCONTEXT_DESKTOP = '1'; });
afterEach(() => setMacSessionForTests(null));

describe('stop route', () => {
  it('no Origin → reason http, unkeyed; the Mac panel → reason mac, keyed', async () => {
    const stop = vi.fn(async () => {});
    setMacSessionForTests({ stop, status: () => ({}) } as never);
    expect(await call(req())).toBe(200);
    expect(stop).toHaveBeenLastCalledWith({ reason: 'http', keyed: false });
    await call(req({ origin: 'http://127.0.0.1:41000', 'sec-fetch-site': 'same-origin' }));
    expect(stop).toHaveBeenLastCalledWith({ reason: 'mac', keyed: true });
  });
});
