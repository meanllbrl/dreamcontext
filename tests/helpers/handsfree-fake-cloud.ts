// The in-memory fake cloud for the hands-free orchestrator tests: lane D's transfer routes,
// emulated with the W1 library on a mirror under a second scratch home (prefix-mapped paths),
// finalization by the shared D21 rules (handsfree-fake-cloud-state.ts). A factory with its own
// context, so concurrent tests (the fault-injection walk) never share state.
import { execFileSync } from 'node:child_process';
import { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  createBundle, fetchBundle, parseRepoSnapshot, snapshotBundleRefs, snapshotId, snapshotRepo, type ProcessRunner, type RepoSnapshot,
} from '../../src/lib/handsfree/git-snapshot.js';
import { applyRemoteRefs, baseTips, gitOpHandlers, planRepoApply, setBaseRefs, verifyIncoming } from '../../src/lib/handsfree/git-apply.js';
import { applyPack, BackupStore, planMirror } from '../../src/lib/handsfree/apply.js';
import {
  buildManifest, encodeProjectDir, isSecretClass, manifestFromJSON, manifestToJSON, rootIdFor, sameContent, selectNonGitEntries, walk, type GoManifest,
  type Manifest, type ManifestEntry,
} from '../../src/lib/handsfree/manifest.js';
import { readPack, writePack } from '../../src/lib/handsfree/pack.js';
import {
  CloudError, CloudUnreachableError, PortPrivateError, manifestDigest, type GitReceiveBody, type CloudClient, type CloudHealth, type CloudPhaseName,
  type RunningTurn, type SnapshotRoot,
} from '../../src/lib/handsfree/cloud-client.js';
import type { JournalOp } from '../../src/lib/handsfree/journal.js';
import { fakeFinalize, fakeFinalizeVerdict, fakeMarkerVerdict, fakeQuiesce, fakeRequireSnapshotIfLost, fakeUnquiesce } from './handsfree-fake-cloud-state.js';

/** The version every fake cloud runs at first; laptop envs in the tests report the same (no parity install). */
export const FAKE_CLOUD_VERSION = '0.30.0';
/** The npm integrity the fake registry publishes for it (the fake never installs anything). */
export const FAKE_INTEGRITY = `sha512-${createHash('sha512').update('dreamcontext fake tarball').digest('base64')}`;

/**
 * The injected npm registry (D25): answers `GET /dreamcontext/<v>` for the versions it was given,
 * 404 for the rest; never the network. `seen` lists the asked versions.
 */
