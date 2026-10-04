// Hands-free non-git apply: the three-way rule against the trip-start manifest (AC8),
// compare-and-write, backup-before-overwrite + Roll back, symlinks last and contained,
// parent-symlink refusal, and idempotent replay.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  chmodSync, createReadStream, createWriteStream, cpSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync,
  readdirSync,
  readlinkSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildManifest, walk, type Manifest } from '../../src/lib/handsfree/manifest.js';
import { writePack } from '../../src/lib/handsfree/pack.js';
import { BackupStore, applyPack, planMirror, planNonGitReturn, resweepRootWithBackups } from '../../src/lib/handsfree/apply.js';
import { createHash } from 'node:crypto';

let tmp: string;
let laptop: string;
let cloud: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'hf-apply-'));
  laptop = join(tmp, 'laptop');
  cloud = join(tmp, 'cloud');
  mkdirSync(laptop);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const put = (root: string, rel: string, data: string) => {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), data);
};
const read = (root: string, rel: string) => readFileSync(join(root, rel), 'utf8');
const manifestOf = async (root: string): Promise<Manifest> => buildManifest(root, walk(root, [''], { side: 'laptop' }).entries);
/**
 * A HOSTILE cloud's manifest: the honest walk leaves out links that cannot travel (D19,
 * 'stays on the laptop'); a compromised cloud sends them anyway, which the receiving
 * guard must still refuse.
 */
const hostileManifestOf = async (root: string): Promise<Manifest> => {
  const w = walk(root, [''], { side: 'laptop' });
  const links = w.refused.filter((r) => r.reason === 'stays on the laptop').map((r) => ({ path: r.path, type: 'symlink' as const }));
  return buildManifest(root, [...w.entries, ...links]);
};

async function packOf(root: string, m: Manifest, paths: string[]): Promise<string> {
  const p = join(tmp, `pack-${Math.random().toString(36).slice(2)}.pack`);
  await writePack(createWriteStream(p), { root, entries: paths.map((x) => m.get(x)!).filter(Boolean) });
  return p;
}

describe('planNonGitReturn (three-way against the trip-start manifest)', () => {
  it('applies cloud-only changes and sends every both-sides case to conflicts', async () => {
    put(laptop, 'same.md', 's');
    put(laptop, 'cloud-edit.md', 'v1');
    put(laptop, 'both-edit.md', 'v1');
    put(laptop, 'cloud-del-laptop-mod.md', 'v1');
    put(laptop, 'laptop-del-cloud-mod.md', 'v1');
    put(laptop, 'cloud-del.md', 'v1');
    put(laptop, 'converged.md', 'v1');
    put(laptop, '.env', 'A=1');
    const start = await manifestOf(laptop);
    cpSync(laptop, cloud, { recursive: true });

    put(cloud, 'cloud-edit.md', 'v2');
    put(cloud, 'both-edit.md', 'cloud');
    rmSync(join(cloud, 'cloud-del-laptop-mod.md'));
    put(cloud, 'laptop-del-cloud-mod.md', 'cloud');
    rmSync(join(cloud, 'cloud-del.md'));
    put(cloud, 'converged.md', 'v9');
    put(cloud, 'new.md', 'n');
    put(cloud, '.env', 'A=2');
    put(cloud, '_dream_context/state/.secrets.json', '{"token":"x"}');

    put(laptop, 'both-edit.md', 'laptop');
    put(laptop, 'cloud-del-laptop-mod.md', 'laptop');
    rmSync(join(laptop, 'laptop-del-cloud-mod.md'));
    put(laptop, 'converged.md', 'v9');

    const plan = planNonGitReturn(start, await manifestOf(laptop), await manifestOf(cloud), []);
    expect(plan.write.sort()).toEqual(['.env', 'cloud-edit.md', 'new.md']);
    // D20: nothing is ever deleted on the laptop; cloud deletions are listed, kept here.
    expect(plan.delete).toEqual([]);
    expect(plan.deletedInCloud).toEqual(['cloud-del-laptop-mod.md', 'cloud-del.md']);
    expect(Object.fromEntries(plan.conflicts.map((c) => [c.path, c.reason]))).toEqual({
      'both-edit.md': 'changed on both sides',
      'laptop-del-cloud-mod.md': 'deleted on the laptop, changed in the cloud',
    });
    // D16: the secret class comes home (cloud wins); dreamcontext's own credentials never do.
    expect(plan.cloudWins).toEqual(['.env']);
    expect(plan.refused.map((r) => r.path)).toEqual(['_dream_context/state/.secrets.json']);
  });

  it('a case-only collision with an existing laptop path goes to conflicts', async () => {
    put(laptop, 'Notes.md', 'x');
    const start = await manifestOf(laptop);
    const cloudM = new Map(start);
    const e = { ...start.get('Notes.md')!, path: 'notes.md', sha256: 'a'.repeat(64) };
    cloudM.set('notes.md', e);
    const plan = planNonGitReturn(start, start, cloudM, []);
    expect(plan.write).toEqual([]);
    expect(plan.conflicts[0].path).toBe('notes.md');
  });
});

