import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import matter from 'gray-matter';
import {
  handleTasksUpdate,
  handleTasksCreate,
  handleTasksDelete,
  handleTasksChangelog,
  handleTasksInsert,
  handleTasksList,
} from '../../src/server/routes/tasks.js';

/**
 * The sub-task link over the task routes (AC5): PATCH writes `parent_task` with the four
 * refusal codes, POST creates a subtask that inherits version + feature and may omit Why,
 * DELETE of a parent clears its children's link and deletes none of them. Plus the two small
 * route fixes (insert takes `workflow`; changelog creates a missing `## Changelog`) and the
 * list's `attachments` summary.
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

const delReq = { method: 'DELETE', headers: {} } as unknown as IncomingMessage;
const getReq = { method: 'GET', headers: {} } as unknown as IncomingMessage;

let projectRoot: string;
let contextRoot: string;

function writeTask(slug: string, fm: Record<string, unknown>, body = '## Why\nBecause.\n'): void {
  const front = { name: slug, status: 'todo', priority: 'medium', urgency: 'medium', parent_task: null, related_feature: null, version: null, ...fm };
  writeFileSync(join(contextRoot, 'state', `${slug}.md`), matter.stringify(body, front), 'utf-8');
}

function fmOf(slug: string): Record<string, unknown> {
  return matter(readFileSync(join(contextRoot, 'state', `${slug}.md`), 'utf-8')).data;
}

beforeEach(() => {
  const raw = join(tmpdir(), `tr-parent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  mkdirSync(join(contextRoot, 'knowledge', 'features'), { recursive: true });
  writeFileSync(join(contextRoot, 'knowledge', 'features', 'checkout.md'), '---\nname: Checkout\ntype: feature\nrelated_tasks: []\n---\n## Why\nx\n', 'utf-8');
  writeTask('parent', { name: 'Parent Task', version: '1.2.0', related_feature: 'checkout' });
  writeTask('child-a', { parent_task: 'parent' });
  writeTask('loner', {});
  writeTask('other', {});
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('PATCH /api/tasks/:slug parent_task', () => {
  it('sets and clears the link', async () => {
    let r = makeRes();
    await handleTasksUpdate(jsonReq('PATCH', { parent_task: 'parent' }), r.res, { slug: 'loner' }, contextRoot);
    expect(r.status()).toBe(200);
    expect(r.body().task.parent_task).toBe('parent');
    expect(fmOf('loner').parent_task).toBe('parent');

    r = makeRes();
    await handleTasksUpdate(jsonReq('PATCH', { parent_task: null }), r.res, { slug: 'loner' }, contextRoot);
    expect(r.status()).toBe(200);
    expect(fmOf('loner').parent_task).toBeNull();
  });

  it.each([
    ['loner', 'loner', 'self'],
    ['loner', 'ghost-task', 'parent_missing'],
    ['loner', 'child-a', 'parent_is_child'],
    ['parent', 'other', 'child_has_children'],
  ])('%s under %s → 400 %s', async (slug, parentSlug, code) => {
    const r = makeRes();
    await handleTasksUpdate(jsonReq('PATCH', { parent_task: parentSlug }), r.res, { slug }, contextRoot);
    expect(r.status()).toBe(400);
    expect(r.body().error).toBe(code);
    expect(fmOf(slug).parent_task ?? null).toBeNull();
  });

  it('refuses a non-slug value', async () => {
    const r = makeRes();
    await handleTasksUpdate(jsonReq('PATCH', { parent_task: '../etc' }), r.res, { slug: 'loner' }, contextRoot);
    expect(r.status()).toBe(400);
    expect(r.body().error).toBe('invalid_parent_task');
  });
});

describe('POST /api/tasks parent_task', () => {
  it('creates a subtask: version + feature copied from the parent, Why defaulted', async () => {
    const r = makeRes();
    await handleTasksCreate(jsonReq('POST', { name: 'Wire the webhook', description: '', priority: 'medium', parent_task: 'parent' }), r.res, {}, contextRoot);
    expect(r.status()).toBe(201);
    const slug = r.body().task.slug;
    const fm = fmOf(slug);
    expect(fm.parent_task).toBe('parent');
    expect(fm.version).toBe('1.2.0');
    expect(fm.related_feature).toBe('checkout');
    const text = readFileSync(join(contextRoot, 'state', `${slug}.md`), 'utf-8');
    expect(text).toContain('Part of Parent Task (`parent`).');
    // The feature side of the bidirectional link follows.
    const feat = matter(readFileSync(join(contextRoot, 'knowledge', 'features', 'checkout.md'), 'utf-8')).data;
    expect(feat.related_tasks).toContain(slug);
  });

  it('an explicit version / why wins over the parent', async () => {
    const r = makeRes();
    await handleTasksCreate(jsonReq('POST', { name: 'Explicit one', description: '', priority: 'medium', parent_task: 'parent', version: '2.0.0', why: 'Own reason.' }), r.res, {}, contextRoot);
    expect(r.status()).toBe(201);
    const slug = r.body().task.slug;
    expect(fmOf(slug).version).toBe('2.0.0');
    expect(readFileSync(join(contextRoot, 'state', `${slug}.md`), 'utf-8')).toContain('Own reason.');
  });

  it('why is still required without a parent', async () => {
    const r = makeRes();
    await handleTasksCreate(jsonReq('POST', { name: 'No why', description: '', priority: 'medium' }), r.res, {}, contextRoot);
    expect(r.status()).toBe(400);
    expect(r.body().error).toBe('missing_why');
  });

  it('refuses a parent that is itself a child, or missing', async () => {
    let r = makeRes();
    await handleTasksCreate(jsonReq('POST', { name: 'Grandchild', description: '', priority: 'medium', parent_task: 'child-a' }), r.res, {}, contextRoot);
    expect(r.status()).toBe(400);
    expect(r.body().error).toBe('parent_is_child');
    r = makeRes();
    await handleTasksCreate(jsonReq('POST', { name: 'Orphan', description: '', priority: 'medium', parent_task: 'nope' }), r.res, {}, contextRoot);
    expect(r.status()).toBe(400);
    expect(r.body().error).toBe('parent_missing');
    expect(existsSync(join(contextRoot, 'state', 'grandchild.md'))).toBe(false);
  });
});

describe('DELETE /api/tasks/:slug of a parent', () => {
  it('clears the children\'s link first and deletes none of them', async () => {
    writeTask('child-b', { parent_task: 'parent' });
    const r = makeRes();
    await handleTasksDelete(delReq, r.res, { slug: 'parent' }, contextRoot);
    expect(r.status()).toBe(200);
    expect(existsSync(join(contextRoot, 'state', 'parent.md'))).toBe(false);
    for (const c of ['child-a', 'child-b']) {
      expect(existsSync(join(contextRoot, 'state', `${c}.md`))).toBe(true);
      expect(fmOf(c).parent_task).toBeNull();
    }
  });
});

describe('small route fixes', () => {
  it('insert accepts workflow', async () => {
    const r = makeRes();
    await handleTasksInsert(jsonReq('POST', { section: 'workflow', content: 'Step one.' }), r.res, { slug: 'loner' }, contextRoot);
    expect(r.status()).toBe(200);
    expect(readFileSync(join(contextRoot, 'state', 'loner.md'), 'utf-8')).toMatch(/## Workflow[\s\S]*Step one\./);
  });

  it('changelog creates a missing ## Changelog instead of answering 500', async () => {
    const r = makeRes();
    await handleTasksChangelog(jsonReq('POST', { content: 'First entry.' }), r.res, { slug: 'loner' }, contextRoot);
    expect(r.status()).toBe(200);
    expect(readFileSync(join(contextRoot, 'state', 'loner.md'), 'utf-8')).toMatch(/## Changelog[\s\S]*First entry\./);
  });

  it('the list carries attachments {count, cover}', async () => {
    const dir = join(contextRoot, 'state', 'assets', 'loner');
    mkdirSync(join(dir, 'clips'), { recursive: true });
    writeFileSync(join(dir, 'b.png'), 'x');
    writeFileSync(join(dir, 'a.jpg'), 'x');
    writeFileSync(join(dir, 'notes.txt'), 'x');
    const r = makeRes();
    await handleTasksList(getReq, r.res, {}, contextRoot);
    const byslug = Object.fromEntries(r.body().tasks.map((t: any) => [t.slug, t]));
    expect(byslug.loner.attachments).toEqual({ count: 4, cover: 'a.jpg' });
    expect(byslug.other.attachments).toEqual({ count: 0, cover: null });
  });
});
