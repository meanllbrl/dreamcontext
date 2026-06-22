import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { TaskBackend } from '../../src/lib/task-backend/index.js';

/**
 * Backend-agnostic conformance suite — issue #11.
 *
 * THE SAME suite runs against every TaskBackend implementation (local file
 * store, ClickUp with mocked HTTP, future GitHub/Linear). It pins the
 * SEMANTICS of the interface, not bytes (bytes are the golden test's job).
 * If a backend needs special-casing here, the backend is wrong.
 */

export interface ConformanceHarness {
  backend: TaskBackend;
  cleanup(): void | Promise<void>;
}

export function describeTaskBackendConformance(
  name: string,
  makeHarness: () => Promise<ConformanceHarness>,
): void {
  describe(`TaskBackend conformance — ${name}`, () => {
    let h: ConformanceHarness;
    let backend: TaskBackend;

    beforeEach(async () => {
      h = await makeHarness();
      backend = h.backend;
    });

    afterEach(async () => {
      await h.cleanup();
    });

    it('create returns the task and get round-trips it', async () => {
      const created = await backend.create({
        name: 'Conformance Alpha',
        description: 'desc',
        priority: 'high',
        urgency: 'low',
        tags: ['conf', 'alpha'],
        why: 'Because conformance',
        version: 'v1',
        variant: 'cli',
      });
      expect(created.slug).toBe('conformance-alpha');
      expect(created.status).toBe('todo');
      expect(created.priority).toBe('high');
      expect(created.tags).toEqual(['conf', 'alpha']);

      const got = await backend.get('conformance-alpha');
      expect(got).not.toBeNull();
      expect(got!.name).toBe('Conformance Alpha');
      expect(got!.description).toBe('desc');
      expect(got!.version).toBe('v1');
      expect(got!.why).toContain('Because conformance');
    });

    it('create rejects a duplicate slug', async () => {
      await backend.create({ name: 'Dup Task', variant: 'cli' });
      await expect(backend.create({ name: 'Dup Task', variant: 'cli' })).rejects.toMatchObject({
        code: 'already_exists',
      });
    });

    it('get returns null for a missing task', async () => {
      expect(await backend.get('does-not-exist')).toBeNull();
    });

    it('list filters by status, hides completed by default, and honors all/tags', async () => {
      await backend.create({ name: 'L One', tags: ['x'], variant: 'cli' });
      await backend.create({ name: 'L Two', tags: ['x', 'y'], variant: 'cli' });
      await backend.create({ name: 'L Three', variant: 'cli' });
      await backend.updateFields('l-two', { status: 'in_progress', updated_at: '2026-06-11' });
      await backend.complete('l-three', 'done');

      const active = await backend.list({});
      expect(active.map((t) => t.name).sort()).toEqual(['l-one', 'l-two']);

      const all = await backend.list({ all: true });
      expect(all.map((t) => t.name).sort()).toEqual(['l-one', 'l-three', 'l-two']);

      const inProgress = await backend.list({ status: 'in_progress' });
      expect(inProgress.map((t) => t.name)).toEqual(['l-two']);

      const tagged = await backend.list({ tags: ['x', 'y'] });
      expect(tagged.map((t) => t.name)).toEqual(['l-two']);
    });

    it('updateFields patches frontmatter fields', async () => {
      await backend.create({ name: 'U One', variant: 'cli' });
      const updated = await backend.updateFields('u-one', {
        status: 'in_review',
        priority: 'critical',
        updated_at: '2026-06-12',
      });
      expect(updated.status).toBe('in_review');
      expect(updated.priority).toBe('critical');
      expect(updated.updated_at).toBe('2026-06-12');
    });

    it('updateFields on a missing task throws not_found', async () => {
      await expect(
        backend.updateFields('nope', { status: 'todo' }),
      ).rejects.toMatchObject({ code: 'not_found' });
    });

    it('insertSection LIFO-prepends to Changelog and appends to Notes', async () => {
      await backend.create({ name: 'I One', variant: 'cli' });
      await backend.insertSection('i-one', 'Changelog', '### 2026-06-11 - First\n- first', { position: 'top' });
      await backend.insertSection('i-one', 'Changelog', '### 2026-06-11 - Second\n- second', { position: 'top' });
      await backend.insertSection('i-one', 'Notes', 'note line', { position: 'bottom', replacePlaceholders: true });

      const task = await backend.get('i-one');
      const cl = task!.changelog;
      expect(cl.indexOf('Second')).toBeGreaterThan(-1);
      expect(cl.indexOf('Second')).toBeLessThan(cl.indexOf('First'));
      expect(task!.notes).toContain('note line');
    });

    it('addChangelog prepends entries newest-first', async () => {
      await backend.create({ name: 'C One', variant: 'cli' });
      await backend.addChangelog('c-one', '### 2026-06-11 - Session Update\n- entry one');
      await backend.addChangelog('c-one', '### 2026-06-11 - Session Update\n- entry two');
      const task = await backend.get('c-one');
      const cl = task!.changelog;
      expect(cl.indexOf('entry two')).toBeLessThan(cl.indexOf('entry one'));
    });

    it('complete sets status=completed and records a Completed changelog entry', async () => {
      await backend.create({ name: 'Done Soon', variant: 'cli' });
      const done = await backend.complete('done-soon', 'Shipped it.');
      expect(done.status).toBe('completed');
      expect(done.changelog).toContain('Completed');
      expect(done.changelog).toContain('Shipped it.');
    });

    it('resolveSlug: exact, prefix, substring, ambiguous, none', async () => {
      await backend.create({ name: 'Resolver Apple', variant: 'cli' });
      await backend.create({ name: 'Resolver Apricot', variant: 'cli' });
      await backend.create({ name: 'Solo Banana', variant: 'cli' });

      expect(await backend.resolveSlug('Resolver Apple')).toEqual({ kind: 'match', slug: 'resolver-apple' });
      expect(await backend.resolveSlug('solo')).toEqual({ kind: 'match', slug: 'solo-banana' });
      expect(await backend.resolveSlug('banana')).toEqual({ kind: 'match', slug: 'solo-banana' });

      const ambiguous = await backend.resolveSlug('resolver-ap');
      expect(ambiguous.kind).toBe('ambiguous');
      if (ambiguous.kind === 'ambiguous') {
        expect(ambiguous.candidates.sort()).toEqual(['resolver-apple', 'resolver-apricot']);
      }

      expect(await backend.resolveSlug('zzz-not-here')).toEqual({ kind: 'none' });
    });

    it('delete removes the task; deleting a missing task throws not_found', async () => {
      await backend.create({ name: 'Doomed', variant: 'cli' });
      expect(await backend.get('doomed')).not.toBeNull();
      await backend.delete('doomed');
      expect(await backend.get('doomed')).toBeNull();
      expect((await backend.list({ all: true })).map((t) => t.name)).not.toContain('doomed');
      await expect(backend.delete('doomed')).rejects.toMatchObject({ code: 'not_found' });
    });

    it('BACKLOG RULE: backlog-tagged tasks are undated; dating one un-backlogs it', async () => {
      // create with both → backlog wins, BOTH start + due dropped
      const created = await backend.create({
        name: 'Backlog Born', tags: ['backlog', 'x'], start_date: '2026-09-01', due_date: '2026-09-09', variant: 'cli',
      });
      expect(created.due_date).toBeNull();
      expect(created.start_date).toBeNull();
      expect(created.tags).toContain('backlog');

      // tagging an existing dated task as backlog clears BOTH dates
      await backend.create({ name: 'Dated Then Parked', start_date: '2026-10-01', due_date: '2026-10-10', variant: 'cli' });
      const parked = await backend.updateFields('dated-then-parked', {
        tags: ['backlog'], updated_at: '2026-06-12',
      });
      expect(parked.due_date).toBeNull();
      expect(parked.start_date).toBeNull();
      expect(parked.tags).toContain('backlog');

      // explicitly scheduling a backlog task (via the START date) un-backlogs it
      const scheduled = await backend.updateFields('backlog-born', {
        start_date: '2026-11-01', updated_at: '2026-06-12',
      });
      expect(scheduled.start_date).toBe('2026-11-01');
      expect(scheduled.tags).not.toContain('backlog');
      expect(scheduled.tags).toContain('x'); // other tags survive
    });

    it('sync returns a structured SyncReport', async () => {
      const report = await backend.sync('both');
      expect(report.backend).toBe(backend.name);
      expect(report.direction).toBe('both');
      expect(Array.isArray(report.conflicts)).toBe(true);
      expect(Array.isArray(report.errors)).toBe(true);
    });
  });
}