describe('applyPack', () => {
  async function scenario() {
    put(laptop, 'keep.md', 'k');
    put(laptop, 'edit.md', 'old');
    put(laptop, 'gone.md', 'bye');
    put(laptop, 'both.md', 'base');
    const start = await manifestOf(laptop);
    cpSync(laptop, cloud, { recursive: true });
    put(cloud, 'edit.md', 'new');
    rmSync(join(cloud, 'gone.md'));
    put(cloud, 'both.md', 'cloud');
    put(cloud, 'dir/added.sh', '#!/bin/sh\necho hi\n');
    chmodSync(join(cloud, 'dir/added.sh'), 0o755);
    const t = new Date('2026-05-05T05:05:05Z');
    utimesSync(join(cloud, 'edit.md'), t, t);
    symlinkSync('../keep.md', join(cloud, 'dir/link'));
    put(laptop, 'both.md', 'laptop');
    const cloudM = await manifestOf(cloud);
    const laptopNow = await manifestOf(laptop);
    const plan = planNonGitReturn(start, laptopNow, cloudM, []);
    const pack = await packOf(cloud, cloudM, [...plan.write, ...plan.conflicts.map((c) => c.path).filter((p) => cloudM.has(p))]);
    const ctx = {
      root: laptop, plan, expected: laptopNow, incoming: cloudM,
      conflictsDir: join(tmp, 'trips/t1/conflicts/r1'), backup: new BackupStore(join(tmp, 'trips/t1/backup/r1')),
      policy: 'conflict' as const, maxBytes: 1 << 30,
    };
    return { pack, ctx, t };
  }

  it('writes, keeps cloud deletions (D20), keeps conflicts, sets mtime + exec bit, writes the symlink last; replay is idempotent', async () => {
    const { pack, ctx, t } = await scenario();
    const res = await applyPack(() => createReadStream(pack), ctx);
    expect(res.written.sort()).toEqual(['dir/added.sh', 'dir/link', 'edit.md']);
    expect(res.deleted).toEqual([]);
    expect(res.deletedInCloud).toEqual(['gone.md']);
    expect(res.conflicts).toEqual([{ path: 'both.md', reason: 'changed on both sides' }]);
    expect(read(laptop, 'edit.md')).toBe('new');
    expect(statSync(join(laptop, 'edit.md')).mtime.getTime()).toBe(t.getTime());
    expect(statSync(join(laptop, 'dir/added.sh')).mode & 0o111).not.toBe(0);
    expect(readlinkSync(join(laptop, 'dir/link'))).toBe('../keep.md');
    expect(read(laptop, 'gone.md')).toBe('bye'); // deleted on the phone, kept here
    expect(read(laptop, 'both.md')).toBe('laptop');
    expect(read(ctx.conflictsDir, 'both.md')).toBe('cloud');

    const again = await applyPack(() => createReadStream(pack), ctx);
    expect(again.written).toEqual([]);
    expect(again.alreadyDone.sort()).toEqual(['dir/added.sh', 'dir/link', 'edit.md']);
  });

  it('every overwritten laptop file is backed up first; Roll back restores exactly those', async () => {
    const { pack, ctx } = await scenario();
    await applyPack(() => createReadStream(pack), ctx);
    expect(read(join(ctx.backup.filesDir), 'edit.md')).toBe('old');
    expect(existsSync(join(ctx.backup.filesDir, 'gone.md'))).toBe(false); // never touched
    put(laptop, 'untouched-by-return.md', 'mine');
    const r = ctx.backup.restore(laptop);
    expect(r.restored.sort()).toEqual(['edit.md']);
    expect(r.removed.sort()).toEqual(['dir/added.sh', 'dir/link']);
    expect(read(laptop, 'edit.md')).toBe('old');
    expect(read(laptop, 'gone.md')).toBe('bye');
    expect(existsSync(join(laptop, 'dir'))).toBe(false);
    expect(read(laptop, 'both.md')).toBe('laptop');
    expect(read(laptop, 'untouched-by-return.md')).toBe('mine');
  });

  it('compare-and-write: a laptop edit after the plan is kept and the cloud copy goes to conflicts', async () => {
    const { pack, ctx } = await scenario();
    put(laptop, 'edit.md', 'edited during return');
    const res = await applyPack(() => createReadStream(pack), ctx);
    expect(read(laptop, 'edit.md')).toBe('edited during return');
    expect(read(ctx.conflictsDir, 'edit.md')).toBe('new');
    expect(res.conflicts.map((c) => c.path)).toContain('edit.md');
  });

  it('refuses a symlink whose target escapes the root and never writes through a symlinked parent', async () => {
    const outside = join(tmp, 'outside');
    mkdirSync(outside);
    mkdirSync(cloud);
    symlinkSync('../../../outside/x', join(cloud, 'evil-link'));
    put(cloud, 'sub/file.txt', 'payload');
    const cloudM = await hostileManifestOf(cloud);
    // The laptop's `sub` is a symlink pointing outside the root (a planted parent).
    symlinkSync(outside, join(laptop, 'sub'));
    const empty: Manifest = new Map();
    const plan = planMirror(empty, cloudM);
    const pack = await packOf(cloud, cloudM, plan.write);
    const res = await applyPack(() => createReadStream(pack), {
      root: laptop, plan, expected: empty, incoming: cloudM, conflictsDir: join(tmp, 'c'), backup: new BackupStore(join(tmp, 'b')), policy: 'conflict', maxBytes: 1 << 30,
    });
    expect(res.refused.map((r) => r.path)).toContain('evil-link');
    expect(existsSync(join(laptop, 'evil-link'))).toBe(false);
    expect(res.conflicts.map((c) => c.path)).toContain('sub/file.txt');
    expect(existsSync(join(outside, 'file.txt'))).toBe(false);
    expect(lstatSync(join(laptop, 'sub')).isSymbolicLink()).toBe(true);
  });

  it('a pack record that does not match the sender manifest is refused', async () => {
    put(cloud, 'a.txt', 'real');
    const cloudM = await manifestOf(cloud);
    const lie = new Map(cloudM);
    lie.set('a.txt', { ...cloudM.get('a.txt')!, sha256: 'f'.repeat(64) });
    const plan = planMirror(new Map(), lie);
    const pack = await packOf(cloud, cloudM, ['a.txt']);
    const res = await applyPack(() => createReadStream(pack), {
      root: laptop, plan, expected: new Map(), incoming: lie, conflictsDir: join(tmp, 'c'), backup: new BackupStore(join(tmp, 'b')), policy: 'overwrite', maxBytes: 1 << 30,
    });
    expect(res.refused.map((r) => r.reason)).toContain('pack record does not match the sender manifest');
    expect(existsSync(join(laptop, 'a.txt'))).toBe(false);
  });

  it('mirror (cloud at go) overwrites drift and deletes what the sender no longer has', async () => {
    put(cloud, 'a.txt', 'laptop truth');
    put(laptop, 'a.txt', 'stale mirror');
    put(laptop, 'old.txt', 'left over');
    const senderM = await manifestOf(cloud);
    const receiverM = await manifestOf(laptop);
    const plan = planMirror(receiverM, senderM);
    const pack = await packOf(cloud, senderM, plan.write);
    await applyPack(() => createReadStream(pack), {
      root: laptop, plan, expected: receiverM, incoming: senderM, conflictsDir: join(tmp, 'c'), backup: new BackupStore(join(tmp, 'b')), policy: 'overwrite', maxBytes: 1 << 30,
    });
    expect(read(laptop, 'a.txt')).toBe('laptop truth');
    expect(existsSync(join(laptop, 'old.txt'))).toBe(false);
  });
});

