// The laptop's transfer client on PINNED WIRE CONTRACT v1, against an injected fetch whose
// "server" verifies every proof with the real W1 HandsfreeAuth (nonce + HMAC bound to method
// and exact target, single use), the Origin on writes, retries, the post-start 302 grace,
// port_private, chunked uploads/downloads and error mapping.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HandsfreeAuth, hashPassphrase, sha256Hex } from '../../src/server/handsfree-auth.js';
import {
  CHUNK_BYTES, CloudError, SNAPSHOT_TIMEOUT_MS, CloudUnreachableError, HttpCloudClient, manifestDigest, PortPrivateError,
} from '../../src/lib/handsfree/cloud-client.js';

const ORIGIN = 'https://cs-abc-8080.app.github.dev';
let dir: string;
let auth: HandsfreeAuth;
let secret: string;

interface Seen { method: string; target: string; origin: string | null; ok: boolean; body: Buffer | null }

function server(handler: (s: Seen) => { status: number; json?: unknown; raw?: Buffer; headers?: Record<string, string> }) {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const target = u.pathname + u.search;
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers as Record<string, string>);
    const body = init?.body ? Buffer.from(init.body as Uint8Array) : null;
    const s: Seen = { method, target, origin: headers.get('origin'), ok: false, body };
    if (target === '/api/health' && !headers.get('authorization')) {
      return new Response(JSON.stringify({ version: '1', fingerprint: 'fp' }), { status: 200, headers: { 'X-Dreamcontext-Nonce': auth.issueNonce() } });
    }
    s.ok = auth.verifyTransferProof(headers.get('authorization') ?? undefined, method, target);
    seen.push(s);
    if (!s.ok) return new Response(JSON.stringify({ error: 'unauthorized', message: 'no' }), { status: 401 });
    const r = handler(s);
    return new Response(r.raw ? new Uint8Array(r.raw) : JSON.stringify(r.json ?? {}), { status: r.status, headers: r.headers });
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hf-client-'));
  secret = randomBytes(32).toString('base64url');
  auth = new HandsfreeAuth({ dir, sleep: async () => {} });
  expect(auth.store.installVerifiers({ generation: 1, passphrase: await hashPassphrase('a b c d e f'), transferSha256: sha256Hex(secret) }).ok).toBe(true);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const client = (fetchImpl: typeof fetch, now = () => Date.now()) => new HttpCloudClient({ origin: ORIGIN, secret, fetchImpl, sleep: async () => {}, now });

describe('transfer proof', () => {
  it('r18: health carries the cloud\'s checkoutCompromised flag (only a literal true counts)', async () => {
    for (const [v, want] of [[true, true], ['true', false], [1, false]] as const) {
      const { fetchImpl } = server(() => ({ status: 200, json: { phase: 'sealed', version: '1', fingerprint: 'fp', tripId: null, laptopId: null, epoch: 0, verifierGeneration: 1, supersededLaptopIds: [], checkoutCompromised: v } }));
      expect((await client(fetchImpl).health()).checkoutCompromised).toBe(want);
    }
  });

  it('every request carries a fresh nonce + HMAC bound to method and exact target; writes carry Origin', async () => {
    const { seen, fetchImpl } = server((s) => (s.target.startsWith('/api/handsfree/cloud/state')
      ? { status: 200, json: { kind: 'files', manifest: [] } }
      : { status: 200, json: { phase: 'active', version: '1', fingerprint: 'fp', tripId: 't-1', laptopId: 'lp-1', epoch: 3, verifierGeneration: 1, supersededLaptopIds: [] } }));
    const c = client(fetchImpl);
    const h = await c.health();
    expect(h).toMatchObject({ phase: 'active', epoch: 3, tripId: 't-1' });
    expect(h.checkoutCompromised).toBe(false); // an older cloud without the field

    await c.state('r-0123456789abcdef');
    expect(seen.map((s) => s.target)).toEqual(['/api/health', '/api/handsfree/cloud/state?rootId=r-0123456789abcdef']);
    expect(seen.every((s) => s.ok)).toBe(true);
    expect(seen.every((s) => s.origin === null)).toBe(true); // GETs carry no Origin
  });

  it('a write sends Origin = DC_HF_ORIGIN and maps a sendError body to CloudError', async () => {
    const { seen, fetchImpl } = server(() => ({ status: 409, json: { error: 'epoch_mismatch', message: 'epoch moved' } }));
    await expect(client(fetchImpl).seal(4)).rejects.toMatchObject({ name: 'CloudError', status: 409, code: 'epoch_mismatch' });
    expect(seen[0]).toMatchObject({ method: 'POST', target: '/api/handsfree/cloud/seal', origin: ORIGIN, ok: true });
    expect(JSON.parse(seen[0].body!.toString())).toEqual({ epoch: 4 });
  });

  it('replies are validated before use', async () => {
    const { fetchImpl } = server(() => ({ status: 200, json: { epoch: -1, running: [] } }));
    await expect(client(fetchImpl).quiesce('t-1')).rejects.toBeInstanceOf(CloudError);
  });
});

