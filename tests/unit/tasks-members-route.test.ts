import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleTasksMembers } from '../../src/server/routes/tasks.js';
import { writeSetupConfig } from '../../src/lib/setup-config.js';
import type { RemoteMember } from '../../src/lib/task-backend/index.js';

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