describe('D16: the secret class comes home, the cloud wins', () => {
  it('cloud-changed and both-changed secrets are applied with backups; secrets ABSENT in the cloud (wiped) never delete the laptop copy; .secrets.json stays refused; the result names paths only', async () => {
    put(laptop, '.env', 'A=1\n');
    put(laptop, 'functions/.env.local', 'B=1\n');
    put(laptop, 'certs/server.pem', 'PEM-1\n');
    put(laptop, '.npmrc', 'token=old\n');
    put(laptop, '_dream_context/state/.secrets.json', '{"github":"laptop"}');
    const start = await manifestOf(laptop);
    cpSync(laptop, cloud, { recursive: true });

    put(cloud, '.env', 'A=cloud\n'); // cloud-changed only
    put(cloud, 'functions/.env.local', 'B=cloud\n'); // changed on both sides
    put(laptop, 'functions/.env.local', 'B=laptop\n');
    rmSync(join(cloud, 'certs/server.pem')); // absent in the cloud (wiped), laptop modified
    put(laptop, 'certs/server.pem', 'PEM-laptop\n');
    rmSync(join(cloud, '.npmrc')); // absent in the cloud (wiped), laptop unchanged
    put(cloud, '_dream_context/state/.secrets.json', '{"github":"cloud"}');

    const laptopNow = await manifestOf(laptop);
    const cloudM = await manifestOf(cloud);
    const plan = planNonGitReturn(start, laptopNow, cloudM, []);
    expect(plan.write.sort()).toEqual(['.env', 'functions/.env.local']);
    expect(plan.delete).toEqual([]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.cloudWins!.sort()).toEqual(['.env', 'functions/.env.local']);
    expect(plan.notReturned!.sort()).toEqual(['.npmrc', 'certs/server.pem']);
    expect(plan.refused.map((r) => r.path)).toEqual(['_dream_context/state/.secrets.json']);

    const pack = await packOf(cloud, cloudM, [...plan.write, '_dream_context/state/.secrets.json']);
    const ctx = {
      root: laptop, plan, expected: laptopNow, incoming: cloudM,
      conflictsDir: join(tmp, 'trips/t1/conflicts/r1'), backup: new BackupStore(join(tmp, 'trips/t1/backup/r1')),
      policy: 'conflict' as const, maxBytes: 1 << 30,
    };
    const res = await applyPack(() => createReadStream(pack), ctx);
    expect(read(laptop, '.env')).toBe('A=cloud\n');
    expect(read(laptop, 'functions/.env.local')).toBe('B=cloud\n');
    expect(read(laptop, 'certs/server.pem')).toBe('PEM-laptop\n'); // untouched
    expect(read(laptop, '.npmrc')).toBe('token=old\n'); // untouched
    expect(read(laptop, '_dream_context/state/.secrets.json')).toBe('{"github":"laptop"}');
    expect(res.deleted).toEqual([]);
    expect(res.conflicts).toEqual([]);
    expect(existsSync(ctx.conflictsDir)).toBe(false);
    // Receipt data: names only, never contents or diffs.
    expect(res.secrets.sort()).toEqual(['.env', 'functions/.env.local']);
    expect(res.notReturned.sort()).toEqual(['.npmrc', 'certs/server.pem']);
    const receiptText = JSON.stringify(res);
    for (const secret of ['A=cloud', 'B=cloud', 'B=laptop', 'PEM-laptop', 'PEM-1', 'A=1', 'token=old', '"github"']) {
      expect(receiptText).not.toContain(secret);
    }
    // The laptop copies went to backup/ before the overwrite; nothing else was backed up.
    expect(read(ctx.backup.filesDir, 'functions/.env.local')).toBe('B=laptop\n');
    expect(read(ctx.backup.filesDir, '.env')).toBe('A=1\n');
    expect(existsSync(join(ctx.backup.filesDir, 'certs'))).toBe(false);

    // A replay reports the same names.
    const again = await applyPack(() => createReadStream(pack), ctx);
    expect(again.secrets.sort()).toEqual(['.env', 'functions/.env.local']);
    expect(again.notReturned.sort()).toEqual(['.npmrc', 'certs/server.pem']);

    // Roll back restores every laptop copy.
    ctx.backup.restore(laptop);
    expect(read(laptop, '.env')).toBe('A=1\n');
    expect(read(laptop, 'functions/.env.local')).toBe('B=laptop\n');
    expect(read(laptop, 'certs/server.pem')).toBe('PEM-laptop\n');
  });

  it('a delta return after the cloud wiped every secret deletes nothing on the laptop', async () => {
    put(laptop, '.env', 'A=1\n');
    put(laptop, 'keys/app.key', 'K\n');
    const start = await manifestOf(laptop);
    put(laptop, '.env', 'A=laptop-edit\n');
    mkdirSync(cloud); // wiped: no secret-class file left in the cloud
    const plan = planNonGitReturn(start, await manifestOf(laptop), await manifestOf(cloud), []);
    expect(plan.write).toEqual([]);
    expect(plan.delete).toEqual([]);
    expect(plan.notReturned!.sort()).toEqual(['.env', 'keys/app.key']);
  });

  it('a hostile plan that lists a secret deletion as cloud-wins still cannot delete a laptop-modified copy', async () => {
    put(laptop, '.env', 'A=laptop\n');
    const expected = await manifestOf(laptop);
    put(laptop, '.env', 'A=edited after plan\n');
    mkdirSync(cloud);
    const pack = await packOf(cloud, new Map(), []);
    const res = await applyPack(() => createReadStream(pack), {
      root: laptop, plan: { write: [], delete: ['.env'], conflicts: [], refused: [], cloudWins: ['.env'] },
      expected, incoming: new Map(), conflictsDir: join(tmp, 'c'), backup: new BackupStore(join(tmp, 'b')), policy: 'conflict', maxBytes: 1 << 30,
    });
    expect(read(laptop, '.env')).toBe('A=edited after plan\n');
    expect(res.deleted).toEqual([]);
  });

  it('dreamcontext credential files are refused by the plan and by the apply even if a hostile plan lists them', async () => {
    put(cloud, '_dream_context/lab/credentials.json', '{"k":"cloud"}');
    const cloudM = await manifestOf(cloud);
    const plan = planNonGitReturn(new Map(), new Map(), cloudM, []);
    expect(plan.write).toEqual([]);
    expect(plan.refused.map((r) => r.path)).toEqual(['_dream_context/lab/credentials.json']);
    const hostile = { write: ['_dream_context/lab/credentials.json'], delete: [], conflicts: [], refused: [], cloudWins: ['_dream_context/lab/credentials.json'] };
    const pack = await packOf(cloud, cloudM, hostile.write);
    const res = await applyPack(() => createReadStream(pack), {
      root: laptop, plan: hostile, expected: new Map(), incoming: cloudM, conflictsDir: join(tmp, 'c'), backup: new BackupStore(join(tmp, 'b')), policy: 'conflict', maxBytes: 1 << 30,
    });
    expect(res.written).toEqual([]);
    expect(res.refused.map((r) => r.path)).toContain('_dream_context/lab/credentials.json');
    expect(existsSync(join(laptop, '_dream_context'))).toBe(false);
  });
});

