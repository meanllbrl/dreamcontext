import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  handleReleasesUpdate,
  handleReleasesDelete,
  handleActiveVersionGet,
  handleActiveVersionSet,
} from '../../src/server/routes/changelog.js';
import { getExistingReleases } from '../../src/lib/release-discovery.js';
import { getTaskBackend } from '../../src/lib/task-backend/index.js';

/**
 * PATCH (rename) + DELETE /api/releases/:version. Renaming re-points every task
 * carrying the old version string and moves the active-planning pointer;
 * deleting drops the entry and clears the version off its tasks (warn+clear).
 * Both also operate on unregistered "ghosts" (a version present only on tasks).
 * PATCH also DERIVES `contributors` when an entry transitions to `released` —
 * the third describe below covers that half of the handler.
 */

function makeRes(): { res: ServerResponse; status: () => number; body: () => any } {
  let statusCode = 0;
  let responseBody: unknown = null;
  const res = {
    writeHead(code: number) { statusCode = code; },
    end(data: string) {
      try { responseBody = JSON.parse(data); } catch { responseBody = data; }
    },
    setHeader() {},
  } as unknown as ServerResponse;
  return { res, status: () => statusCode, body: () => responseBody as any };
}

function makeReq(method: string, body?: unknown): IncomingMessage {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  return Object.assign(Readable.from(payload), {
    method,
    headers: { 'content-type': 'application/json' },
  }) as unknown as IncomingMessage;
}

let root: string;

function writeReleases(entries: unknown[]): void {
  writeFileSync(join(root, 'core', 'RELEASES.json'), JSON.stringify(entries, null, 2));
}

function rel(version: string, status: 'planning' | 'released' = 'released') {
  return { id: `rel_${version}`, version, date: status === 'released' ? '2026-06-01' : '', summary: '', breaking: false, status, features: [], tasks: [], changelog: [] };
}

function writeTask(slug: string, version: string | null): void {
  const v = version === null ? 'null' : JSON.stringify(version);
  writeFileSync(
    join(root, 'state', `${slug}.md`),
    `---\nid: task_${slug}\nname: ${slug}\nstatus: completed\ncreated_at: '2026-06-01'\nupdated_at: '2026-06-01'\nversion: ${v}\n---\n\nbody\n`,
  );
}

async function taskVersion(slug: string): Promise<string | null> {
  const list = await getTaskBackend(root).list();
  return list.find((t) => t.name === slug)?.version ?? null;
}

beforeEach(() => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  root = join(tmpdir(), `dc-relrename-${stamp}`, '_dream_context');
  mkdirSync(join(root, 'core'), { recursive: true });
  mkdirSync(join(root, 'state'), { recursive: true });
  writeReleases([]);
});

afterEach(() => {
  rmSync(join(root, '..'), { recursive: true, force: true });
});

describe('PATCH /api/releases/:version — rename', () => {
  it('renames a registered entry and re-points its tasks', async () => {
    writeReleases([rel('0.1.0')]);
    writeTask('alpha', '0.1.0');
    writeTask('beta', '0.1.0');
    writeTask('gamma', 'v0.9.2'); // unrelated — must stay put

    const { res, status, body } = makeRes();
    await handleReleasesUpdate(makeReq('PATCH', { version: 'v0.1.0' }), res, { version: '0.1.0' }, root);

    expect(status()).toBe(200);
    expect(body().renamed).toEqual({ from: '0.1.0', to: 'v0.1.0' });
    expect(body().tasksRepointed).toBe(2);

    const releases = getExistingReleases(root);
    expect(releases.find(r => r.version === '0.1.0')).toBeUndefined();
    expect(releases.find(r => r.version === 'v0.1.0')).toBeDefined();

    expect(await taskVersion('alpha')).toBe('v0.1.0');
    expect(await taskVersion('beta')).toBe('v0.1.0');
    expect(await taskVersion('gamma')).toBe('v0.9.2');
  });

  it('renames an unregistered ghost (tasks only, no entry)', async () => {
    writeReleases([]); // no entry for "0.9.2"
    writeTask('one', '0.9.2');
    writeTask('two', '0.9.2');

    const { res, status, body } = makeRes();
    await handleReleasesUpdate(makeReq('PATCH', { version: 'v0.9.2' }), res, { version: '0.9.2' }, root);

    expect(status()).toBe(200);
    expect(body().release).toBeNull();
    expect(body().tasksRepointed).toBe(2);
    expect(await taskVersion('one')).toBe('v0.9.2');
    expect(await taskVersion('two')).toBe('v0.9.2');
  });

  it('rejects a rename that collides with another version (409)', async () => {
    writeReleases([rel('0.1.0'), rel('v0.1.0')]);
    const { res, status, body } = makeRes();
    await handleReleasesUpdate(makeReq('PATCH', { version: 'v0.1.0' }), res, { version: '0.1.0' }, root);
    expect(status()).toBe(409);
    expect(body().error).toBe('already_exists');
  });

  it('moves the active-planning pointer when the active version is renamed', async () => {
    writeReleases([rel('S7', 'planning')]);
    await handleActiveVersionSet(makeReq('PUT', { version: 'S7' }), makeRes().res, {}, root);

    const { res, status } = makeRes();
    await handleReleasesUpdate(makeReq('PATCH', { version: 'Sprint-7' }), res, { version: 'S7' }, root);
    expect(status()).toBe(200);

    const get = makeRes();
    await handleActiveVersionGet(makeReq('GET'), get.res, {}, root);
    expect(get.body()).toEqual({ active: 'Sprint-7' });
  });

  it('still updates status without a rename (back-compat)', async () => {
    writeReleases([rel('S7', 'planning')]);
    const { res, status, body } = makeRes();
    await handleReleasesUpdate(makeReq('PATCH', { status: 'released' }), res, { version: 'S7' }, root);
    expect(status()).toBe(200);
    expect(body().renamed).toBeUndefined();
    expect(getExistingReleases(root).find(r => r.version === 'S7')?.status).toBe('released');
  });
});

