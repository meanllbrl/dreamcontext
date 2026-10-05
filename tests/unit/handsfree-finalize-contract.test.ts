// D21 contract: the laptop's finalization (ensureCloudSealed / observeFinalization) runs the
// SAME cases against (a) the fake cloud rules the orchestrator tests use
// (tests/helpers/handsfree-fake-cloud-state.ts) and (b) lane D's real CloudStateStore + transfer
// routes over HTTP, driven by the laptop's real HttpCloudClient (HMAC proof, Origin, retries).
// Cases: normal, crash after seal (re-run), lost seal reply, self-seal after a served snapshot
// then a queued finalize, epoch moved. Plus the verdict table, rule for rule.
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Router } from '../../src/server/router.js';
import { cloudGate, sendError } from '../../src/server/middleware.js';
import { isCloud, setCloudMirrorPrefix, setCloudPhaseSource } from '../../src/server/cloud-mode.js';
import { HandsfreeAuth, hashPassphrase, setHandsfreeAuthForTests, sha256Hex } from '../../src/server/handsfree-auth.js';
import { cloudPhaseFromStore, registerHandsfreeCloudRoutes, setCloudServicesForTests, wipeAndSeal } from '../../src/server/routes/handsfree-cloud.js';
import { handleHealthGet } from '../../src/server/routes/health.js';
import { CloudStateStore } from '../../src/server/cloud-state.js';
import { TransferStore } from '../../src/server/cloud-transfers.js';
import { setWorkerInProcessForTests } from '../../src/server/cloud-worker.js';
import { rootIdFor, type GoManifest } from '../../src/lib/handsfree/manifest.js';
import { CloudError, CloudUnreachableError, HttpCloudClient, type CloudClient, type CloudHealth } from '../../src/lib/handsfree/cloud-client.js';
import { ensureCloudSealed } from '../../src/lib/handsfree/orchestrator.js';
import { fakeFinalize, fakeFinalizeVerdict, fakeMarkerVerdict, fakeQuiesce, fakeRequireSnapshotIfLost, fakeSelfSeal, type FakePhaseRecord } from '../helpers/handsfree-fake-cloud-state.js';

const TRIP = 't-20261004-c0ffee01';
const LAPTOP = 'lp-contract';

interface Harness {
  client: CloudClient;
  /** Trip TRIP quiescing at epoch E with its snapshot served and a secret file on the cloud. */
  begin(): Promise<number>;
  /** The return's next request runs on the cloud, but its reply never reaches the laptop. */
  loseNextSealReply(): void;
  selfSeal(): Promise<void>;
  /** A newer quiesce of the same trip (the cloud moved past our epoch). */
  moveEpoch(): Promise<void>;
  /** The mirror loses the trip marker. */
  loseMarker(): Promise<void>;
  /** The trip's folders are not on the cloud machine (an unmounted mirror). */
  removeRoots(): Promise<void>;
  secretPresent(): boolean;
  phase(): string;
  close(): Promise<void>;
}

// ---------------------------------------------------------------- (a) the fake rules

function fakeHarness(): Harness {
  const r: FakePhaseRecord & { tripId: string | null } = { phase: 'sealed', epoch: 0, sealedEpoch: null, tripId: null };
  let secret = false;
  let lose = false;
  let markerLost = false;
  let rootsPresent = true;
  let servedEpoch: number | null = null;
  const wipe = () => { secret = false; };
  const client = {
    async health(): Promise<CloudHealth> {
      return { version: '0', fingerprint: null, phase: r.phase, tripId: r.tripId, laptopId: LAPTOP, epoch: r.epoch, verifierGeneration: 1, supersededLaptopIds: [], sealedEpoch: r.sealedEpoch };
    },
    async wipeSecrets(epoch: number) { await fakeFinalize(r, 'wipe-secrets', epoch, wipe); },
    async seal(epoch: number) {
      if (fakeFinalizeVerdict(r, epoch) === 'do') fakeRequireSnapshotIfLost({ markerLost, servedEpoch, epoch });
      await fakeFinalize(r, 'seal', epoch, wipe);
      if (lose) { lose = false; throw new CloudUnreachableError('reply lost'); }
    },
    async quiesce(tripId: string, recovery?: boolean) {
      if (tripId !== r.tripId) throw new CloudError(409, 'trip_mismatch', 'other trip');
      return { ...fakeQuiesce(r, { markerLost, recovery: !!recovery, rootsPresent }), running: [] };
    },
    async snapshot(b: { epoch: number; tolerant?: boolean }) {
      if (fakeFinalizeVerdict(r, b.epoch) !== 'do') throw new CloudError(409, 'epoch_mismatch', 'epoch');
      fakeMarkerVerdict({ markerLost, recovery: !!b.tolerant, rootsPresent });
      servedEpoch = b.epoch;
      return { epoch: b.epoch, roots: [] };
    },
    async cut() {},
  } as unknown as CloudClient;
  return {
    client,
    async begin() { r.tripId = TRIP; r.phase = 'quiescing'; r.epoch = 1; secret = true; return r.epoch; },
    loseNextSealReply() { lose = true; },
    async selfSeal() { await fakeSelfSeal(r, wipe); },
    async moveEpoch() { r.epoch++; r.phase = 'quiescing'; },
    async loseMarker() { markerLost = true; },
    async removeRoots() { rootsPresent = false; },
    secretPresent: () => secret,
    phase: () => r.phase,
    async close() {},
  };
}

