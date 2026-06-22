import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleTasksMembers } from '../../src/server/routes/tasks.js';
import { writeSetupConfig } from '../../src/lib/setup-config.js';
import type { RemoteMember } from '../../src/lib/task-backend/index.js';
import { SyncLedger } from '../../src/lib/task-backend/index.js';

/**
 * GET /api/tasks/members on a LOCAL project must surface the roster (config
 * `people`) as assignee candidates — that's what fills the dashboard people
 * dropdown so a user never has to type `person:<slug>` by hand.
 */

function makeRes(): { res: ServerResponse; status: () => number; body: () => { members: RemoteMember[] } } {
  let statusCode = 0;
  let responseBody: unknown = null;
  const res = {
    writeHead(code: number) { statusCode = code; },
    end(data: string) { try { responseBody = JSON.parse(data); } catch { responseBody = data; } },
    setHeader() {},
  } as unknown as ServerResponse;
  return { res, status: () => statusCode, body: () => responseBody as { members: RemoteMember[] } };
}

const req = { method: 'GET', headers: {} } as unknown as IncomingMessage;

let tmpDir: string;
let contextRoot: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `members-rt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  contextRoot = join(tmpDir, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('GET /api/tasks/members (roster fallback)', () => {
  it('returns the project roster as members on a local project', async () => {
    writeSetupConfig(tmpDir, {
      platforms: ['claude'],
      packs: [],
      multiProduct: false,
      setupVersion: '1',
      disableNativeMemory: false,
      people: ['mehmet-nuraydin', 'ada-lovelace'],
    } as never);

    const { res, status, body } = makeRes();
    await handleTasksMembers(req, res, {}, contextRoot);

    expect(status()).toBe(200);
    const slugs = body().members.map((m) => m.slug).sort();
    expect(slugs).toEqual(['ada-lovelace', 'mehmet-nuraydin']);
    // Slugs are title-cased for display so the dropdown reads naturally.
    const ada = body().members.find((m) => m.slug === 'ada-lovelace');
    expect(ada?.name).toBe('Ada Lovelace');
  });

  it('returns an empty member list when there is no roster and no tasks', async () => {
    const { res, status, body } = makeRes();
    await handleTasksMembers(req, res, {}, contextRoot);
    expect(status()).toBe(200);
    expect(body().members).toEqual([]);
  });

  it('surfaces people already assigned via person:<slug> tags when cloud sync is off', async () => {
    // No roster, no remote backend — assignment lives purely in local task tags.
    // The picker must still offer those people, otherwise assigning feels disabled.
    writeFileSync(
      join(contextRoot, 'state', 'ship-it.md'),
      [
        '---',
        'id: task_abc123',
        'name: Ship it',
        'status: in_progress',
        'priority: high',
        'urgency: medium',
        'tags:',
        '  - backend',
        '  - person:grace-hopper',
        '  - person:alan-turing',
        '---',
        '',
        '## Notes',
        '',
      ].join('\n'),
    );

    const { res, status, body } = makeRes();
    await handleTasksMembers(req, res, {}, contextRoot);

    expect(status()).toBe(200);
    const slugs = body().members.map((m) => m.slug).sort();
    expect(slugs).toEqual(['alan-turing', 'grace-hopper']);
    const grace = body().members.find((m) => m.slug === 'grace-hopper');
    expect(grace?.name).toBe('Grace Hopper');
  });
});

describe('GET /api/tasks/members (remote backend gates non-members)', () => {
  // No real ClickUp token anywhere → listMembers() falls back to the cached
  // member set (which we seed below) instead of hitting the network.
  beforeEach(() => {
    delete process.env.CLICKUP_TOKEN;
    delete process.env.CLICKUP_API_KEY;
  });

  it('drops roster/task-derived stubs that match no real member, keeping only member-backed candidates', async () => {
    // Remote (ClickUp) backend configured. The roster contains a non-member
    // ("emrecan") AND a real member ("aylin-yilmaz"); a task already carries an
    // unmappable person:bektas tag. Only the real, member-backed slug may be
    // offered — picking a stub would mint an unmappable assignee.
    writeSetupConfig(tmpDir, {
      platforms: ['claude'],
      packs: [],
      multiProduct: false,
      setupVersion: '1',
      disableNativeMemory: false,
      taskBackend: 'clickup',
      clickup: { teamId: 't', spaceId: 's', listId: 'list1' },
      people: ['emrecan', 'aylin-yilmaz'],
    } as never);

    writeFileSync(
      join(contextRoot, 'state', 'handoff.md'),
      [
        '---',
        'id: task_xyz',
        'name: Handoff',
        'status: todo',
        'priority: medium',
        'urgency: medium',
        'tags:',
        '  - person:bektas',
        '---',
        '',
        '## Notes',
        '',
      ].join('\n'),
    );

    // Seed the cached member roster (real remote ids) — listMembers() returns
    // this when the live refresh fails (no token → no network).
    const ledger = new SyncLedger(contextRoot);
    ledger.writeMembers({
      'aylin-yilmaz': { id: '102', name: 'Aylin Yilmaz' },
      'alper-caymaz': { id: '105', name: 'Alper Caymaz' },
    });

    const { res, status, body } = makeRes();
    await handleTasksMembers(req, res, {}, contextRoot);

    expect(status()).toBe(200);
    const members = body().members;
    // Only the two real members survive; emrecan (roster stub) and bektas
    // (task-derived stub) are filtered out.
    expect(members.map((m) => m.slug).sort()).toEqual(['alper-caymaz', 'aylin-yilmaz']);
    // And every offered candidate carries a real remote id.
    expect(members.every((m) => m.id !== '')).toBe(true);
  });
});
