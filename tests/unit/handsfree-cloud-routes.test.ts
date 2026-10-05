import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer, request, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { Router } from '../../src/server/router.js';
import { cloudGate, sendError } from '../../src/server/middleware.js';
import { isCloud, setCloudMirrorPrefix, setCloudPhaseSource } from '../../src/server/cloud-mode.js';
import {
  HandsfreeAuth, hashPassphrase, setHandsfreeAuthForTests, sha256Hex, transferAuthorization, transferKeyFromSecret,
} from '../../src/server/handsfree-auth.js';
import {
  RUNTIME_EXIT_CODE, RUNTIME_REQUEST_NAME, setRuntimeExitForTests,
  TRIP_MARKER_NAME, cloudPhaseFromStore, cloudServices, createCloudIdle, registerHandsfreeCloudRoutes, setCloudServicesForTests, wipeAndSeal,
} from '../../src/server/routes/handsfree-cloud.js';
import { handleHealthGet } from '../../src/server/routes/health.js';
import { CloudStateStore } from '../../src/server/cloud-state.js';
import { TransferStore } from '../../src/server/cloud-transfers.js';
import { manifestDigest, setWorkerInProcessForTests } from '../../src/server/cloud-worker.js';
import { buildManifest, encodeProjectDir, manifestToJSON, rootIdFor, selectNonGitEntries, type GoManifest } from '../../src/lib/handsfree/manifest.js';
import { createBundle, createSpawnRunner, snapshotBundleRefs, snapshotId, snapshotRepo } from '../../src/lib/handsfree/git-snapshot.js';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { writePack } from '../../src/lib/handsfree/pack.js';
import { registerLiveChat, unregisterLiveChat, type LiveChatEntry } from '../../src/server/routes/agent-chat-live.js';

const OWN = 'https://dc-hf-test-8080.app.github.dev';
const SECRET = 'transfer-secret-for-tests';
const key = transferKeyFromSecret(SECRET);
const HOME = '/Users/hftest';
const PROJ = `${HOME}/proj`;
const ENV_KEYS = ['HOME', 'DREAMCONTEXT_CLOUD', 'DREAMCONTEXT_DESKTOP', 'DC_HF_ORIGIN', 'DC_HF_SERVER_DIR', 'DC_HF_PUBLIC_DIR'];

let scratch: string;
let laptop: string;
let server: Server;
let port: number;
let auth: HandsfreeAuth;
let deviceId: string;
const saved: Record<string, string | undefined> = {};

function goManifest(tripId: string, laptopId: string): GoManifest {
  return {
    version: 1, tripId, laptopId, createdAt: new Date(0).toISOString(), home: HOME,
    roots: [{ rootId: rootIdFor(PROJ), kind: 'vault', absPath: PROJ }],
  };
}

interface Reply { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer; json: () => any } // eslint-disable-line @typescript-eslint/no-explicit-any

function raw(method: string, path: string, headers: Record<string, string>, body?: Buffer | string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (c: Buffer) => parts.push(c));
      res.on('end', () => {
        const b = Buffer.concat(parts);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b, json: () => JSON.parse(b.toString('utf-8')) });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function nonce(): Promise<string> {
  const r = await raw('GET', '/api/health', {});
  return String(r.headers['x-dreamcontext-nonce']);
}