describe('symlink chains (AC9, shared sweep)', () => {
  const mirrorApply = async (expected: Manifest, policy: 'conflict' | 'overwrite' = 'conflict') => {
    const cloudM = await hostileManifestOf(cloud);
    const plan = planMirror(expected, cloudM);
    const pack = await packOf(cloud, cloudM, plan.write);
    const backup = new BackupStore(join(tmp, 'bk'));
    const res = await applyPack(() => createReadStream(pack), {
      root: laptop, plan, expected, incoming: cloudM, conflictsDir: join(tmp, 'cf'), backup, policy, maxBytes: 1 << 30,
    });
    return res;
  };
  const exists = (rel: string) => { try { lstatSync(join(laptop, rel)); return true; } catch { return false; } };

  it('d/l1 -> .. and d/l2 -> l1/..: both refused at write time by the canonical rule (D18), nothing behind', async () => {
    mkdirSync(join(cloud, 'd'), { recursive: true });
    symlinkSync('..', join(cloud, 'd', 'l1'));
    symlinkSync('l1/..', join(cloud, 'd', 'l2'));
    const res = await mirrorApply(new Map());
    expect(res.refused.map((r) => r.path).sort()).toEqual(['d/l1', 'd/l2']);
    expect(res.written).toEqual([]);
    expect(exists('d/l1')).toBe(false);
    expect(exists('d/l2')).toBe(false);
  });

  it('the two-call repro (d/l -> sub/../.., then d/sub -> ..) is refused at write time in both calls', async () => {
    mkdirSync(join(cloud, 'd'), { recursive: true });
    symlinkSync('sub/../..', join(cloud, 'd', 'l'));
    const first = await mirrorApply(new Map());
    expect(first.refused.map((r) => r.path)).toEqual(['d/l']);
    rmSync(join(cloud, 'd', 'l'));
    symlinkSync('..', join(cloud, 'd', 'sub'));
    const second = await mirrorApply(await manifestOf(laptop));
    expect(second.refused.map((r) => r.path)).toEqual(['d/sub']);
    expect(exists('d/l')).toBe(false);
    expect(exists('d/sub')).toBe(false);
  });

  it('a canonical link through an existing escaping laptop symlink is undone; an overwritten laptop file comes back from backup', async () => {
    mkdirSync(join(laptop, 'd'));
    symlinkSync('../..', join(laptop, 'd', 'lap')); // the laptop's own link, already outside
    put(laptop, 'd/x', 'laptop original');
    mkdirSync(join(cloud, 'd'), { recursive: true });
    // (the laptop's lap stays on the laptop under D19, so the cloud never had it)
    symlinkSync('lap', join(cloud, 'd', 'x'));
    symlinkSync('lap', join(cloud, 'd', 'y'));
    const res = await mirrorApply(await manifestOf(laptop), 'overwrite');
    expect(res.refused).toEqual([
      { path: 'd/x', reason: 'symlink resolves outside the root' },
      { path: 'd/y', reason: 'symlink resolves outside the root' },
    ]);
    expect(lstatSync(join(laptop, 'd', 'x')).isFile()).toBe(true);
    expect(read(laptop, 'd/x')).toBe('laptop original');
    expect(exists('d/y')).toBe(false);
    expect(readlinkSync(join(laptop, 'd', 'lap'))).toBe('../..'); // never touched
  });

});

