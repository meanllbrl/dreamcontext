/**
 * One HTTP call from a verify script, on its OWN connection (`agent: false`, `Connection: close`).
 *
 * Why not `fetch`: a verify script runs the CLI with `spawnSync`, which blocks the event loop for
 * seconds. Meanwhile the server (seen with the dashboard's Vite dev server) closes the keep-alive
 * socket `fetch` pooled from an earlier call, and the blocked loop never learns it. The next call
 * after the CLI goes out on that dead socket: a GET may be retried, a POST is not, and the script
 * reads ECONNRESET where the server would have answered (the 0.41.15 cut's data-share "reset" was
 * this, not the route). A fresh connection per call cannot be stale.
 *
 * Answers `{ status, headers, text, body }` (`body` is the parsed JSON, `{}` when it is not JSON).
 * A transport failure rejects, with the error's `code` (ECONNREFUSED, ECONNRESET, ETIMEDOUT after
 * `timeoutMs` of silence, default 60 s).
 */
import http from 'node:http';

export function request(url, { method = 'GET', headers = {}, body, timeoutMs = 60_000 } = {}) {
  const u = new URL(url);
  const payload = body === undefined ? undefined : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const head = { ...headers, connection: 'close' };
  if (payload) head['content-length'] = String(payload.length);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: `${u.pathname}${u.search}`, method, headers: head, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        let parsed = {};
        try { parsed = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, body: parsed });
      });
    });
    req.on('error', reject);
    // A server that accepts and never answers must not hang the script.
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error(`no answer in ${timeoutMs} ms`), { code: 'ETIMEDOUT' })));
    req.end(payload);
  });
}
