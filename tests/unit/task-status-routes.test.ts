import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import matter from 'gray-matter';

import {
  handleTaskOverrides,
  handleTaskOverrideAddStatus,
  handleTaskOverrideRemoveStatus,
  handleTasksUpdate,
  handleTasksCreate,
} from '../../src/server/routes/tasks.js';

/**
 * Dashboard routes for declared statuses (task_adYgpCxk): the override payload
 * carries the effective set, POST adds/edits one, DELETE is blocked at 409
 * while tasks still carry the status and at 400 for a shipped key, and the task
 * PATCH accepts a declared status.
 */

function makeRes(): { res: ServerResponse; status: () => number; body: () => any } {
  let statusCode = 0;
  let responseBody: unknown = null;
  const res = {
    writeHead(code: number) { statusCode = code; },
    end(data: string) { try { responseBody = JSON.parse(data); } catch { responseBody = data; } },
    setHeader() {},
  } as unknown as ServerResponse;
  return { res, status: () => statusCode, body: () => responseBody };
}

function jsonReq(method: string, body: unknown): IncomingMessage {
  const stream = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  (stream as { method?: string }).method = method;
  (stream as { headers?: Record<string, string> }).headers = { 'content-type': 'application/json' };
  return stream;
}

const getReq = { method: 'GET', headers: {} } as unknown as IncomingMessage;
const delReq = { method: 'DELETE', headers: {} } as unknown as IncomingMessage;

let projectRoot: string;
let contextRoot: string;

beforeEach(() => {
  const raw = join(tmpdir(), `st-rt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('/api/task-overrides statuses', () => {
  it('GET carries the shipped four + locked keys when no override exists', async () => {
    const { res, status, body } = makeRes();
    await handleTaskOverrides(getReq, res, {}, contextRoot);
    expect(status()).toBe(200);
    expect(body().statuses.map((s: { key: string }) => s.key)).toEqual(['todo', 'in_progress', 'in_review', 'completed']);
    expect(body().shippedStatusKeys).toEqual(['todo', 'in_progress', 'in_review', 'completed']);
  });

  it('POST adds a status (explicit key written), rejects a bad kind / done-kind / shipped re-kind', async () => {
    let r = makeRes();
    await handleTaskOverrideAddStatus(jsonReq('POST', { name: 'Cancelled', kind: 'cancelled', order: 99, color: '#CFD3D7', remoteAliases: ['cancelled'] }), r.res, {}, contextRoot);
    expect(r.status()).toBe(200);
    expect(r.body().statuses.find((s: { key: string }) => s.key === 'cancelled')).toMatchObject({ kind: 'cancelled', color: 'cfd3d7', clickup: ['cancelled'] });
    const fm = matter(readFileSync(join(contextRoot, 'overrides', 'task.md'), 'utf-8')).data as { statuses: Array<Record<string, unknown>> };
    expect(fm.statuses[0].key).toBe('cancelled');

    r = makeRes();
    await handleTaskOverrideAddStatus(jsonReq('POST', { name: 'Odd', kind: 'weird' }), r.res, {}, contextRoot);
    expect(r.status()).toBe(400);
    expect(r.body().error).toBe('invalid_kind');

    r = makeRes();
    await handleTaskOverrideAddStatus(jsonReq('POST', { name: 'Shipped', kind: 'done' }), r.res, {}, contextRoot);
    expect(r.status()).toBe(400);

    r = makeRes();
    await handleTaskOverrideAddStatus(jsonReq('POST', { name: 'Completed', key: 'completed', kind: 'cancelled' }), r.res, {}, contextRoot);
    expect(r.status()).toBe(400);

    // Relabel / recolour a shipped key without a kind is fine.
    r = makeRes();
    await handleTaskOverrideAddStatus(jsonReq('POST', { name: 'QA', key: 'in_review', color: '112233' }), r.res, {}, contextRoot);
    expect(r.status()).toBe(200);
    expect(r.body().statuses.find((s: { key: string }) => s.key === 'in_review')).toMatchObject({ label: 'QA', kind: 'review', color: '112233' });
  });

  it('DELETE: 400 for a shipped key, 409 with the in-use count while tasks carry the status, 200 once none do', async () => {
    let r = makeRes();
    await handleTaskOverrideAddStatus(jsonReq('POST', { name: 'Cancelled', kind: 'cancelled', order: 99 }), r.res, {}, contextRoot);
    expect(r.status()).toBe(200);

    r = makeRes();
    await handleTaskOverrideRemoveStatus(delReq, r.res, { key: 'completed' }, contextRoot);
    expect(r.status()).toBe(400);
    expect(r.body().error).toBe('shipped_status');

    // Two tasks carry it.
    for (const slug of ['a', 'b']) {
      writeFileSync(join(contextRoot, 'state', `${slug}.md`), `---\nname: ${slug}\nstatus: cancelled\n---\n## Why\nx\n`, 'utf-8');
    }
    r = makeRes();
    await handleTaskOverrideRemoveStatus(delReq, r.res, { key: 'cancelled' }, contextRoot);
    expect(r.status()).toBe(409);
    expect(r.body().error).toBe('status_in_use');
    expect(r.body().message).toContain('2 task(s)');

    // Move them off it, then the delete goes through.
    for (const slug of ['a', 'b']) {
      writeFileSync(join(contextRoot, 'state', `${slug}.md`), `---\nname: ${slug}\nstatus: completed\n---\n## Why\nx\n`, 'utf-8');
    }
    r = makeRes();
    await handleTaskOverrideRemoveStatus(delReq, r.res, { key: 'cancelled' }, contextRoot);
    expect(r.status()).toBe(200);
    expect(r.body().statuses.some((s: { key: string }) => s.key === 'cancelled')).toBe(false);
  });

  it('PATCH /api/tasks/:slug accepts a declared status and rejects an undeclared one', async () => {
    let r = makeRes();
    await handleTaskOverrideAddStatus(jsonReq('POST', { name: 'Cancelled', kind: 'cancelled', order: 99 }), r.res, {}, contextRoot);
    r = makeRes();
    await handleTasksCreate(jsonReq('POST', { name: 'Patch Me', description: 'd', priority: 'medium', why: 'because' }), r.res, {}, contextRoot);
    expect(r.status()).toBe(201);

    r = makeRes();
    await handleTasksUpdate(jsonReq('PATCH', { status: 'cancelled' }), r.res, { slug: 'patch-me' }, contextRoot);
    expect(r.status()).toBe(200);
    expect(String(matter(readFileSync(join(contextRoot, 'state', 'patch-me.md'), 'utf-8')).data.status)).toBe('cancelled');

    r = makeRes();
    await handleTasksUpdate(jsonReq('PATCH', { status: 'on_hold' }), r.res, { slug: 'patch-me' }, contextRoot);
    expect(r.status()).toBe(400);
    expect(r.body().message).toContain('cancelled');
  });
});