describe('round-2 repros: no throw skips the sweep', () => {
  it('an over-long target and two non-canonical links are refused without aborting the apply', async () => {
    const mk = (path: string, linkTarget: string) => ({
      path, type: 'symlink' as const, size: Buffer.byteLength(linkTarget), mode: 0o120777, mtimeMs: 0,
      sha256: createHash('sha256').update(linkTarget).digest('hex'), linkTarget,
    });
    const incoming: Manifest = new Map([
      ['d/l1', mk('d/l1', '..')], ['d/l2', mk('d/l2', 'l1/..')], ['z', mk('z', 'a'.repeat(4096))], ['ok', mk('ok', 'target')],
    ]);
    mkdirSync(cloud);
    const p = join(tmp, 'long.pack');
    await writePack(createWriteStream(p), { root: cloud, entries: incoming.values() });
    const plan = planMirror(new Map(), incoming);
    const res = await applyPack(() => createReadStream(p), {
      root: laptop, plan, expected: new Map(), incoming, conflictsDir: join(tmp, 'c'), backup: new BackupStore(join(tmp, 'b')), policy: 'conflict', maxBytes: 1 << 30,
    });
    expect(res.refused.map((r) => r.path).sort()).toEqual(['d/l1', 'd/l2', 'z']);
    expect(res.written).toEqual(['ok']);
    expect(readdirSync(laptop).sort()).toEqual(['ok']);
  });

  it('a file x plus a link x/y over a laptop dir x/y/ keeps both cloud copies and never throws', async () => {
    put(laptop, 'x/y/inner.txt', 'laptop');
    put(cloud, 'x', 'cloud file x');
    const laptopM = await manifestOf(laptop);
    const cloudM = await manifestOf(cloud);
    cloudM.set('x/y', { path: 'x/y', type: 'symlink', size: 1, mode: 0o120777, mtimeMs: 0, sha256: createHash('sha256').update('q').digest('hex'), linkTarget: 'q' });
    const plan = { write: ['x', 'x/y'], delete: [], conflicts: [], refused: [] };
    const p = join(tmp, 'xy.pack');
    await writePack(createWriteStream(p), { root: cloud, entries: cloudM.values() });
    const cf = join(tmp, 'cf');
    const res = await applyPack(() => createReadStream(p), {
      root: laptop, plan, expected: laptopM, incoming: cloudM, conflictsDir: cf, backup: new BackupStore(join(tmp, 'b')), policy: 'conflict', maxBytes: 1 << 30,
    });
    expect(res.conflicts.map((c) => c.path).sort()).toEqual(['x', 'x/y']);
    expect(read(laptop, 'x/y/inner.txt')).toBe('laptop');
    expect(readdirSync(cf).sort()).toEqual(['x', 'x%2Fy']);
    expect(read(cf, 'x')).toBe('cloud file x');
    expect(read(cf, 'x%2Fy')).toBe('q');
  });
});

describe('D18 whole-root re-sweep', () => {
  const linkWithLedger = (store: BackupStore, rel: string, target: string) => {
    mkdirSync(join(laptop, rel, '..'), { recursive: true });
    store.recordCreate(rel, { sha256: createHash('sha256').update(target).digest('hex') });
    symlinkSync(target, join(laptop, rel));
  };

  it('a chain written by two transports is caught; the newest link of this Return on it is undone first', async () => {
    const files = new BackupStore(join(tmp, 'trips/t1/backup/r-files'));
    const gitStore = new BackupStore(join(tmp, 'trips/t1/backup/git-c1'));
    linkWithLedger(files, 'd/l1', '..'); // planted (bypasses the write-time rule) by "transport A"
    await new Promise((r) => setTimeout(r, 5));
    linkWithLedger(gitStore, 'd/l2', 'l1/..'); // newer, by "transport B": escapes via l1
    const r = resweepRootWithBackups(laptop, ['d/l1', 'd/l2'], [files, gitStore]);
    expect(r).toEqual({ undone: ['d/l2'], escaping: [] });
    expect(readlinkSync(join(laptop, 'd', 'l1'))).toBe('..');
    expect(readdirSync(join(laptop, 'd'))).toEqual(['l1']);
  });

  it('a pre-existing escaping laptop link is only reported, never touched; this Return\'s link through it is undone', async () => {
    symlinkSync('../outside', join(laptop, 'ext')); // the laptop's own, predates the trip
    const store = new BackupStore(join(tmp, 'trips/t1/backup/r1'));
    linkWithLedger(store, 'd/x', '../ext');
    const r = resweepRootWithBackups(laptop, ['ext', 'd/x'], [store]);
    expect(r.undone).toEqual(['d/x']);
    expect(r.escaping).toEqual(['ext']);
    expect(readlinkSync(join(laptop, 'ext'))).toBe('../outside');
    const alone = resweepRootWithBackups(laptop, ['ext'], [new BackupStore(join(tmp, 'trips/t1/backup/none'))]);
    expect(alone).toEqual({ undone: [], escaping: ['ext'] });
  });
});

describe('backups are per attempt (Roll back, retry, Roll back)', () => {
  it('the second Roll back restores the laptop state at the second attempt, not the first', async () => {
    put(laptop, '.env', 'v0');
    put(cloud, '.env', 'c1');
    put(cloud, 'new.md', 'cloud new');
    const dir = join(tmp, 'trips/t1/backup/r1');
    const attempt = async () => {
      const expected = await manifestOf(laptop);
      const incoming = await manifestOf(cloud);
      const plan = planMirror(expected, incoming);
      plan.delete = [];
      const pk = await packOf(cloud, incoming, plan.write);
      const backup = new BackupStore(dir);
      await applyPack(() => createReadStream(pk), {
        root: laptop, plan, expected, incoming, conflictsDir: join(tmp, 'cf'), backup, policy: 'overwrite', maxBytes: 1 << 30,
      });
      return backup;
    };
    (await attempt()).restore(laptop);
    expect(read(laptop, '.env')).toBe('v0');
    expect(existsSync(join(laptop, 'new.md'))).toBe(false);
    put(laptop, '.env', 'v1'); // the user edits after Roll back
    put(laptop, 'new.md', 'mine'); // and creates a file the first attempt had created
    const second = await attempt();
    expect(read(laptop, '.env')).toBe('c1');
    second.restore(laptop);
    expect(read(laptop, '.env')).toBe('v1');
    expect(read(laptop, 'new.md')).toBe('mine');
    const kept = readdirSync(join(tmp, 'trips/t1/backup')).filter((n) => n.startsWith('r1.attempt-'));
    expect(kept).toHaveLength(2); // earlier attempts are never deleted
  });
});