/** One transfer request with a fresh HMAC proof (and Origin on writes), like the laptop. */
async function transfer(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Reply> {
  const n = await nonce();
  const headers: Record<string, string> = { Authorization: transferAuthorization(key, n, method, path), ...extra };
  if (method !== 'GET') headers.Origin = OWN;
  let payload: Buffer | string | undefined;
  if (Buffer.isBuffer(body)) payload = body;
  else if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
  return raw(method, path, headers, payload);
}

async function upload(id: string, data: Buffer): Promise<void> {
  const CH = 4096;
  let n = 0;
  for (let off = 0; off < data.length || n === 0; off += CH, n++) {
    const r = await transfer('PUT', `/api/handsfree/cloud/upload/${id}/${n}`, data.subarray(off, off + CH));
    expect(r.status).toBe(200);
    if (off + CH >= data.length) { n++; break; }
  }
  const c = await transfer('POST', `/api/handsfree/cloud/upload/${id}/commit`, { size: data.length, sha256: createHash('sha256').update(data).digest('hex') });
  expect(c.status).toBe(200);
}

beforeEach(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  scratch = mkdtempSync(join(tmpdir(), 'hf-cloud-routes-'));
  laptop = join(scratch, 'laptop');
  process.env.DREAMCONTEXT_CLOUD = '1';
  delete process.env.DREAMCONTEXT_DESKTOP;
  process.env.DC_HF_ORIGIN = OWN;
  process.env.DC_HF_SERVER_DIR = join(scratch, 'dc-server');
  process.env.DC_HF_PUBLIC_DIR = join(scratch, 'dc-server-pub');
  mkdirSync(process.env.DC_HF_SERVER_DIR, { recursive: true });
  mkdirSync(join(scratch, 'dc-work'), { recursive: true });
  setCloudMirrorPrefix(join(scratch, 'mirror'));
  auth = new HandsfreeAuth({ dir: process.env.DC_HF_SERVER_DIR });
  auth.store.installVerifiers({ generation: 1, passphrase: await hashPassphrase('a b c d e f'), transferSha256: sha256Hex(SECRET) });
  deviceId = auth.store.createDevice();
  setHandsfreeAuthForTests(auth);
  setCloudServicesForTests({
    state: new CloudStateStore({ dir: process.env.DC_HF_SERVER_DIR }),
    transfers: new TransferStore({ dir: process.env.DC_HF_SERVER_DIR }),
  });
  setCloudPhaseSource(cloudPhaseFromStore);
  setWorkerInProcessForTests(true);

  const router = new Router();
  router.get('/api/health', handleHealthGet);
  registerHandsfreeCloudRoutes(router);
  server = createServer(async (req, res) => {
    if (isCloud() && !cloudGate(req, res)) return;
    const m = router.match(req.method || 'GET', new URL(req.url || '/', 'http://x').pathname);
    if (!m) { sendError(res, 404, 'not_found', 'no route'); return; }
    await m.handler(req, res, m.params, '');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as { port: number }).port;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  setHandsfreeAuthForTests(null);
  setCloudServicesForTests(null);
  setCloudPhaseSource(() => 'sealed');
  setWorkerInProcessForTests(false);
  setCloudMirrorPrefix(null);
  rmSync(scratch, { recursive: true, force: true });
});

describe('transfer credential', () => {
  it('a device cookie never reaches a transfer route, with or without a proof', async () => {
    const r = await raw('POST', '/api/handsfree/cloud/seal', { Cookie: `__Host-dc_hf_session=${deviceId}`, Origin: OWN }, '{}');
    expect(r.status).toBe(403);
    expect(r.json().error).toBe('credential_mismatch');
    const n = await nonce();
    const both = await raw('POST', '/api/handsfree/cloud/seal', {
      Cookie: `__Host-dc_hf_session=${deviceId}`, Origin: OWN,
      Authorization: transferAuthorization(key, n, 'POST', '/api/handsfree/cloud/seal'),
    }, '{}');
    expect(both.status).toBe(403);
  });

  it('a missing or replayed proof is refused', async () => {
    const none = await raw('GET', '/api/handsfree/cloud/accounts', {});
    expect(none.status).toBe(401);
    const n = await nonce();
    const auth1 = transferAuthorization(key, n, 'GET', '/api/handsfree/cloud/state?rootId=r-0000000000000000');
    const first = await raw('GET', '/api/handsfree/cloud/state?rootId=r-0000000000000000', { Authorization: auth1 });
    expect(first.status).not.toBe(401);
    const replay = await raw('GET', '/api/handsfree/cloud/state?rootId=r-0000000000000000', { Authorization: auth1 });
    expect(replay.status).toBe(401);
    // Bound to the exact path: the same nonce for another path fails.
    const n2 = await nonce();
    const other = await raw('GET', '/api/handsfree/cloud/accounts', { Authorization: transferAuthorization(key, n2, 'GET', '/api/handsfree/cloud/state') });
    expect(other.status).toBe(401);
  });

  it('health shows the trip fields only with a valid proof', async () => {
    const pub = (await raw('GET', '/api/health', {})).json();
    expect(Object.keys(pub).sort()).toEqual(['fingerprint', 'version']);
    const priv = (await transfer('GET', '/api/health')).json();
    expect(priv.phase).toBe('sealed');
    expect(priv.verifierGeneration).toBe(1);
    expect(priv.supersededLaptopIds).toEqual([]);
  });

  it('every transfer route answers 404 off the cloud', async () => {
    delete process.env.DREAMCONTEXT_CLOUD;
    const r = await raw('GET', '/api/handsfree/cloud/accounts', {});
    expect(r.status).toBe(404);
  });
});

describe('uploads and downloads', () => {
  it('assembles ordered chunks, verifies the commit and is consumed once', async () => {
    const put0 = await transfer('PUT', '/api/handsfree/cloud/upload/up-aaaaaaaa/0', Buffer.from('hello '));
    expect(put0.status).toBe(200);
    // A lost reply: the same chunk again is accepted without appending.
    expect((await transfer('PUT', '/api/handsfree/cloud/upload/up-aaaaaaaa/0', Buffer.from('hello '))).status).toBe(200);
    const skip = await transfer('PUT', '/api/handsfree/cloud/upload/up-aaaaaaaa/2', Buffer.from('x'));
    expect(skip.status).toBe(409);
    expect(skip.json().error).toBe('out_of_order');
    expect((await transfer('PUT', '/api/handsfree/cloud/upload/up-aaaaaaaa/1', Buffer.from('world'))).status).toBe(200);
    const good = await transfer('POST', '/api/handsfree/cloud/upload/up-aaaaaaaa/commit', { size: 11, sha256: sha256Hex('hello world') });
    expect(good.status).toBe(200);
  });

  it('a commit that does not match is 409 upload_mismatch', async () => {
    await transfer('PUT', '/api/handsfree/cloud/upload/up-bbbbbbbb/0', Buffer.from('abc'));
    const bad = await transfer('POST', '/api/handsfree/cloud/upload/up-bbbbbbbb/commit', { size: 3, sha256: sha256Hex('abd') });
    expect(bad.status).toBe(409);
    expect(bad.json().error).toBe('upload_mismatch');
  });

  it('refuses bad ids and an oversized chunk', async () => {
    expect((await transfer('PUT', '/api/handsfree/cloud/upload/BAD/0', Buffer.from('x'))).status).toBe(400);
  });
});

describe('trip lifecycle', () => {
  const T = 'trip-one';

  async function startTrip(laptopId = 'laptop-a', takeOver = false, tripId = T): Promise<Reply> {
    return transfer('POST', '/api/handsfree/cloud/trip', { tripId, laptopId, go: goManifest(tripId, laptopId), takeOver });
  }

  it('POST trip writes the marker and refuses unless sealed', async () => {
    const r = await startTrip();
    expect(r.status).toBe(200);
    expect(existsSync(join(scratch, 'mirror', HOME, TRIP_MARKER_NAME))).toBe(true);
    expect((await transfer('POST', '/api/handsfree/cloud/activate', { tripId: T })).status).toBe(200);
    const again = await startTrip();
    expect(again.status).toBe(409);
    expect(again.json().error).toBe('not_sealed');
  });

  it('a foreign laptop is refused unless it takes over, and the old one is then superseded', async () => {
    expect((await startTrip('laptop-a')).status).toBe(200);
    const foreign = await startTrip('laptop-b', false, 'trip-two');
    expect(foreign.status).toBe(409);
    expect(foreign.json().error).toBe('laptop_mismatch');
    const take = await startTrip('laptop-b', true, 'trip-two');
    expect(take.status).toBe(200);
    const h = (await transfer('GET', '/api/health')).json();
    expect(h.laptopId).toBe('laptop-b');
    expect(h.supersededLaptopIds).toEqual(['laptop-a']);
  });

  it('refuses a go manifest whose root ids or paths are not its own', async () => {
    const go = goManifest(T, 'laptop-a');
    go.roots[0].rootId = 'r-0123456789abcdef';
    const r = await transfer('POST', '/api/handsfree/cloud/trip', { tripId: T, laptopId: 'laptop-a', go });
    expect(r.status).toBe(400);
    const outside = goManifest(T, 'laptop-a');
    outside.roots = [{ rootId: rootIdFor('/etc'), kind: 'vault', absPath: '/etc' }];
    expect((await transfer('POST', '/api/handsfree/cloud/trip', { tripId: T, laptopId: 'laptop-a', go: outside })).status).toBe(400);
  });

  it('seal refuses a stale epoch; quiesce gives a new one each time', async () => {
    await startTrip();
    await transfer('POST', '/api/handsfree/cloud/activate', { tripId: T });
    const q1 = (await transfer('POST', '/api/handsfree/cloud/quiesce', { tripId: T })).json();
    expect(q1.epoch).toBe(1);
    expect(q1.running).toEqual([]);
    expect((await transfer('POST', '/api/handsfree/cloud/unquiesce', { epoch: 1 })).status).toBe(200);
    // A cancelled return bumps the epoch: its old epoch can never snapshot/seal the active cloud.
    const afterCancel = (await transfer('GET', '/api/health')).json();
    expect(afterCancel.phase).toBe('active');
    expect(afterCancel.epoch).toBe(2);
    expect((await transfer('POST', '/api/handsfree/cloud/seal', { epoch: 1 })).json().error).toBe('epoch_mismatch');
    for (const route of ['seal', 'snapshot', 'cut', 'wipe-secrets']) {
      const r = await transfer('POST', `/api/handsfree/cloud/${route}`, { epoch: 2, knownTips: {} });
      expect(r.status, route).toBe(409);
      expect(r.json().error, route).toBe('not_quiescing');
    }
    const q2 = (await transfer('POST', '/api/handsfree/cloud/quiesce', { tripId: T })).json();
    expect(q2.epoch).toBe(3);
    const stale = await transfer('POST', '/api/handsfree/cloud/seal', { epoch: 2 });
    expect(stale.status).toBe(409);
    expect(stale.json().error).toBe('epoch_mismatch');
    expect((await transfer('POST', '/api/handsfree/cloud/seal', { epoch: 3 })).status).toBe(200);
    expect((await transfer('GET', '/api/health')).json().phase).toBe('sealed');
  });

  it('quiesce and snapshot answer trip_lost when the mirror lost its marker', async () => {
    await startTrip();
    await transfer('POST', '/api/handsfree/cloud/activate', { tripId: T });
    const q = (await transfer('POST', '/api/handsfree/cloud/quiesce', { tripId: T })).json();
    rmSync(join(scratch, 'mirror', HOME, TRIP_MARKER_NAME));
    const snap = await transfer('POST', '/api/handsfree/cloud/snapshot', { epoch: q.epoch, knownTips: {} });
    expect(snap.status).toBe(409);
    expect(snap.json().error).toBe('trip_lost');
    const again = await transfer('POST', '/api/handsfree/cloud/quiesce', { tripId: T });
    expect(again.status).toBe(409);
    expect(again.json().error).toBe('trip_lost');
  });

  it('a lost marker, roots ABSENT (unmounted mirror): recovery quiesce and snapshot refuse mirror_absent; nothing quiesced, nothing sealed', async () => {
    await startTrip();
    await transfer('POST', '/api/handsfree/cloud/activate', { tripId: T });
    rmSync(join(scratch, 'mirror', HOME, TRIP_MARKER_NAME));
    rmSync(join(scratch, 'mirror', PROJ), { recursive: true, force: true });
    const q = await transfer('POST', '/api/handsfree/cloud/quiesce', { tripId: T, recovery: true });
    expect(q.status).toBe(409);
    expect(q.json().error).toBe('mirror_absent');
    expect((await transfer('GET', '/api/health')).json()).toMatchObject({ phase: 'active', sealedEpoch: null });
  });

  it('a lost marker, roots present: a RECOVERY quiesce still quiesces (tripLost); the seal waits for the tolerant snapshot (D12 order); a later go starts', async () => {
    await startTrip();
    await transfer('POST', '/api/handsfree/cloud/activate', { tripId: T });
    mkdirSync(join(scratch, 'mirror', PROJ, '_dream_context'), { recursive: true });
    rmSync(join(scratch, 'mirror', HOME, TRIP_MARKER_NAME));
    // A normal quiesce still refuses (the existing trip_lost rule).
    expect((await transfer('POST', '/api/handsfree/cloud/quiesce', { tripId: T })).json().error).toBe('trip_lost');
    const q = await transfer('POST', '/api/handsfree/cloud/quiesce', { tripId: T, recovery: true });
    expect(q.status).toBe(200);
    expect(q.json()).toMatchObject({ tripLost: true, running: [] });
    // Idempotent on retry: a repeated recovery quiesce answers again (a newer epoch).
    const q2 = (await transfer('POST', '/api/handsfree/cloud/quiesce', { tripId: T, recovery: true })).json();
    expect(q2.tripLost).toBe(true);
    expect(q2.epoch).toBeGreaterThan(q.json().epoch);
    expect((await transfer('POST', '/api/handsfree/cloud/cut', { epoch: q2.epoch })).status).toBe(200);
    // Never wiped or sealed before the recovery snapshot of this epoch.
    expect((await transfer('POST', '/api/handsfree/cloud/seal', { epoch: q2.epoch })).json().error).toBe('snapshot_first');
    expect((await transfer('POST', '/api/handsfree/cloud/wipe-secrets', { epoch: q2.epoch })).json().error).toBe('snapshot_first');
    expect((await transfer('POST', '/api/handsfree/cloud/snapshot', { epoch: q2.epoch, knownTips: {} })).json().error).toBe('trip_lost');
    expect((await transfer('POST', '/api/handsfree/cloud/snapshot', { epoch: q2.epoch, tolerant: true, knownTips: {} })).status).toBe(200);
    expect((await transfer('POST', '/api/handsfree/cloud/wipe-secrets', { epoch: q2.epoch })).status).toBe(200);
    expect((await transfer('POST', '/api/handsfree/cloud/seal', { epoch: q2.epoch })).status).toBe(200);
    const h = (await transfer('GET', '/api/health')).json();
    expect(h).toMatchObject({ phase: 'sealed', sealedEpoch: q2.epoch, tripId: T });
    expect((await transfer('POST', '/api/handsfree/cloud/seal', { epoch: q2.epoch })).json()).toMatchObject({ ok: true, alreadyDone: true });
    // POST trip needs a sealed cloud: the next go starts.
    expect((await startTrip('laptop-a', false, 'trip-two')).status).toBe(200);
  });

  it('a recovery quiesce is transfer-credential only, and never quiesces over a marker of ANOTHER trip', async () => {
    await startTrip();
    await transfer('POST', '/api/handsfree/cloud/activate', { tripId: T });
    const viaCookie = await raw('POST', '/api/handsfree/cloud/quiesce', { Cookie: `__Host-dc_hf_session=${deviceId}`, Origin: OWN, 'Content-Type': 'application/json' }, JSON.stringify({ tripId: T, recovery: true }));
    expect(viaCookie.status).toBe(403);
    const markerFile = join(scratch, 'mirror', HOME, TRIP_MARKER_NAME);
    const marker = JSON.parse(readFileSync(markerFile, 'utf8')) as Record<string, unknown>;
    writeFileSync(markerFile, JSON.stringify({ ...marker, tripId: 'trip-someone-else' }));
    const r = await transfer('POST', '/api/handsfree/cloud/quiesce', { tripId: T, recovery: true });
    expect(r.status).toBe(409);
    expect(r.json().error).toBe('trip_lost');
    expect((await transfer('GET', '/api/health')).json().phase).toBe('active');
  });

  it('files travel: receive gives the digest of what landed, a later snapshot packs the cloud edit', async () => {
    // The laptop side: a vault without git, its brain's ignored state + a secret.
    mkdirSync(join(laptop, '_dream_context', 'state'), { recursive: true });
    writeFileSync(join(laptop, '_dream_context', 'state', 'task.md'), '# task\n');
    mkdirSync(join(laptop, '.claude'), { recursive: true });
    writeFileSync(join(laptop, '.claude', '.env'), 'KEY=1\n');
    const run = createSpawnRunner();
    const sel = await selectNonGitEntries(run, laptop, { isGitRepo: false, side: 'laptop' });
    const m = await buildManifest(laptop, sel.entries);
    const chunks: Buffer[] = [];
    const sink = new PassThrough();
    sink.on('data', (c: Buffer) => chunks.push(c));
    await writePack(sink, { root: laptop, entries: m.values() });
    await upload('pack-aaaaaaaa', Buffer.concat(chunks));

    await startTrip();
    const expected = manifestToJSON(m);
    const recv = await transfer('POST', '/api/handsfree/cloud/files/receive', { tripId: T, rootId: rootIdFor(PROJ), uploadId: 'pack-aaaaaaaa', expected });
    expect(recv.status).toBe(200);
    expect(recv.json().refused).toEqual([]);
    expect(recv.json().digest).toBe(manifestDigest(expected));
    const state = (await transfer('GET', `/api/handsfree/cloud/state?rootId=${rootIdFor(PROJ)}`)).json();
    expect(state.kind).toBe('files');
    expect(manifestDigest(state.manifest)).toBe(manifestDigest(expected));

    // The phone edits the task file in the cloud; the return snapshot packs exactly that.
    await transfer('POST', '/api/handsfree/cloud/activate', { tripId: T });
    writeFileSync(join(scratch, 'mirror', PROJ, '_dream_context', 'state', 'task.md'), '# task\n- [x] done on the phone\n');
    const q = (await transfer('POST', '/api/handsfree/cloud/quiesce', { tripId: T })).json();
    const snap = await transfer('POST', '/api/handsfree/cloud/snapshot', { epoch: q.epoch, knownTips: {} });
    expect(snap.status).toBe(200);
    const files = snap.json().roots.find((r: { kind: string }) => r.kind === 'files');
    expect(files.refused).toEqual([]);
    expect(files.pack.size).toBeGreaterThan(0);
    const dl = await transfer('GET', `/api/handsfree/cloud/download/${files.pack.id}?offset=0&length=${files.pack.size}`);
    expect(dl.status).toBe(200);
    expect(createHash('sha256').update(dl.body).digest('hex')).toBe(files.pack.sha256);

    // wipe-secrets removes the secret class from the cloud; seal drops the downloads.
    const wipe = await transfer('POST', '/api/handsfree/cloud/wipe-secrets', { epoch: q.epoch });
    expect(wipe.json().wiped).toBe(1);
    expect(existsSync(join(scratch, 'mirror', PROJ, '.claude', '.env'))).toBe(false);
    expect(existsSync(join(scratch, 'mirror', PROJ, '_dream_context', 'state', 'task.md'))).toBe(true);
    expect((await transfer('POST', '/api/handsfree/cloud/seal', { epoch: q.epoch })).status).toBe(200);
    expect((await transfer('GET', `/api/handsfree/cloud/download/${files.pack.id}?offset=0&length=10`)).status).toBe(404);
  }, 60_000);

  it('git travels: the cloud re-snapshot after receive equals the laptop snapshot (AC2)', async () => {
    const repo = join(laptop, 'proj');
    mkdirSync(repo, { recursive: true });
    const g = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    g('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    g('add', 'a.txt');
    g('commit', '-q', '-m', 'first');
    writeFileSync(join(repo, 'a.txt'), 'stashed\n');
    g('stash', 'push', '-q', '-m', 'phone stash');
    writeFileSync(join(repo, 'b.txt'), 'staged\n');
    g('add', 'b.txt');
    writeFileSync(join(repo, 'a.txt'), 'unstaged\n');
    writeFileSync(join(repo, 'c.txt'), 'untracked\n');

    const run = createSpawnRunner();
    const goT = 'trip-git';
    const go: GoManifest = { ...goManifest(goT, 'laptop-a'), roots: [{ rootId: rootIdFor(PROJ), kind: 'repo', absPath: PROJ }] };
    const snap = await snapshotRepo(run, repo, { trip: goT, checkoutIdFor: () => rootIdFor(PROJ), side: 'laptop' });
    const bundlePath = join(scratch, 'go.bundle');
    const b = await createBundle(run, repo, { refs: snapshotBundleRefs(snap), knownTips: [], out: bundlePath });
    expect(b.created).toBe(true);
    await upload('bundle-aaaaaaaa', readFileSync(bundlePath));

    expect((await transfer('POST', '/api/handsfree/cloud/trip', { tripId: goT, laptopId: 'laptop-a', go })).status).toBe(200);
    const recv = await transfer('POST', '/api/handsfree/cloud/git/receive', { tripId: goT, rootId: rootIdFor(PROJ), uploadId: 'bundle-aaaaaaaa', snapshot: { ...snap, repoPath: PROJ, checkouts: snap.checkouts.map((c) => ({ ...c, path: PROJ })) } });
    expect(recv.status, recv.body.toString()).toBe(200);
    expect(recv.json().snapshotId).toBe(snapshotId(snap));

    const state = (await transfer('GET', `/api/handsfree/cloud/state?rootId=${rootIdFor(PROJ)}`)).json();
    expect(state.kind).toBe('repo');
    expect(snapshotId(state.snapshot)).toBe(snapshotId(snap));
    expect(state.snapshot.stash.map((e: { message: string }) => e.message)).toEqual(snap.stash.map((e) => e.message));
    const cloudRepo = join(scratch, 'mirror', PROJ);
    expect(readFileSync(join(cloudRepo, 'a.txt'), 'utf-8')).toBe('unstaged\n');
    expect(readFileSync(join(cloudRepo, 'c.txt'), 'utf-8')).toBe('untracked\n');
    // Generated, never received: no hooks, our own config.
    expect(readFileSync(join(cloudRepo, '.git', 'config'), 'utf-8')).toContain('sharedRepository = group');
  }, 60_000);
});

describe('wire v1.1 and receive from the current cloud state', () => {
  const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const gitIn = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, env: GIT_ENV }).toString();
  const cloudRepo = () => join(scratch, 'mirror', PROJ);
  const go = (tripId: string): GoManifest => ({ ...goManifest(tripId, 'laptop-a'), roots: [{ rootId: rootIdFor(PROJ), kind: 'repo', absPath: PROJ }] });

  function laptopRepo(): string {
    const repo = join(laptop, 'proj');
    mkdirSync(repo, { recursive: true });
    gitIn(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    gitIn(repo, 'add', 'a.txt');
    gitIn(repo, 'commit', '-q', '-m', 'first');
    writeFileSync(join(repo, '.git', 'info', 'exclude'), 'scratch-out/\n');
    mkdirSync(join(repo, 'scratch-out'), { recursive: true });
    writeFileSync(join(repo, 'scratch-out', 'big.log'), 'ignored by info/exclude\n');
    return repo;
  }

  /** Snapshot + bundle + upload the laptop repo for `tripId`, then git/receive it. */
  async function goRepo(repo: string, tripId: string, extra: Record<string, unknown> = {}) {
    const run = createSpawnRunner({ baseEnv: GIT_ENV });
    const snap = await snapshotRepo(run, repo, { trip: tripId, checkoutIdFor: () => rootIdFor(PROJ), side: 'laptop' });
    const bundlePath = join(scratch, `${tripId}.bundle`);
    await createBundle(run, repo, { refs: snapshotBundleRefs(snap), knownTips: [], out: bundlePath });
    const upId = `b-${tripId}`;
    await upload(upId, readFileSync(bundlePath));
    const recv = await transfer('POST', '/api/handsfree/cloud/git/receive', {
      tripId, rootId: rootIdFor(PROJ), uploadId: upId,
      snapshot: { ...snap, repoPath: PROJ, checkouts: snap.checkouts.map((c) => ({ ...c, path: PROJ })) },
      info: { exclude: readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf-8') },
      remotes: [{ name: 'origin', url: 'https://github.com/example/proj.git' }],
      ...extra,
    });
    return { snap, recv };
  }

  it('writes the laptop info/exclude and remotes into the generated .git, so git status matches (AC2)', async () => {
    const repo = laptopRepo();
    expect((await transfer('POST', '/api/handsfree/cloud/trip', { tripId: 'trip-v11', laptopId: 'laptop-a', go: go('trip-v11') })).status).toBe(200);
    const { snap, recv } = await goRepo(repo, 'trip-v11');
    expect(recv.status, recv.body.toString()).toBe(200);
    expect(recv.json().snapshotId).toBe(snapshotId(snap));
    expect(readFileSync(join(cloudRepo(), '.git', 'info', 'exclude'), 'utf-8')).toBe('scratch-out/\n');
    const cfg = readFileSync(join(cloudRepo(), '.git', 'config'), 'utf-8');
    expect(cfg).toContain('[remote "origin"]');
    expect(cfg).toContain('url = "https://github.com/example/proj.git"');
    // The phone's build output under the excluded dir stays out of status, exactly as on the laptop.
    mkdirSync(join(cloudRepo(), 'scratch-out'), { recursive: true });
    writeFileSync(join(cloudRepo(), 'scratch-out', 'big.log'), 'cloud build\n');
    expect(gitIn(cloudRepo(), 'status', '--porcelain=v2')).toBe(gitIn(repo, 'status', '--porcelain=v2'));
  }, 60_000);

  it('refuses a remote URL that still carries userinfo, before any work', async () => {
    const repo = laptopRepo();
    await transfer('POST', '/api/handsfree/cloud/trip', { tripId: 'trip-v11', laptopId: 'laptop-a', go: go('trip-v11') });
    const { recv } = await goRepo(repo, 'trip-v11', { remotes: [{ name: 'origin', url: 'https://me:token@github.com/example/proj.git' }] });
    expect(recv.status).toBe(400);
    expect(existsSync(join(cloudRepo(), '.git'))).toBe(false);
  }, 60_000);

  it('reaches the laptop S from the cloud\'s CURRENT state (the phone kept working after an Abandon)', async () => {
    const repo = laptopRepo();
    await transfer('POST', '/api/handsfree/cloud/trip', { tripId: 'trip-v11', laptopId: 'laptop-a', go: go('trip-v11') });
    expect((await goRepo(repo, 'trip-v11')).recv.status).toBe(200);
    // The phone: a commit, an edit and a new file the laptop never saw.
    writeFileSync(join(cloudRepo(), 'phone.txt'), 'phone\n');
    gitIn(cloudRepo(), 'add', 'phone.txt');
    gitIn(cloudRepo(), 'commit', '-q', '-m', 'on the phone');
    writeFileSync(join(cloudRepo(), 'a.txt'), 'phone edit\n');
    writeFileSync(join(cloudRepo(), 'stray.txt'), 'untracked\n');
    const { snap, recv } = await goRepo(repo, 'trip-v11');
    expect(recv.status, recv.body.toString()).toBe(200);
    expect(recv.json().snapshotId).toBe(snapshotId(snap));
    expect(existsSync(join(cloudRepo(), 'phone.txt'))).toBe(false);
    expect(existsSync(join(cloudRepo(), 'stray.txt'))).toBe(false);
    expect(readFileSync(join(cloudRepo(), 'a.txt'), 'utf-8')).toBe('one\n');
  }, 60_000);

  async function leaveMergeInProgress(): Promise<void> {
    const c = cloudRepo();
    gitIn(c, 'checkout', '-q', '-b', 'side');
    writeFileSync(join(c, 'a.txt'), 'side\n');
    gitIn(c, 'commit', '-q', '-am', 'side');
    gitIn(c, 'checkout', '-q', 'main');
    writeFileSync(join(c, 'a.txt'), 'main\n');
    gitIn(c, 'commit', '-q', '-am', 'main');
    try { gitIn(c, 'merge', 'side'); } catch { /* conflict: the merge stays in progress */ }
    expect(existsSync(join(c, '.git', 'MERGE_HEAD'))).toBe(true);
  }

  it('after a D12 recovery captured it, a merge left in progress is cleared and the next go lands', async () => {
    const repo = laptopRepo();
    await transfer('POST', '/api/handsfree/cloud/trip', { tripId: 'trip-old', laptopId: 'laptop-a', go: go('trip-old') });
    expect((await goRepo(repo, 'trip-old')).recv.status).toBe(200);
    await transfer('POST', '/api/handsfree/cloud/activate', { tripId: 'trip-old' });
    await leaveMergeInProgress();
    // The recovery: quiesce → tolerant snapshot (MERGE_HEAD saved as a ref) → seal.
    const q = (await transfer('POST', '/api/handsfree/cloud/quiesce', { tripId: 'trip-old', recovery: true })).json();
    const strict = await transfer('POST', '/api/handsfree/cloud/snapshot', { epoch: q.epoch, knownTips: {} });
    expect(strict.status).toBe(409);
    expect(strict.json().error).toBe('preflight');
    const snapR = await transfer('POST', '/api/handsfree/cloud/snapshot', { epoch: q.epoch, tolerant: true, knownTips: {} });
    expect(snapR.status, snapR.body.toString()).toBe(200);
    expect((await transfer('POST', '/api/handsfree/cloud/seal', { epoch: q.epoch })).status).toBe(200);

    await transfer('POST', '/api/handsfree/cloud/trip', { tripId: 'trip-new', laptopId: 'laptop-a', go: go('trip-new') });
    const { snap, recv } = await goRepo(repo, 'trip-new');
    expect(recv.status, recv.body.toString()).toBe(200);
    expect(recv.json().snapshotId).toBe(snapshotId(snap));
    expect(existsSync(join(cloudRepo(), '.git', 'MERGE_HEAD'))).toBe(false);
  }, 120_000);

  it('a merge in progress nobody recovered refuses the go instead of losing it', async () => {
    const repo = laptopRepo();
    await transfer('POST', '/api/handsfree/cloud/trip', { tripId: 'trip-old', laptopId: 'laptop-a', go: go('trip-old') });
    expect((await goRepo(repo, 'trip-old')).recv.status).toBe(200);
    await leaveMergeInProgress();
    const { recv } = await goRepo(repo, 'trip-old');
    expect(recv.status).toBe(409);
    expect(recv.json().kind).toBe('in_progress');
    expect(existsSync(join(cloudRepo(), '.git', 'MERGE_HEAD'))).toBe(true);
  }, 120_000);

  it('a worktree the phone created: absolute path in worktreesAdded, its transcripts in a transcripts entry', async () => {
    const repo = laptopRepo();
    await transfer('POST', '/api/handsfree/cloud/trip', { tripId: 'trip-v11', laptopId: 'laptop-a', go: go('trip-v11') });
    expect((await goRepo(repo, 'trip-v11')).recv.status).toBe(200);
    await transfer('POST', '/api/handsfree/cloud/activate', { tripId: 'trip-v11' });
    const WT = `${HOME}/proj-wt`;
    gitIn(cloudRepo(), 'worktree', 'add', '-q', '-b', 'wt', join(scratch, 'mirror', WT));
    const tdir = join(scratch, 'mirror', HOME, '.claude', 'projects', encodeProjectDir(WT));
    mkdirSync(tdir, { recursive: true });
    writeFileSync(join(tdir, 'phone-session.jsonl'), '{"type":"user"}\n');
    const q = (await transfer('POST', '/api/handsfree/cloud/quiesce', { tripId: 'trip-v11' })).json();
    const snapR = await transfer('POST', '/api/handsfree/cloud/snapshot', { epoch: q.epoch, knownTips: {} });
    expect(snapR.status, snapR.body.toString()).toBe(200);
    const roots = snapR.json().roots as Array<{ rootId: string; kind: string; rootKind?: string; worktreesAdded?: string[]; manifest?: Array<{ path: string }>; pack?: unknown }>;
    expect(roots.find((r) => r.kind === 'repo')?.worktreesAdded).toEqual([WT]);
    const t = roots.find((r) => r.rootId === rootIdFor(WT));
    expect(t?.kind).toBe('files');
    expect(t?.rootKind).toBe('transcripts');
    expect(t?.manifest?.map((e) => e.path)).toEqual(['phone-session.jsonl']);
    expect(t?.pack).toBeTruthy();
  }, 120_000);

  it('the trip\'s includes are honoured: a file the phone creates under an included path comes home', async () => {
    mkdirSync(join(laptop, 'notes'), { recursive: true });
    writeFileSync(join(laptop, 'notes', 'a.txt'), 'laptop note\n');
    mkdirSync(join(laptop, '_dream_context'), { recursive: true });
    const run = createSpawnRunner();
    const sel = await selectNonGitEntries(run, laptop, { isGitRepo: false, include: ['notes'], side: 'laptop' });
    const m = await buildManifest(laptop, sel.entries);
    const chunks: Buffer[] = [];
    const sink = new PassThrough();
    sink.on('data', (c: Buffer) => chunks.push(c));
    await writePack(sink, { root: laptop, entries: m.values() });
    await upload('pack-incl0001', Buffer.concat(chunks));
    const bad = await transfer('POST', '/api/handsfree/cloud/trip', { tripId: 'trip-inc', laptopId: 'laptop-a', go: goManifest('trip-inc', 'laptop-a'), includes: { [rootIdFor(PROJ)]: ['../etc'] } });
    expect(bad.status).toBe(400);
    expect((await transfer('POST', '/api/handsfree/cloud/trip', { tripId: 'trip-inc', laptopId: 'laptop-a', go: goManifest('trip-inc', 'laptop-a'), includes: { [rootIdFor(PROJ)]: ['notes'] } })).status).toBe(200);
    const recv = await transfer('POST', '/api/handsfree/cloud/files/receive', { tripId: 'trip-inc', rootId: rootIdFor(PROJ), uploadId: 'pack-incl0001', expected: manifestToJSON(m) });
    expect(recv.json().digest).toBe(manifestDigest(manifestToJSON(m)));
    await transfer('POST', '/api/handsfree/cloud/activate', { tripId: 'trip-inc' });
    writeFileSync(join(scratch, 'mirror', PROJ, 'notes', 'new-on-phone.txt'), 'phone note\n');
    const q = (await transfer('POST', '/api/handsfree/cloud/quiesce', { tripId: 'trip-inc' })).json();
    const snapR = (await transfer('POST', '/api/handsfree/cloud/snapshot', { epoch: q.epoch, knownTips: {} })).json();
    const files = snapR.roots.find((r: { kind: string }) => r.kind === 'files');
    expect(files.manifest.map((e: { path: string }) => e.path)).toContain('notes/new-on-phone.txt');
    expect(files.pack).toBeTruthy();
  }, 60_000);
});

describe('D21: finalization is idempotent and a sealed cloud holds no secrets', () => {
  const T = 'trip-d21';
  async function tripWithSecret(): Promise<void> {
    mkdirSync(join(laptop, '_dream_context', 'state'), { recursive: true });
    writeFileSync(join(laptop, '_dream_context', 'state', 'task.md'), '# task\n');
    mkdirSync(join(laptop, '.claude'), { recursive: true });
    writeFileSync(join(laptop, '.claude', '.env'), 'KEY=1\n');
    const run = createSpawnRunner();
    const sel = await selectNonGitEntries(run, laptop, { isGitRepo: false, side: 'laptop' });
    const m = await buildManifest(laptop, sel.entries);
    const chunks: Buffer[] = [];
    const sink = new PassThrough();
    sink.on('data', (c: Buffer) => chunks.push(c));
    await writePack(sink, { root: laptop, entries: m.values() });
    await upload('pack-d21aaaaa', Buffer.concat(chunks));
    expect((await transfer('POST', '/api/handsfree/cloud/trip', { tripId: T, laptopId: 'laptop-a', go: goManifest(T, 'laptop-a') })).status).toBe(200);
    expect((await transfer('POST', '/api/handsfree/cloud/files/receive', { tripId: T, rootId: rootIdFor(PROJ), uploadId: 'pack-d21aaaaa', expected: manifestToJSON(m) })).status).toBe(200);
    expect((await transfer('POST', '/api/handsfree/cloud/activate', { tripId: T })).status).toBe(200);
  }
  const secret = () => join(scratch, 'mirror', PROJ, '.claude', '.env');

  it('the queued case: snapshot served, laptop gone, the 2 h self-seal wipes first; the queued steps answer alreadyDone', async () => {
    await tripWithSecret();
    expect(existsSync(secret())).toBe(true);
    writeFileSync(join(scratch, 'mirror', PROJ, '_dream_context', 'state', 'task.md'), '# task\n- [x] on the phone\n');
    const q = (await transfer('POST', '/api/handsfree/cloud/quiesce', { tripId: T })).json();
    const first = (await transfer('POST', '/api/handsfree/cloud/snapshot', { epoch: q.epoch, knownTips: {} })).json();
    // A retried snapshot of the same epoch replaces the earlier downloads.
    const firstPack = first.roots.find((r: { kind: string }) => r.kind === 'files').pack;
    const again = (await transfer('POST', '/api/handsfree/cloud/snapshot', { epoch: q.epoch, knownTips: {} })).json();
    expect(again.roots.find((r: { kind: string }) => r.kind === 'files').pack.id).not.toBe(firstPack.id);
    expect((await transfer('GET', `/api/handsfree/cloud/download/${firstPack.id}?offset=0&length=10`)).status).toBe(404);

    // The laptop lost contact. Three hours later the idle clock's backstop fires.
    const idle = createCloudIdle('boot-test', () => Date.now() + 3 * 60 * 60_000);
    idle.tick();
    await idle.sealInFlight();
    const h = (await transfer('GET', '/api/health')).json();
    expect(h.phase).toBe('sealed');
    expect(h.tripId).toBe(T);
    expect(h.epoch).toBe(q.epoch);
    expect(h.sealedEpoch).toBe(q.epoch);
    expect(existsSync(secret())).toBe(false);
    expect(existsSync(join(scratch, 'mirror', PROJ, '_dream_context', 'state', 'task.md'))).toBe(true);

    // The laptop comes back with its queued steps: each is an ensure-operation.
    const wipe = await transfer('POST', '/api/handsfree/cloud/wipe-secrets', { epoch: q.epoch });
    expect(wipe.status).toBe(200);
    expect(wipe.json()).toMatchObject({ ok: true, alreadyDone: true });
    const seal = await transfer('POST', '/api/handsfree/cloud/seal', { epoch: q.epoch });
    expect(seal.status).toBe(200);
    expect(seal.json()).toMatchObject({ ok: true, alreadyDone: true });
    const older = await transfer('POST', '/api/handsfree/cloud/seal', { epoch: q.epoch - 1 });
    expect(older.status).toBe(409);
    expect(older.json().error).toBe('epoch_mismatch');
    const snap = await transfer('POST', '/api/handsfree/cloud/snapshot', { epoch: q.epoch, knownTips: {} });
    expect(snap.json().error).toBe('not_quiescing');
  }, 60_000);

  it('the laptop\'s own seal wipes the secret class first too', async () => {
    await tripWithSecret();
    const q = (await transfer('POST', '/api/handsfree/cloud/quiesce', { tripId: T })).json();
    expect((await transfer('POST', '/api/handsfree/cloud/seal', { epoch: q.epoch })).status).toBe(200);
    expect(existsSync(secret())).toBe(false);
    expect((await transfer('GET', '/api/health')).json().sealedEpoch).toBe(q.epoch);
  }, 60_000);

  it('a recovery quiesce (or one of a sealed cloud) never auto-reverts to active', async () => {
    await tripWithSecret();
    const q = (await transfer('POST', '/api/handsfree/cloud/quiesce', { tripId: T, recovery: true })).json();
    const idle = createCloudIdle('boot-test', () => Date.now() + 45 * 60_000);
    idle.tick();
    const h = (await transfer('GET', '/api/health')).json();
    expect(h.phase).toBe('quiescing');
    expect(h.epoch).toBe(q.epoch);
  }, 60_000);
});

describe('round 3: process-tree running, every worktree wiped, seal order', () => {
  const T = 'trip-r3';
  const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const gitIn = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, env: GIT_ENV }).toString();

  async function startActive(): Promise<void> {
    expect((await transfer('POST', '/api/handsfree/cloud/trip', { tripId: T, laptopId: 'laptop-a', go: goManifest(T, 'laptop-a') })).status).toBe(200);
    expect((await transfer('POST', '/api/handsfree/cloud/activate', { tripId: T })).status).toBe(200);
  }

  it('quiesce lists a process nobody registered (a background task), snapshot refuses until it is cut', async () => {
    await startActive();
    const cwd = join(scratch, 'mirror', PROJ);
    mkdirSync(cwd, { recursive: true });
    const { spawn } = await import('node:child_process');
    const bg = spawn('/bin/sh', ['-c', 'exec sleep 30'], { cwd, detached: true, stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 300));
      const q = (await transfer('POST', '/api/handsfree/cloud/quiesce', { tripId: T })).json();
      const entry = q.running.find((e: { pid: number }) => e.pid === bg.pid);
      expect(entry).toMatchObject({ conversationId: null, startedAt: null, pid: bg.pid });
      expect(entry.command).toContain('sleep');
      const snap = await transfer('POST', '/api/handsfree/cloud/snapshot', { epoch: q.epoch, knownTips: {} });
      expect(snap.status).toBe(409);
      expect(snap.json().error).toBe('turns_running');
      const cut = (await transfer('POST', '/api/handsfree/cloud/cut', { epoch: q.epoch })).json();
      expect(cut.processes).toContain(bg.pid);
      expect((await transfer('POST', '/api/handsfree/cloud/snapshot', { epoch: q.epoch, knownTips: {} })).status).toBe(200);
    } finally {
      try { process.kill(-bg.pid!, 'SIGKILL'); } catch { /* gone */ }
    }
  }, 60_000);

  it('the seal wipes the secret class from a worktree the phone created too', async () => {
    const repo = join(laptop, 'proj');
    mkdirSync(repo, { recursive: true });
    gitIn(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    gitIn(repo, 'add', 'a.txt');
    gitIn(repo, 'commit', '-q', '-m', 'first');
    const run = createSpawnRunner({ baseEnv: GIT_ENV });
    const go: GoManifest = { ...goManifest(T, 'laptop-a'), roots: [{ rootId: rootIdFor(PROJ), kind: 'repo', absPath: PROJ }] };
    const snap = await snapshotRepo(run, repo, { trip: T, checkoutIdFor: () => rootIdFor(PROJ), side: 'laptop' });
    const bundlePath = join(scratch, 'r3.bundle');
    await createBundle(run, repo, { refs: snapshotBundleRefs(snap), knownTips: [], out: bundlePath });
    await upload('bundle-r3aaaaa', readFileSync(bundlePath));
    expect((await transfer('POST', '/api/handsfree/cloud/trip', { tripId: T, laptopId: 'laptop-a', go })).status).toBe(200);
    expect((await transfer('POST', '/api/handsfree/cloud/git/receive', { tripId: T, rootId: rootIdFor(PROJ), uploadId: 'bundle-r3aaaaa', snapshot: { ...snap, repoPath: PROJ, checkouts: snap.checkouts.map((c) => ({ ...c, path: PROJ })) } })).status).toBe(200);
    await transfer('POST', '/api/handsfree/cloud/activate', { tripId: T });
    const wt = join(scratch, 'mirror', HOME, 'proj-feature');
    gitIn(join(scratch, 'mirror', PROJ), 'worktree', 'add', '-q', '-b', 'feature', wt);
    mkdirSync(join(wt, '.claude'), { recursive: true });
    writeFileSync(join(wt, '.claude', '.env'), 'COPIED=1\n');
    const q = (await transfer('POST', '/api/handsfree/cloud/quiesce', { tripId: T })).json();
    expect((await transfer('POST', '/api/handsfree/cloud/seal', { epoch: q.epoch })).status).toBe(200);
    expect(existsSync(join(wt, '.claude', '.env'))).toBe(false);
    expect(existsSync(join(wt, 'a.txt'))).toBe(true);
  }, 60_000);

  it('a return cancelled while the wipe runs aborts the seal', async () => {
    await startActive();
    const q = (await transfer('POST', '/api/handsfree/cloud/quiesce', { tripId: T })).json();
    const sealing = wipeAndSeal();
    cloudServices().state.unquiesce(); // lands during the cut/wipe
    await expect(sealing).rejects.toMatchObject({ code: 'seal_aborted' });
    const h = (await transfer('GET', '/api/health')).json();
    expect(h.phase).toBe('active');
    expect(h.epoch).toBe(q.epoch + 1);
    expect(h.sealedEpoch).toBeNull();
  }, 60_000);

  it('a self-seal whose wipe keeps failing is reported in health as sealBlocked', async () => {
    await startActive();
    const locked = join(scratch, 'mirror', PROJ, '.claude');
    mkdirSync(locked, { recursive: true });
    writeFileSync(join(locked, '.env'), 'KEY=1\n');
    const { chmodSync } = await import('node:fs');
    chmodSync(locked, 0o555); // the file cannot be removed
    try {
      const q = (await transfer('POST', '/api/handsfree/cloud/quiesce', { tripId: T })).json();
      expect((await transfer('POST', '/api/handsfree/cloud/snapshot', { epoch: q.epoch, knownTips: {} })).status).toBe(200);
      const idle = createCloudIdle('boot-test', () => Date.now() + 3 * 60 * 60_000);
      idle.tick();
      await idle.sealInFlight();
      const h = (await transfer('GET', '/api/health')).json();
      expect(h.phase).toBe('quiescing');
      expect(h.sealBlocked.error).toMatch(/could not be wiped/);
      expect(typeof h.sealBlocked.since).toBe('number');
    } finally {
      chmodSync(locked, 0o755);
    }
  }, 60_000);

  it('a new trip resets sealedEpoch: a stale wipe-secrets for the old sealed epoch never acts on it', async () => {
    await startActive();
    const q = (await transfer('POST', '/api/handsfree/cloud/quiesce', { tripId: T })).json();
    expect((await transfer('POST', '/api/handsfree/cloud/seal', { epoch: q.epoch })).status).toBe(200);
    expect((await transfer('POST', '/api/handsfree/cloud/trip', { tripId: 'trip-r3b', laptopId: 'laptop-a', go: goManifest('trip-r3b', 'laptop-a') })).status).toBe(200);
    expect((await transfer('GET', '/api/health')).json().sealedEpoch).toBeNull();
    const stale = await transfer('POST', '/api/handsfree/cloud/wipe-secrets', { epoch: q.epoch });
    expect(stale.status).toBe(409);
  }, 60_000);
});