describe('retries and the private port', () => {
  it('retries 503/504 and network errors with a fresh nonce each time', async () => {
    let n = 0;
    const { seen, fetchImpl } = server(() => (++n < 3 ? { status: 503, json: {} } : { status: 200, json: { ok: true, restarting: true } }));
    await client(fetchImpl).runtime({ version: '0.30.0', integrity: `sha512-${'A'.repeat(86)}==` });
    expect(seen.filter((s) => s.ok).length).toBe(3);
  });

  it('a 302 to github.com is retried for 30 s after a start, then it is port_private', async () => {
    let t = 1_000_000;
    let redirect = true;
    const fetchImpl = (async (url: string) => {
      if (redirect) return new Response(null, { status: 302, headers: { location: 'https://github.com/login?return_to=x' } });
      return new Response(JSON.stringify({ version: '1', fingerprint: null }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = new HttpCloudClient({ origin: ORIGIN, secret, fetchImpl, sleep: async () => { t += 5000; if (t > 1_012_000) redirect = false; }, now: () => t });
    c.markStarted(t);
    expect(await c.publicHealth()).toEqual({ version: '1', fingerprint: null });
    redirect = true;
    t += 60_000;
    await expect(c.publicHealth()).rejects.toBeInstanceOf(PortPrivateError);
  });

  it('gives up with CloudUnreachableError after the attempts', async () => {
    const fetchImpl = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    await expect(client(fetchImpl).publicHealth()).rejects.toBeInstanceOf(CloudUnreachableError);
  });
});

describe('uploads and downloads', () => {
  it('uploads in <= 8 MiB chunks numbered from 0, then commits {size, sha256}', async () => {
    const file = join(dir, 'big.bin');
    const data = randomBytes(CHUNK_BYTES + 1234);
    writeFileSync(file, data);
    const { seen, fetchImpl } = server(() => ({ status: 200, json: { ok: true } }));
    const id = await client(fetchImpl).uploadFile(file);
    expect(id).toMatch(/^[a-z0-9-]{8,64}$/);
    const puts = seen.filter((s) => s.method === 'PUT');
    expect(puts.map((s) => s.target)).toEqual([`/api/handsfree/cloud/upload/${id}/0`, `/api/handsfree/cloud/upload/${id}/1`]);
    expect(puts.map((s) => s.body!.length)).toEqual([CHUNK_BYTES, 1234]);
    const commit = seen.find((s) => s.target.endsWith('/commit'))!;
    expect(JSON.parse(commit.body!.toString())).toEqual({ size: data.length, sha256: createHash('sha256').update(data).digest('hex') });
  });

  it('downloads by offset/length and verifies the sha256', async () => {
    const data = randomBytes(CHUNK_BYTES + 99);
    const { seen, fetchImpl } = server((s) => {
      const u = new URL('http://x' + s.target);
      const off = Number(u.searchParams.get('offset'));
      const len = Number(u.searchParams.get('length'));
      return { status: 200, raw: data.subarray(off, off + len) };
    });
    const out = join(dir, 'dl.bin');
    await client(fetchImpl).downloadTo({ id: 'dl-abcdefgh', size: data.length, sha256: createHash('sha256').update(data).digest('hex') }, out);
    expect(readFileSync(out).equals(data)).toBe(true);
    expect(seen.length).toBe(2);
    await expect(client(fetchImpl).downloadTo({ id: 'dl-abcdefgh', size: data.length, sha256: '0'.repeat(64) }, join(dir, 'bad.bin'))).rejects.toMatchObject({ code: 'download_mismatch' });
  });
});

describe('manifestDigest', () => {
  it('is order-independent over path\\0sha256\\n lines', () => {
    const a = { path: 'a', sha256: '1'.repeat(64) };
    const b = { path: 'b', sha256: '2'.repeat(64) };
    expect(manifestDigest([a, b])).toBe(manifestDigest([b, a]));
    expect(manifestDigest([a])).not.toBe(manifestDigest([b]));
  });
});

describe('snapshot timeout', () => {
  it('waits longer than the cloud\'s 30 min snapshot budget, so it never retries one still running', () => {
    expect(SNAPSHOT_TIMEOUT_MS).toBeGreaterThanOrEqual(30 * 60_000);
  });
});