describe('D19: links that cannot travel stay on the laptop', () => {
  it('after go + Return with no cloud edits, the laptop\'s /abs and a/../b links still exist and are reported', async () => {
    put(laptop, '_dream_context/lab/note.md', 'n');
    mkdirSync(join(laptop, '_dream_context/lab/.venv/bin'), { recursive: true });
    symlinkSync('/usr/bin/python3', join(laptop, '_dream_context/lab/.venv/bin/python3'));
    symlinkSync('sub/../note.md', join(laptop, '_dream_context/lab/alias.md'));
    symlinkSync('./note.md', join(laptop, '_dream_context/lab/dot.md')); // D19: `.` is fine, travels
    const w = walk(laptop, [''], { side: 'laptop' });
    expect(w.refused).toEqual([
      { path: '_dream_context/lab/.venv/bin/python3', reason: 'stays on the laptop' },
      { path: '_dream_context/lab/alias.md', reason: 'stays on the laptop' },
    ]);
    // go: mirror to the cloud
    const start = await buildManifest(laptop, w.entries);
    expect([...start.keys()].sort()).toEqual(['_dream_context/lab/dot.md', '_dream_context/lab/note.md']);
    mkdirSync(cloud);
    const goPack = await packOf(laptop, start, [...start.keys()]);
    await applyPack(() => createReadStream(goPack), {
      root: cloud, plan: planMirror(new Map(), start), expected: new Map(), incoming: start,
      conflictsDir: join(tmp, 'gcf'), backup: new BackupStore(join(tmp, 'gbk')), policy: 'overwrite', maxBytes: 1 << 30,
    });
    expect(readlinkSync(join(cloud, '_dream_context/lab/dot.md'))).toBe('./note.md');
    // Return with no cloud edits
    const cloudM = await manifestOf(cloud);
    const laptopNow = await manifestOf(laptop);
    const plan = planNonGitReturn(start, laptopNow, cloudM, []);
    expect(plan).toMatchObject({ write: [], delete: [], conflicts: [] });
    const pk = await packOf(cloud, cloudM, []);
    const res = await applyPack(() => createReadStream(pk), {
      root: laptop, plan, expected: laptopNow, incoming: cloudM, conflictsDir: join(tmp, 'cf'), backup: new BackupStore(join(tmp, 'bk')), policy: 'conflict', maxBytes: 1 << 30,
    });
    expect(res.deleted).toEqual([]);
    expect(readlinkSync(join(laptop, '_dream_context/lab/.venv/bin/python3'))).toBe('/usr/bin/python3');
    expect(readlinkSync(join(laptop, '_dream_context/lab/alias.md'))).toBe('sub/../note.md');
    expect(readlinkSync(join(laptop, '_dream_context/lab/dot.md'))).toBe('./note.md');
  });
});

describe('D19 amended: the stays-home exclusion is laptop-side only; a cloud-side gap never deletes', () => {
  const setupSkill = () => {
    // Laptop: node_modules/pkg is a real dir; .claude/skill points into it (canonical, inside).
    put(laptop, 'node_modules/pkg/skill/SKILL.md', 'skill');
    mkdirSync(join(laptop, '.claude'), { recursive: true });
    symlinkSync('../node_modules/pkg/skill', join(laptop, '.claude', 'skill'));
    // Cloud: the install made node_modules/pkg an ABSOLUTE link; .claude/skill untouched.
    mkdirSync(join(cloud, 'node_modules'), { recursive: true });
    symlinkSync(join(tmp, 'elsewhere', 'pkg'), join(cloud, 'node_modules', 'pkg'));
    mkdirSync(join(cloud, '.claude'), { recursive: true });
    symlinkSync('../node_modules/pkg/skill', join(cloud, '.claude', 'skill'));
  };
  const returnApply = async (plan: ReturnType<typeof planNonGitReturn>, laptopNow: Manifest, cloudM: Manifest) => {
    const pk = await packOf(cloud, cloudM, plan.write);
    return applyPack(() => createReadStream(pk), {
      root: laptop, plan, expected: laptopNow, incoming: cloudM, conflictsDir: join(tmp, 'cf'), backup: new BackupStore(join(tmp, 'bk')), policy: 'conflict', maxBytes: 1 << 30,
    });
  };

  it('case A: an untouched link the cloud could not resolve stays included on the cloud side: no delete, laptop link unchanged', async () => {
    setupSkill();
    const start = await buildManifest(laptop, walk(laptop, ['.claude'], { side: 'laptop' }).entries);
    expect([...start.keys()]).toEqual(['.claude/skill']);
    // The bug: laptop-side rules applied on the cloud left the link out.
    expect(walk(cloud, ['.claude'], { side: 'laptop' }).refused).toEqual([{ path: '.claude/skill', reason: 'stays on the laptop' }]);
    const cw = walk(cloud, ['.claude'], { side: 'cloud' });
    expect(cw.refused).toEqual([]);
    const cloudM = await buildManifest(cloud, cw.entries);
    const laptopNow = await buildManifest(laptop, walk(laptop, ['.claude'], { side: 'laptop' }).entries);
    const plan = planNonGitReturn(start, laptopNow, cloudM, cw.refused.map((r) => r.path));
    expect(plan).toMatchObject({ write: [], delete: [], conflicts: [], refused: [] });
    await returnApply(plan, laptopNow, cloudM);
    expect(readlinkSync(join(laptop, '.claude', 'skill'))).toBe('../node_modules/pkg/skill');
  });

  it('belt and braces: a path in the trip-start manifest that the cloud refused to send is never a deletion', async () => {
    setupSkill();
    const start = await buildManifest(laptop, walk(laptop, ['.claude'], { side: 'laptop' }).entries);
    const cw = walk(cloud, ['.claude'], { side: 'laptop' }); // an old/buggy sender that leaves it out
    const cloudM = await buildManifest(cloud, cw.entries);
    const plan = planNonGitReturn(start, start, cloudM, cw.refused.map((r) => r.path));
    expect(plan.delete).toEqual([]);
    expect(plan.refused).toEqual([{ path: '.claude/skill', reason: 'not sent by the cloud; laptop copy kept' }]);
    const res = await returnApply(plan, start, cloudM);
    expect(res.deleted).toEqual([]);
    expect(res.refused.map((r) => r.path)).toEqual(['.claude/skill']);
    expect(readlinkSync(join(laptop, '.claude', 'skill'))).toBe('../node_modules/pkg/skill');
  });

  it('case B: a cloud agent retargets the link to an absolute path: refused, listed, the laptop link unchanged', async () => {
    setupSkill();
    const start = await buildManifest(laptop, walk(laptop, ['.claude'], { side: 'laptop' }).entries);
    rmSync(join(cloud, '.claude', 'skill'));
    symlinkSync('/usr/local/lib/skill', join(cloud, '.claude', 'skill'));
    const cw = walk(cloud, ['.claude'], { side: 'cloud' });
    const cloudM = await buildManifest(cloud, cw.entries);
    expect(cloudM.get('.claude/skill')!.linkTarget).toBe('/usr/local/lib/skill'); // sent, not dropped
    const plan = planNonGitReturn(start, start, cloudM, cw.refused.map((r) => r.path));
    expect(plan).toMatchObject({ write: [], delete: [] });
    expect(plan.refused).toEqual([{ path: '.claude/skill', reason: 'symlink target escapes the root' }]);
    const res = await returnApply(plan, start, cloudM);
    expect(res.refused.map((r) => r.path)).toEqual(['.claude/skill']);
    expect(readlinkSync(join(laptop, '.claude', 'skill'))).toBe('../node_modules/pkg/skill');
    // Even a hostile plan that lists the write is refused by the laptop's apply.
    const pk = await packOf(cloud, cloudM, ['.claude/skill']);
    const hostile = await applyPack(() => createReadStream(pk), {
      root: laptop, plan: { write: ['.claude/skill'], delete: [], conflicts: [], refused: [] }, expected: start, incoming: cloudM,
      conflictsDir: join(tmp, 'cf2'), backup: new BackupStore(join(tmp, 'bk2')), policy: 'conflict', maxBytes: 1 << 30,
    });
    expect(hostile.written).toEqual([]);
    expect(hostile.refused.map((r) => r.path)).toEqual(['.claude/skill']);
    expect(readlinkSync(join(laptop, '.claude', 'skill'))).toBe('../node_modules/pkg/skill');
  });
});