describe('round 4: running = running turns; the wipe leaves no secret; finalization guards', () => {
  const T = 'trip-r4';
  async function startActive(): Promise<void> {
    expect((await transfer('POST', '/api/handsfree/cloud/trip', { tripId: T, laptopId: 'laptop-a', go: goManifest(T, 'laptop-a') })).status).toBe(200);
    expect((await transfer('POST', '/api/handsfree/cloud/activate', { tripId: T })).status).toBe(200);
  }
  const cwd = () => { const d = join(scratch, 'mirror', PROJ); mkdirSync(d, { recursive: true }); return d; };

  /** A registered chat around a REAL process in the mirror (cut = whole group, awaited). */
  async function fakeChat(id: string, busy: boolean, script = 'exec sleep 30'): Promise<{ entry: LiveChatEntry; pid: number }> {
    const { spawn } = await import('node:child_process');
    const child = spawn('/bin/sh', ['-c', script], { cwd: cwd(), detached: true, stdio: 'ignore' });
    const exited = new Promise<void>((r) => child.once('exit', () => r()));
    const entry: LiveChatEntry = {
      conversationId: id, projectRoot: cwd(), busy, turnStartedAt: busy ? Date.now() : null, lastTurnEndedAt: null,
      adopt: () => false, supersede: () => () => { /* none */ }, pid: child.pid,
      cut: async () => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* gone */ } await exited; unregisterLiveChat(entry); },
    };
    registerLiveChat(entry);
    await new Promise((r) => setTimeout(r, 300));
    return { entry, pid: child.pid! };
  }

  it('quiesce cuts an idle chat (it is not running work) and the snapshot is not refused for it', async () => {
    await startActive();
    const idle = await fakeChat('6f1c2e9a-6666-4a5b-8c9d-0123456789ab', false);
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    try {
      const q = (await transfer('POST', '/api/handsfree/cloud/quiesce', { tripId: T })).json();
      expect(q.running).toEqual([]);
      expect(alive(idle.pid)).toBe(false);
      expect((await transfer('POST', '/api/handsfree/cloud/snapshot', { epoch: q.epoch, knownTips: {} })).status).toBe(200);
    } finally {
      unregisterLiveChat(idle.entry);
      try { process.kill(-idle.pid, 'SIGKILL'); } catch { /* gone */ }
    }
  }, 60_000);

  it('a BUSY chat is listed as a running turn by its conversation and keeps the snapshot refused', async () => {
    await startActive();
    const id = '6f1c2e9a-7777-4a5b-8c9d-0123456789ab';
    const busy = await fakeChat(id, true);
    try {
      const q = (await transfer('POST', '/api/handsfree/cloud/quiesce', { tripId: T })).json();
      expect(q.running).toHaveLength(1);
      expect(q.running[0]).toMatchObject({ conversationId: id, pid: busy.pid });
      expect(q.running[0].startedAt).toEqual(expect.any(Number));
      // It finishes its turn after quiesce: the snapshot cuts it instead of counting it.
      busy.entry.busy = false;
      expect((await transfer('POST', '/api/handsfree/cloud/snapshot', { epoch: q.epoch, knownTips: {} })).status).toBe(200);
    } finally {
      unregisterLiveChat(busy.entry);
      try { process.kill(-busy.pid, 'SIGKILL'); } catch { /* gone */ }
    }
  }, 60_000);

  it('a partial wipe answers 500 ok:false with the files that stayed', async () => {
    await startActive();
    const locked = join(cwd(), '.claude');
    mkdirSync(locked, { recursive: true });
    writeFileSync(join(locked, '.env'), 'KEY=1\n');
    const { chmodSync } = await import('node:fs');
    chmodSync(locked, 0o555);
    try {
      const q = (await transfer('POST', '/api/handsfree/cloud/quiesce', { tripId: T })).json();
      const r = await transfer('POST', '/api/handsfree/cloud/wipe-secrets', { epoch: q.epoch });
      expect(r.status).toBe(500);
      expect(r.json()).toMatchObject({ ok: false, error: 'wipe_failed', failed: ['.claude/.env'] });
    } finally {
      chmodSync(locked, 0o755);
    }
  }, 60_000);

  it('unquiesce is refused (409 finalizing) while a seal is wiping', async () => {
    await startActive();
    // Something in scope that ignores SIGTERM keeps the seal's cut busy for the grace.
    const { spawn } = await import('node:child_process');
    const stubborn = spawn('/bin/sh', ['-c', 'trap "" TERM; while true; do sleep 1; done'], { cwd: cwd(), detached: true, stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 300));
      const q = (await transfer('POST', '/api/handsfree/cloud/quiesce', { tripId: T })).json();
      const sealing = wipeAndSeal();
      const un = await transfer('POST', '/api/handsfree/cloud/unquiesce', { epoch: q.epoch });
      expect(un.status).toBe(409);
      expect(un.json().error).toBe('finalizing');
      await sealing;
      expect((await transfer('GET', '/api/health')).json()).toMatchObject({ phase: 'sealed', sealedEpoch: q.epoch });
    } finally {
      try { process.kill(-stubborn.pid!, 'SIGKILL'); } catch { /* gone */ }
    }
  }, 60_000);
});