/**
 * Releasing a planning entry credits the people behind it, with the same
 * derivation POST /api/releases uses: changelog `authors` ∪ the swept tasks'
 * `person:` tags, deduped and sorted, and the key OMITTED (never `[]`) when
 * there is nothing to attribute (D18).
 */
describe('PATCH /api/releases/:version — contributors on the transition to released', () => {
  function writeTaskWithPerson(slug: string, id: string, person: string): void {
    writeFileSync(
      join(root, 'state', `${slug}.md`),
      `---\nid: ${id}\nname: ${slug}\nstatus: completed\ncreated_at: '2026-06-01'\nupdated_at: '2026-06-01'\nversion: S7\ntags:\n  - person:${person}\n---\n\nbody\n`,
    );
  }

  function planning(extra: Record<string, unknown>) {
    return { ...rel('S7', 'planning'), ...extra };
  }

  it('unions the changelog authors with the swept tasks person: tags', async () => {
    writeTaskWithPerson('ship-it', 'task_A', 'bob-builder');
    writeReleases([planning({ tasks: ['task_A'], changelog: [{ authors: ['ada-lovelace'] }] })]);

    const { res, status, body } = makeRes();
    await handleReleasesUpdate(makeReq('PATCH', { status: 'released' }), res, { version: 'S7' }, root);

    expect(status()).toBe(200);
    expect(body().release.contributors).toEqual(['ada-lovelace', 'bob-builder']);
    expect(getExistingReleases(root).find(r => r.version === 'S7')?.contributors)
      .toEqual(['ada-lovelace', 'bob-builder']);
  });

  it('omits the key entirely when there is nothing to attribute', async () => {
    writeReleases([planning({})]);

    const { res, status, body } = makeRes();
    await handleReleasesUpdate(makeReq('PATCH', { status: 'released' }), res, { version: 'S7' }, root);

    expect(status()).toBe(200);
    expect('contributors' in body().release).toBe(false);
    const onDisk = JSON.parse(readFileSync(join(root, 'core', 'RELEASES.json'), 'utf-8'))[0];
    expect('contributors' in onDisk).toBe(false);
  });

  it('never overwrites a contributors list that is already there', async () => {
    writeTaskWithPerson('ship-it', 'task_A', 'bob-builder');
    writeReleases([planning({
      tasks: ['task_A'],
      changelog: [{ authors: ['ada-lovelace'] }],
      contributors: ['carol-danvers'],
    })]);

    const { res, body } = makeRes();
    await handleReleasesUpdate(makeReq('PATCH', { status: 'released' }), res, { version: 'S7' }, root);

    expect(body().release.contributors).toEqual(['carol-danvers']);
  });
});

describe('DELETE /api/releases/:version', () => {
  it('removes a registered entry and clears the version off its tasks', async () => {
    writeReleases([rel('0.1.0'), rel('v0.9.2')]);
    writeTask('alpha', '0.1.0');
    writeTask('beta', '0.1.0');
    writeTask('keep', 'v0.9.2');

    const { res, status, body } = makeRes();
    await handleReleasesDelete(makeReq('DELETE'), res, { version: '0.1.0' }, root);

    expect(status()).toBe(200);
    expect(body()).toMatchObject({ deleted: true, version: '0.1.0', wasRegistered: true, tasksCleared: 2 });

    expect(getExistingReleases(root).find(r => r.version === '0.1.0')).toBeUndefined();
    expect(await taskVersion('alpha')).toBeNull();
    expect(await taskVersion('beta')).toBeNull();
    expect(await taskVersion('keep')).toBe('v0.9.2');
  });

  it('clears the tasks of an unregistered ghost (wasRegistered false)', async () => {
    writeReleases([]);
    writeTask('g1', '0.9.2');

    const { res, status, body } = makeRes();
    await handleReleasesDelete(makeReq('DELETE'), res, { version: '0.9.2' }, root);

    expect(status()).toBe(200);
    expect(body()).toMatchObject({ wasRegistered: false, tasksCleared: 1 });
    expect(await taskVersion('g1')).toBeNull();
  });

  it('clears the active-planning pointer when the active version is deleted', async () => {
    writeReleases([rel('S7', 'planning')]);
    await handleActiveVersionSet(makeReq('PUT', { version: 'S7' }), makeRes().res, {}, root);

    await handleReleasesDelete(makeReq('DELETE'), makeRes().res, { version: 'S7' }, root);

    const get = makeRes();
    await handleActiveVersionGet(makeReq('GET'), get.res, {}, root);
    expect(get.body()).toEqual({ active: null });
  });

  it('returns 404 when nothing references the version', async () => {
    writeReleases([rel('v0.1.0')]);
    const { res, status, body } = makeRes();
    await handleReleasesDelete(makeReq('DELETE'), res, { version: 'does-not-exist' }, root);
    expect(status()).toBe(404);
    expect(body().error).toBe('not_found');
  });
});