describe('D20: Return never deletes a laptop non-git file', () => {
  const returnApply = async (plan: ReturnType<typeof planNonGitReturn>, laptopNow: Manifest, cloudM: Manifest) => {
    const pk = await packOf(cloud, cloudM, [...plan.write, ...plan.conflicts.map((c) => c.path).filter((p) => cloudM.has(p))]);
    return applyPack(() => createReadStream(pk), {
      root: laptop, plan, expected: laptopNow, incoming: cloudM, conflictsDir: join(tmp, 'cf'), backup: new BackupStore(join(tmp, 'bk')), policy: 'conflict', maxBytes: 1 << 30,
    });
  };

  it('(1) an unreadable cloud dir is refused and listed; nothing under it is deleted on the laptop', async () => {
    put(laptop, 'notes/a.md', 'A');
    put(laptop, 'notes/deep/b.md', 'B');
    const start = await manifestOf(laptop);
    cpSync(laptop, cloud, { recursive: true });
    chmodSync(join(cloud, 'notes'), 0o000);
    try {
      const cw = walk(cloud, [''], { side: 'cloud' });
      expect(cw.refused).toEqual([{ path: 'notes', reason: 'unreadable (EACCES)' }]);
      const cloudM = await buildManifest(cloud, cw.entries);
      const plan = planNonGitReturn(start, start, cloudM, cw.refused.map((r) => r.path));
      expect(plan.delete).toEqual([]);
      expect(plan.refused.map((r) => r.path).sort()).toEqual(['notes/a.md', 'notes/deep/b.md']);
      const res = await returnApply(plan, start, cloudM);
      expect(res.deleted).toEqual([]);
      expect(read(laptop, 'notes/a.md')).toBe('A');
      expect(read(laptop, 'notes/deep/b.md')).toBe('B');
    } finally {
      chmodSync(join(cloud, 'notes'), 0o755);
    }
  });

  it('(1) buildManifest lists an unreadable file instead of dropping it (and throws without a list)', async () => {
    put(cloud, 'x.md', 'secret-ish');
    chmodSync(join(cloud, 'x.md'), 0o000);
    try {
      const w = walk(cloud, [''], { side: 'cloud' });
      const refused: Array<{ path: string; reason: string }> = [];
      const m = await buildManifest(cloud, w.entries, undefined, refused);
      expect(m.has('x.md')).toBe(false);
      expect(refused).toEqual([{ path: 'x.md', reason: 'unreadable (EACCES)' }]);
      await expect(buildManifest(cloud, w.entries)).rejects.toThrow(/EACCES/);
    } finally {
      chmodSync(join(cloud, 'x.md'), 0o644);
    }
  });

  it('(2) a cloud dir replaced by a refused link: link refused, the laptop dir and files kept, deletions listed', async () => {
    put(laptop, 'lib/x.md', 'X');
    put(laptop, 'lib/y.md', 'Y');
    const start = await manifestOf(laptop);
    mkdirSync(cloud);
    symlinkSync('/usr/local/lib', join(cloud, 'lib'));
    const cw = walk(cloud, [''], { side: 'cloud' });
    const cloudM = await buildManifest(cloud, cw.entries);
    const plan = planNonGitReturn(start, start, cloudM, cw.refused.map((r) => r.path));
    expect(plan.refused).toEqual([{ path: 'lib', reason: 'symlink target escapes the root' }]);
    expect(plan.delete).toEqual([]);
    expect(plan.deletedInCloud).toEqual(['lib/x.md', 'lib/y.md']);
    const res = await returnApply(plan, start, cloudM);
    expect(res.deleted).toEqual([]);
    expect(res.deletedInCloud).toEqual(['lib/x.md', 'lib/y.md']);
    expect(lstatSync(join(laptop, 'lib')).isDirectory()).toBe(true);
    expect(read(laptop, 'lib/x.md')).toBe('X');
    expect(read(laptop, 'lib/y.md')).toBe('Y');
  });

  it('(3) D19 over D16: a laptop .env link that stayed home is never overwritten by a cloud .env', async () => {
    symlinkSync('/Users/someone/vault/.env', join(laptop, '.env')); // absolute: stays home under D19
    const lw = walk(laptop, [''], { side: 'laptop' });
    expect(lw.refused).toEqual([{ path: '.env', reason: 'stays on the laptop' }]);
    const start = await buildManifest(laptop, lw.entries);
    put(cloud, '.env', 'FROM_CLOUD=1');
    const cloudM = await manifestOf(cloud);
    const plan = planNonGitReturn(start, start, cloudM, []);
    expect(plan.cloudWins).toEqual(['.env']);
    const res = await returnApply(plan, start, cloudM);
    expect(res.written).toEqual([]);
    expect(res.conflicts).toEqual([{ path: '.env', reason: 'the laptop copy stayed home; cloud copy kept in conflicts' }]);
    expect(readlinkSync(join(laptop, '.env'))).toBe('/Users/someone/vault/.env');
    expect(read(join(tmp, 'cf'), '.env')).toBe('FROM_CLOUD=1');
  });

  it('a plain cloud-deleted file is listed and kept; a hostile plan delete is never executed on the laptop', async () => {
    put(laptop, 'old.md', 'mine');
    const start = await manifestOf(laptop);
    mkdirSync(cloud);
    const cloudM = await manifestOf(cloud);
    const plan = planNonGitReturn(start, start, cloudM, []);
    expect(plan.deletedInCloud).toEqual(['old.md']);
    const res = await returnApply({ ...plan, delete: ['old.md'] }, start, cloudM); // hostile: lists a delete
    expect(res.deleted).toEqual([]);
    expect(res.deletedInCloud).toEqual(['old.md']);
    expect(read(laptop, 'old.md')).toBe('mine');
  });

  it('go still mirrors a laptop deletion into the cloud', async () => {
    put(cloud, 'old.txt', 'stale in the cloud');
    put(laptop, 'kept.txt', 'k');
    const senderM = await manifestOf(laptop);
    const receiverM = await manifestOf(cloud);
    const plan = planMirror(receiverM, senderM);
    expect(plan.delete).toEqual(['old.txt']);
    const pk = await packOf(laptop, senderM, plan.write);
    const res = await applyPack(() => createReadStream(pk), {
      root: cloud, plan, expected: receiverM, incoming: senderM, conflictsDir: join(tmp, 'c'), backup: new BackupStore(join(tmp, 'b')), policy: 'overwrite', maxBytes: 1 << 30,
    });
    expect(res.deleted).toEqual(['old.txt']);
    expect(existsSync(join(cloud, 'old.txt'))).toBe(false);
  });
});