describe('POST runtime (D25): an exact npm version + its sha512 integrity, never a tarball', () => {
  const INTEGRITY = `sha512-${createHash('sha512').update('a published dreamcontext').digest('base64')}`;
  let exits: number[];
  beforeEach(() => { exits = []; setRuntimeExitForTests((c) => { exits.push(c); }); });
  afterEach(() => setRuntimeExitForTests((c) => process.exit(c)));
  const reqFile = () => join(process.env.DC_HF_SERVER_DIR!, RUNTIME_REQUEST_NAME);

  it('writes {version, integrity} for the root supervisor and exits 75 once the reply is out', async () => {
    const r = await transfer('POST', '/api/handsfree/cloud/runtime', { version: '0.30.0', integrity: INTEGRITY });
    expect(r.status).toBe(200);
    expect(r.json()).toEqual({ ok: true, restarting: true });
    expect(JSON.parse(readFileSync(reqFile(), 'utf8'))).toEqual({ version: '0.30.0', integrity: INTEGRITY });
    await new Promise((res) => setTimeout(res, 400));
    expect(exits).toEqual([RUNTIME_EXIT_CODE]);
  });

  it('rejects a bad version or integrity shape, an extra field, and the old upload body: nothing written, no exit', async () => {
    for (const body of [
      { version: 'latest', integrity: INTEGRITY },
      { version: '^0.30.0', integrity: INTEGRITY },
      { version: '0.30', integrity: INTEGRITY },
      { version: '0.30.0', integrity: 'sha1-abc' },
      { version: '0.30.0', integrity: `${INTEGRITY}x` },
      { version: '0.30.0' },
      { version: '0.30.0', integrity: INTEGRITY, tarballUrl: 'https://evil.example/x.tgz' },
      { uploadId: 'up-12345678' },
    ]) {
      const r = await transfer('POST', '/api/handsfree/cloud/runtime', body);
      expect(r.status).toBe(400);
      expect(r.json().error).toBe('bad_runtime');
    }
    await new Promise((res) => setTimeout(res, 300));
    expect(existsSync(reqFile())).toBe(false);
    expect(exits).toEqual([]);
  });
});