export function fakeRegistry(published: Record<string, string> = { [FAKE_CLOUD_VERSION]: FAKE_INTEGRITY }) {
  const seen: string[] = [];
  const fetchImpl = (async (url: string) => {
    const m = /\/dreamcontext\/([^/]+)$/.exec(new URL(url).pathname);
    const v = m ? decodeURIComponent(m[1]) : '';
    seen.push(v);
    const integrity = published[v];
    if (!integrity) return new Response('{"error":"Not found"}', { status: 404 });
    return new Response(JSON.stringify({ name: 'dreamcontext', version: v, dist: { integrity } }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

export interface FakeCloudContext {
  run: ProcessRunner;
  laptopHome: string;
  cloudHome: string;
  gitenv: Record<string, string>;
  scratch: string;
}

export function createFakeCloud(ctx: FakeCloudContext) {
  const { run, laptopHome, cloudHome } = ctx;
  const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: ctx.gitenv, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const toCloud = (p: string) => (p.startsWith(laptopHome) ? cloudHome + p.slice(laptopHome.length) : p);
  const toLaptop = (p: string) => (p.startsWith(cloudHome) ? laptopHome + p.slice(cloudHome.length) : p);
  const cloudId = (abs: string) => rootIdFor(toLaptop(abs));
  void writeFileSync;
  class FakeCloud implements CloudClient {
    readonly origin = 'https://fake-hf-1-8080.app.github.dev';
    phase: CloudPhaseName = 'sealed';
    tripId: string | null = null;
    laptopId: string | null = null;
    epoch = 0;
    superseded: string[] = [];
    verifierGeneration = 0;
    lost = false;
    /** Emulate a cloud from before the tripLost recovery quiesce (refuses it too). */
    oldCloudNoLostRecovery = false;
    /** The trip's folders are not on the cloud machine (an unmounted mirror). */
    mirrorAbsent = false;
    servedEpoch: number | null = null;
    running: RunningTurn[] = [];
    goM: GoManifest | null = null;
    recorded = new Map<string, ManifestEntry[]>();
    agreedGit = new Map<string, RepoSnapshot>();
    uploads = new Map<string, string>();
    downloads = new Map<string, string>();
    /** Runs right before seal answers (the phone wakes it after the snapshot). */
    beforeSeal: (() => void) | null = null;
    preflightProblem: string | null = null;
    includes: Record<string, string[]> = {};
    gitBodies: Array<Omit<GitReceiveBody, 'snapshot'>> = [];
    mirrorPending = 0;
    liveProcesses = 0;
    sealedEpoch: number | null = null;
    checkoutCompromised = false;
    loseSealReply = false;
    privateTimes = 0;
    beforeWipe: (() => void) | null = null;
    failWipe: Error | null = null;
    forged: SnapshotRoot | null = null;
    calls: string[] = [];
    /** The dreamcontext version the fake reports (D25 parity); `runtime` "installs" another. */
    version = FAKE_CLOUD_VERSION;
    runtimeRequests: Array<{ version: string; integrity: string }> = [];
    private n = 0;
  
    constructor(private readonly scratch: string) {
      mkdirSync(join(scratch, 'up'), { recursive: true });
      mkdirSync(join(scratch, 'dl'), { recursive: true });
    }
  
    markStarted(): void {}
    async publicHealth() {
      if (this.privateTimes > 0) { this.privateTimes--; throw new PortPrivateError(this.origin); }
      return { version: this.version, fingerprint: 'fp' };
    }
    async health(): Promise<CloudHealth> {
      return { version: this.version, fingerprint: 'fp', phase: this.phase, tripId: this.tripId, laptopId: this.laptopId, epoch: this.epoch, verifierGeneration: this.verifierGeneration, supersededLaptopIds: this.superseded, sealedEpoch: this.sealedEpoch, checkoutCompromised: this.checkoutCompromised };
    }
    async uploadFile(path: string) {
      const id = `up-${String(++this.n).padStart(8, '0')}`;
      copyFileSync(path, join(this.scratch, 'up', id));
      this.uploads.set(id, join(this.scratch, 'up', id));
      return id;
    }
    async downloadTo(blob: { id: string; size: number; sha256: string }, path: string) {
      const src = this.downloads.get(blob.id)!;
      copyFileSync(src, path);
      if (createHash('sha256').update(readFileSync(path)).digest('hex') !== blob.sha256) throw new Error('bad download');
    }
    private blob(path: string) {
      const id = `dl-${String(++this.n).padStart(8, '0')}`;
      this.downloads.set(id, path);
      const b = readFileSync(path);
      return { id, size: b.length, sha256: createHash('sha256').update(b).digest('hex') };
    }
    async verifiers(push: { generation: number }) { this.verifierGeneration = push.generation; return { ok: true as const, generation: push.generation, changed: true }; }
    async revokeAll(generation: number) { this.verifierGeneration = generation; return { ok: true as const, generation, changed: true }; }
    async runtime(pin: { version: string; integrity: string }) { this.runtimeRequests.push(pin); this.version = pin.version; }
    async trip(b: { tripId: string; laptopId: string; go: GoManifest; takeOver?: boolean; includes: Record<string, string[]> }) {
      this.calls.push('trip');
      if (this.mirrorPending > 0) { this.mirrorPending--; throw new CloudUnreachableError('503 mirror_pending', 'mirror_pending'); }
      this.includes = JSON.parse(JSON.stringify(b.includes));
      if (this.phase !== 'sealed') throw new CloudError(409, 'not_sealed', 'not sealed');
      if (b.takeOver && this.laptopId && this.laptopId !== b.laptopId) this.superseded.push(this.laptopId);
      this.tripId = b.tripId;
      this.laptopId = b.laptopId;
      this.goM = JSON.parse(JSON.stringify(b.go));
      this.lost = false;
    }
    spec(rootId: string) {
      const s = this.goM!.roots.find((r) => r.rootId === rootId);
      if (!s) throw new CloudError(404, 'unknown_root', rootId);
      return s;
    }
    async currentFiles(rootId: string) {
      const s = this.spec(rootId);
      const r = toCloud(s.absPath);
      if (!existsSync(r)) return { manifest: new Map() as Manifest, refused: [] as Array<{ path: string; reason: string }> };
      const sel = s.kind === 'transcripts' ? walk(r, [''], { side: 'cloud' }) : await selectNonGitEntries(run, r, { isGitRepo: s.kind === 'repo', side: 'cloud', include: this.includes[rootId] ?? [] });
      const refused = [...sel.refused];
      return { manifest: await buildManifest(r, sel.entries, undefined, refused), refused };
    }
    async state(rootId: string) {
      const s = this.spec(rootId);
      if (s.kind === 'repo') {
        const c = toCloud(s.absPath);
        return { kind: 'repo' as const, snapshot: null, baseTips: existsSync(join(c, '.git')) ? await baseTips(run, c) : [] };
      }
      return { kind: 'files' as const, manifest: manifestToJSON((await this.currentFiles(rootId)).manifest) };
    }
    async gitReceive(b: GitReceiveBody) {
      const s = this.spec(b.rootId);
      const C = toCloud(s.absPath);
      this.gitBodies.push(JSON.parse(JSON.stringify({ ...b, snapshot: null })));
      if (!existsSync(join(C, '.git'))) { mkdirSync(C, { recursive: true }); sh(C, 'init', '-q'); }
      // v1.1: the GENERATED .git/info/ and remotes (a URL that still carries userinfo is refused).
      for (const k of ['exclude', 'attributes'] as const) {
        if (b.info[k] !== undefined) { mkdirSync(join(C, '.git', 'info'), { recursive: true }); writeFileSync(join(C, '.git', 'info', k), b.info[k]!); }
      }
      for (const r of b.remotes) {
        if (/^[a-z][a-z0-9+.-]*:\/\/[^/]*@/i.test(r.url) || /^[^/@:]+@[^/:]+:/.test(r.url)) throw new CloudError(400, 'bad_remote', 'userinfo');
        try { sh(C, 'remote', 'set-url', r.name, r.url); } catch { sh(C, 'remote', 'add', r.name, r.url); }
      }
      // A merge left in progress (already captured by the D12 recovery) is cleared before S lands.
      if (existsSync(join(C, '.git', 'MERGE_HEAD'))) sh(C, 'merge', '--abort');
      // Reach S from whatever the cloud holds NOW (the phone may have worked since the last trip).
      const hasHead = (() => { try { sh(C, 'rev-parse', '-q', '--verify', 'HEAD'); return true; } catch { return false; } })();
      const current = hasHead ? await snapshotRepo(run, C, { trip: b.tripId, side: 'cloud', checkoutIdFor: cloudId, writeRefs: false }) : null;
      const fetched = b.uploadId ? await fetchBundle(run, C, this.uploads.get(b.uploadId)!, { trip: b.tripId, acceptRemotes: true }) : {};
      const incoming = parseRepoSnapshot(JSON.parse(JSON.stringify(b.snapshot)), b.tripId);
      await verifyIncoming(run, C, incoming, fetched);
      const plan = await planRepoApply(run, {
        repoPath: C, trip: b.tripId, incoming, fetched, receiverStart: current, receiverNow: null,
        localCheckouts: { [cloudId(C)]: C }, policy: 'overwrite', strict: false,
      });
      const h = gitOpHandlers(run, { tripDir: join(this.scratch, 'trips', b.tripId) });
      for (const op of plan.ops) await h[op.kind].apply({ ...op, state: 'pending' } as JournalOp);
      if (incoming.remoteRefs) await applyRemoteRefs(run, C, incoming.remoteRefs);
      const cs = await snapshotRepo(run, C, { trip: b.tripId, side: 'cloud', checkoutIdFor: cloudId });
      this.agreedGit.set(b.rootId, cs);
      await setBaseRefs(run, C, Object.fromEntries(Object.values(cs.refs).map((o, i) => [`refs/handsfree/base/c${i}`, o])));
      return { snapshotId: snapshotId(cs) };
    }
    async filesReceive(b: { tripId: string; rootId: string; uploadId?: string; expected: ManifestEntry[] }) {
      const s = this.spec(b.rootId);
      const r = toCloud(s.absPath);
      mkdirSync(r, { recursive: true });
      const incoming = manifestFromJSON(b.expected);
      const now = (await this.currentFiles(b.rootId)).manifest;
      const plan = planMirror(now, incoming);
      const res = await applyPack(() => createReadStream(this.uploads.get(b.uploadId!)!), {
        root: r, plan, expected: now, incoming, conflictsDir: join(this.scratch, 'conf'), backup: new BackupStore(join(this.scratch, 'bk', b.rootId, String(++this.n))),
        policy: 'overwrite', maxBytes: 1 << 30,
      });
      this.recorded.set(b.rootId, b.expected);
      const after = (await this.currentFiles(b.rootId)).manifest;
      return { refused: res.refused, digest: manifestDigest(after.values()) };
    }
    async global(uploadId: string) { await readPack(createReadStream(this.uploads.get(uploadId)!), async () => {}, { maxBytes: 1 << 30 }); }
    async activate() { this.phase = 'active'; }
    async quiesce(tripId: string, recovery?: boolean) {
      this.calls.push('quiesce');
      if (tripId !== this.tripId) throw new CloudError(409, 'trip_mismatch', 'other trip');
      // Lane D's rule: a missing marker refuses a normal quiesce; a RECOVERY quiesce still
      // quiesces under a new epoch and answers tripLost (so it can be cut + sealed).
      const q = fakeQuiesce(this, { markerLost: this.lost, recovery: !!recovery && !this.oldCloudNoLostRecovery, rootsPresent: !this.mirrorAbsent });
      return { ...q, running: this.running };
    }
    async cut() { this.calls.push('cut'); this.running = []; }
    async unquiesce() { this.calls.push('unquiesce'); fakeUnquiesce(this); }
    async snapshot(b: { epoch: number; tolerant?: boolean; knownTips: Record<string, string[]> }) {
      this.calls.push('snapshot');
      if (b.epoch !== this.epoch) throw new CloudError(409, 'epoch_mismatch', 'epoch');
      // The same marker rule as quiesce: only a tolerant (recovery) snapshot of roots on disk.
      fakeMarkerVerdict({ markerLost: this.lost, recovery: !!b.tolerant && !this.oldCloudNoLostRecovery, rootsPresent: !this.mirrorAbsent });
      this.servedEpoch = b.epoch;
      if (this.preflightProblem) throw new CloudError(409, 'preflight', 'preflight', { problems: [this.preflightProblem] });
      // Lane D (D22): live processes in the mirror roots refuse the snapshot until cut.
      if (this.liveProcesses > 0 && !this.calls.includes('cut')) { this.liveProcesses--; throw new CloudError(409, 'turns_running', 'processes are still running'); }
      const trip = this.tripId!;
      const roots: SnapshotRoot[] = [];
      for (const s of this.goM!.roots.filter((x) => x.kind === 'repo')) {
        const C = toCloud(s.absPath);
        const cs = await snapshotRepo(run, C, { trip, side: 'cloud', checkoutIdFor: cloudId, tolerant: !!b.tolerant });
        const out = join(this.scratch, 'dl', `${++this.n}.bundle`);
        const made = await createBundle(run, C, { refs: snapshotBundleRefs(cs), knownTips: b.knownTips[s.rootId] ?? [], out });
        // v1.1: worktrees created in the cloud (absolute paths) + their transcript dirs, keyed by rootIdFor(path).
        const added = cs.checkouts.filter((c) => !c.isMain).map((c) => toLaptop(c.path));
        roots.push({ rootId: s.rootId, kind: 'repo', snapshot: JSON.parse(JSON.stringify(cs)), worktreesAdded: added, ...(made.created ? { bundle: this.blob(out) } : {}) });
        for (const lp of added) {
          const tdir = join(cloudHome, '.claude', 'projects', encodeProjectDir(lp));
          if (!existsSync(tdir)) continue;
          const m = await buildManifest(tdir, walk(tdir, [''], { side: 'cloud' }).entries);
          const out2 = join(this.scratch, 'dl', `${++this.n}.pack`);
          await writePack(createWriteStream(out2), { root: tdir, entries: m.values() });
          roots.push({ rootId: rootIdFor(lp), kind: 'files', manifest: manifestToJSON(m), refused: [], pack: this.blob(out2) });
        }
      }
      if (this.forged) roots.push(this.forged);
      for (const s of this.goM!.roots) {
        const { manifest, refused } = await this.currentFiles(s.rootId);
        const atGo = manifestFromJSON(this.recorded.get(s.rootId) ?? []);
        const changed = [...manifest.values()].filter((e) => !sameContent(atGo.get(e.path), e));
        const deletions = [...atGo.keys()].filter((p) => !manifest.has(p));
        let pack;
        if (changed.length || deletions.length) {
          const out = join(this.scratch, 'dl', `${++this.n}.pack`);
          await writePack(createWriteStream(out), { root: toCloud(s.absPath), entries: changed, deletions });
          pack = this.blob(out);
        }
        roots.push({ rootId: s.rootId, kind: 'files', manifest: manifestToJSON(manifest), refused, ...(pack ? { pack } : {}) });
      }
      return { epoch: b.epoch, roots };
    }
    async doWipe() {
      for (const s of this.goM!.roots) {
        const { manifest } = await this.currentFiles(s.rootId);
        for (const p of manifest.keys()) if (isSecretClass(p)) rmSync(join(toCloud(s.absPath), p), { force: true });
      }
    }
    // Lane D's D21 rules (tests/helpers/handsfree-fake-cloud-state.ts, held to the real store by
    // handsfree-finalize-contract.test.ts).
    async wipeSecrets(epoch: number) {
      this.calls.push('wipe');
      if (this.failWipe) { const e = this.failWipe; this.failWipe = null; throw e; }
      if (this.beforeWipe) { const f = this.beforeWipe; this.beforeWipe = null; f(); }
      if (fakeFinalizeVerdict(this, epoch) === 'do') fakeRequireSnapshotIfLost({ markerLost: this.lost, servedEpoch: this.servedEpoch, epoch });
      return fakeFinalize(this, 'wipe-secrets', epoch, () => this.doWipe());
    }
    async seal(epoch: number) {
      this.calls.push('seal');
      if (this.beforeSeal) { const f = this.beforeSeal; this.beforeSeal = null; f(); }
      if (fakeFinalizeVerdict(this, epoch) === 'do') fakeRequireSnapshotIfLost({ markerLost: this.lost, servedEpoch: this.servedEpoch, epoch });
      await fakeFinalize(this, 'seal', epoch, () => this.doWipe());
      if (this.loseSealReply) { this.loseSealReply = false; throw new CloudUnreachableError('the reply was lost'); }
    }
    async accounts() { return [{ id: 'main', label: 'main', signedIn: false }]; }
  }
  return new FakeCloud(ctx.scratch);
}

export type FakeCloud = ReturnType<typeof createFakeCloud>;