describe('Roll back removes a created file only while it still holds what the Return wrote', () => {
  it('removes an untouched created file; keeps and lists one the owner changed; nothing for one never written', async () => {
    const store = new BackupStore(join(tmp, 'trips/t1/backup/r1'));
    const sha = (x: string) => createHash('sha256').update(x).digest('hex');
    // Written by the Return, untouched since.
    store.recordCreate('a.md', { sha256: sha('cloud a') });
    put(laptop, 'a.md', 'cloud a');
    // Written by the Return, then edited by the owner (e.g. after a crash).
    store.recordCreate('b.md', { sha256: sha('cloud b') });
    put(laptop, 'b.md', 'owner edit');
    // Recorded, then the process died before the rename; the owner created the file later.
    store.recordCreate('c.md', { sha256: sha('cloud c') });
    put(laptop, 'c.md', 'owner own file');
    // Recorded, never written, nothing there.
    store.recordCreate('d.md', { sha256: sha('cloud d') });
    const r = store.restore(laptop);
    expect(r.removed).toEqual(['a.md']);
    expect(r.kept.sort((x, y) => (x.path < y.path ? -1 : 1))).toEqual([
      { path: 'b.md', reason: 'changed since the Return wrote it, kept' },
      { path: 'c.md', reason: 'changed since the Return wrote it, kept' },
    ]);
    expect(existsSync(join(laptop, 'a.md'))).toBe(false);
    expect(read(laptop, 'b.md')).toBe('owner edit');
    expect(read(laptop, 'c.md')).toBe('owner own file');
    expect(existsSync(join(laptop, 'd.md'))).toBe(false);
  });

  it('the git transport records the blob id: Roll back removes its untouched file, keeps an edited one', async () => {
    const store = new BackupStore(join(tmp, 'trips/t1/backup/git-c'));
    const blob = (x: string) => createHash('sha1').update(`blob ${Buffer.byteLength(x)}\0`).update(x).digest('hex');
    store.recordCreate('x.txt', { gitBlob: blob('from git\n'), fmt: 'sha1' });
    put(laptop, 'x.txt', 'from git\n');
    store.recordCreate('y.txt', { gitBlob: blob('from git\n'), fmt: 'sha1' });
    put(laptop, 'y.txt', 'edited\n');
    const r = store.restore(laptop);
    expect(r.removed).toEqual(['x.txt']);
    expect(r.kept.map((k) => k.path)).toEqual(['y.txt']);
    expect(read(laptop, 'y.txt')).toBe('edited\n');
  });
});