// ---------------------------------------------------------------- (b) lane D's real cloud

const SECRET = 'transfer-secret-for-the-contract';
const HOME = '/Users/hfcontract';
const PROJ = `${HOME}/proj`;
const ENV_KEYS = ['HOME', 'DREAMCONTEXT_CLOUD', 'DREAMCONTEXT_DESKTOP', 'DC_HF_ORIGIN', 'DC_HF_SERVER_DIR', 'DC_HF_PUBLIC_DIR'];

async function realHarness(): Promise<Harness> {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  const scratch = mkdtempSync(join(tmpdir(), 'hf-contract-'));
  process.env.DREAMCONTEXT_CLOUD = '1';
  delete process.env.DREAMCONTEXT_DESKTOP;
  process.env.DC_HF_SERVER_DIR = join(scratch, 'dc-server');
  process.env.DC_HF_PUBLIC_DIR = join(scratch, 'dc-server-pub');
  mkdirSync(process.env.DC_HF_SERVER_DIR, { recursive: true });
  const mirror = join(scratch, 'mirror');
  setCloudMirrorPrefix(mirror);
  const auth = new HandsfreeAuth({ dir: process.env.DC_HF_SERVER_DIR });
  auth.store.installVerifiers({ generation: 1, passphrase: await hashPassphrase('a b c d e f'), transferSha256: sha256Hex(SECRET) });
  setHandsfreeAuthForTests(auth);
  const state = new CloudStateStore({ dir: process.env.DC_HF_SERVER_DIR });
  setCloudServicesForTests({ state, transfers: new TransferStore({ dir: process.env.DC_HF_SERVER_DIR }) });
  setCloudPhaseSource(cloudPhaseFromStore);
  setWorkerInProcessForTests(true);
  const router = new Router();
  router.get('/api/health', handleHealthGet);
  registerHandsfreeCloudRoutes(router);
  const server: Server = createServer(async (req, res) => {
    if (isCloud() && !cloudGate(req, res)) return;
    const m = router.match(req.method || 'GET', new URL(req.url || '/', 'http://x').pathname);
    if (!m) { sendError(res, 404, 'not_found', 'no route'); return; }
    await m.handler(req, res, m.params, '');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.DC_HF_ORIGIN = origin;
  const secretFile = join(mirror, PROJ, '_dream_context', '.env');
  let lose = false;
  // The laptop's real client; a "lost reply" lets the request run on the server, then drops it.
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const res = await fetch(url, init);
    if (lose && String(url).endsWith('/api/handsfree/cloud/seal')) { lose = false; await res.arrayBuffer(); throw new TypeError('fetch failed'); }
    return res;
  }) as typeof fetch;
  const client = new HttpCloudClient({ origin, secret: SECRET, fetchImpl, sleep: async () => {} });
  const go: GoManifest = {
    version: 1, tripId: TRIP, laptopId: LAPTOP, createdAt: new Date(0).toISOString(), home: HOME,
    roots: [{ rootId: rootIdFor(PROJ), kind: 'vault', absPath: PROJ }],
  };
  return {
    client,
    async begin() {
      mkdirSync(join(mirror, PROJ, '_dream_context'), { recursive: true });
      writeFileSync(secretFile, 'TOKEN=cloud\n');
      const t = state.startTrip({ tripId: TRIP, laptopId: LAPTOP, go, rootIds: [rootIdFor(PROJ)], takeOver: false });
      expect(t.ok).toBe(true);
      state.activate(TRIP);
      const q = state.quiesce(TRIP);
      if (!q.ok) throw new Error('quiesce');
      state.markServed(q.epoch);
      return q.epoch;
    },
    loseNextSealReply() { lose = true; },
    async selfSeal() { await wipeAndSeal(); },
    async moveEpoch() { const q = state.quiesce(TRIP); if (!q.ok) throw new Error('quiesce'); },
    // This harness starts the trip through the store, so the mirror never got a marker: lost.
    async loseMarker() { rmSync(join(mirror, HOME, '.dreamcontext-handsfree-trip.json'), { force: true }); },
    async removeRoots() { rmSync(join(mirror, PROJ), { recursive: true, force: true }); },
    secretPresent: () => existsSync(secretFile),
    phase: () => state.get().phase,
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
      for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
      setHandsfreeAuthForTests(null);
      setCloudServicesForTests(null);
      setCloudPhaseSource(() => 'sealed');
      setWorkerInProcessForTests(false);
      setCloudMirrorPrefix(null);
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------- the shared cases

let h: Harness | null = null;
afterEach(async () => { await h?.close(); h = null; });

for (const [name, make] of [['fake rules', async () => fakeHarness()], ["lane D's real cloud", realHarness]] as const) {
  describe(`D21 finalization contract: ${name}`, () => {
    it('normal: wipe + seal, sealed, the secret class gone', async () => {
      h = await make();
      const e = await h.begin();
      expect(await ensureCloudSealed(h.client, TRIP, e)).toEqual({ kind: 'sealed' });
      expect(h.phase()).toBe('sealed');
      expect(h.secretPresent()).toBe(false);
      expect((await h.client.health()).sealedEpoch).toBe(e);
    });

    it('crash after seal: the re-run (Resume) is done, never wedged', async () => {
      h = await make();
      const e = await h.begin();
      await ensureCloudSealed(h.client, TRIP, e);
      expect(await ensureCloudSealed(h.client, TRIP, e)).toEqual({ kind: 'sealed' });
    });

    it('a seal whose reply was lost: done', async () => {
      h = await make();
      const e = await h.begin();
      h.loseNextSealReply();
      expect(await ensureCloudSealed(h.client, TRIP, e)).toEqual({ kind: 'sealed' });
      expect(h.phase()).toBe('sealed');
    });

    it('self-seal after a served snapshot, then the queued finalize: satisfied, secrets already wiped', async () => {
      h = await make();
      const e = await h.begin();
      await h.selfSeal();
      expect(h.secretPresent()).toBe(false);
      expect(await ensureCloudSealed(h.client, TRIP, e)).toEqual({ kind: 'sealed' });
    });

    it('epoch moved past ours: the delta pass, nothing sealed', async () => {
      h = await make();
      const e = await h.begin();
      await h.moveEpoch();
      expect(await ensureCloudSealed(h.client, TRIP, e)).toEqual({ kind: 'delta' });
      expect(h.phase()).toBe('quiescing');
    });

    it('a lost trip marker: a normal quiesce is trip_lost; a recovery quiesce answers tripLost, then cut + seal: sealed, secrets gone', async () => {
      h = await make();
      await h.begin();
      await h.loseMarker();
      await expect(h.client.quiesce(TRIP)).rejects.toMatchObject({ code: 'trip_lost' });
      const q = await h.client.quiesce(TRIP, true);
      expect(q.tripLost).toBe(true);
      await h.client.cut(q.epoch);
      // The recovery snapshot comes BEFORE the seal: never sealed first; a tolerant snapshot is accepted, a normal one not.
      await expect(h.client.seal(q.epoch)).rejects.toMatchObject({ code: 'snapshot_first' });
      await expect(h.client.snapshot({ epoch: q.epoch, knownTips: {} })).rejects.toMatchObject({ code: 'trip_lost' });
      expect(await h.client.snapshot({ epoch: q.epoch, tolerant: true, knownTips: {} })).toMatchObject({ epoch: q.epoch });
      expect(await ensureCloudSealed(h.client, TRIP, q.epoch)).toEqual({ kind: 'sealed' });
      expect(h.phase()).toBe('sealed');
      expect(h.secretPresent()).toBe(false);
      expect((await h.client.health()).sealedEpoch).toBe(q.epoch);
    }, 120_000);

    it('a lost marker with the roots ABSENT: the recovery quiesce and snapshot refuse mirror_absent; nothing is quiesced, snapshotted or sealed', async () => {
      h = await make();
      const e = await h.begin();
      await h.loseMarker();
      await h.removeRoots();
      await expect(h.client.quiesce(TRIP, true)).rejects.toMatchObject({ code: 'mirror_absent' });
      await expect(h.client.snapshot({ epoch: e, tolerant: true, knownTips: {} })).rejects.toMatchObject({ code: 'mirror_absent' });
      expect(h.phase()).toBe('quiescing');
      expect((await h.client.health()).sealedEpoch).toBeNull();
    });
  });
}

describe('the fake verdict is lane D\'s, rule for rule', () => {
  it('matches CloudStateStore.finalizeVerdict over every phase/epoch/sealedEpoch combination', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hf-verdict-'));
    try {
      for (const phase of ['sealed', 'active', 'quiescing'] as const) {
        for (const epoch of [1, 2, 3]) {
          for (const sealedEpoch of [null, 1, 2, 3]) {
            writeFileSync(join(dir, 'cloud-trip.json'), JSON.stringify({ version: 1, phase, epoch, sealedEpoch, tripId: TRIP, laptopId: LAPTOP, supersededLaptopIds: [], rootIds: [] }));
            const real = new CloudStateStore({ dir });
            for (const asked of [0, 1, 2, 3, 4, 'x']) {
              expect(fakeFinalizeVerdict({ phase, epoch, sealedEpoch }, asked), `${phase} e${epoch} s${sealedEpoch} asked ${asked}`).toBe(real.finalizeVerdict(asked));
            }
          }
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
