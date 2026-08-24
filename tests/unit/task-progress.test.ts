/**
 * `firstUnticked` (src/lib/markdown.ts) and the `/api/agent/task-progress` handler
 * (src/server/routes/agent-shelf.ts) — the number behind the chat shelf's progress row.
 *
 * The property these tests exist to protect is that the percent is DERIVED, not asserted:
 * it comes from the task file's own acceptance-criteria checkboxes, counted by the same
 * `countCheckboxes` that `dreamcontext tasks doctor` uses. So every case here writes a real
 * markdown file and drives the real handler against it — nothing is stubbed except the HTTP
 * response object.
 *
 * The degenerate arms carry as much weight as the happy one. A zero-criteria task must not
 * produce `NaN%`, a hostile slug must be refused BEFORE `join` ever sees it, and an
 * off-desktop server must answer a renderable shape rather than a 500.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firstUnticked, countCheckboxes } from '../../src/lib/markdown.js';
import { handleAgentTaskProgress, type TaskProgress } from '../../src/server/routes/agent-shelf.js';

// ─── firstUnticked ──────────────────────────────────────────────────────────────────

describe('firstUnticked', () => {
  it('returns the first UNTICKED criterion, skipping the ticked ones above it', () => {
    const body = [
      '- [x] the first thing, already done',
      '- [x] the second thing, already done',
      '- [ ] the third thing, in flight',
      '- [ ] the fourth thing, queued',
    ].join('\n');
    expect(firstUnticked(body)).toBe('the third thing, in flight');
  });

  it('strips strong emphasis and backticks, so the row reads as a sentence', () => {
    expect(firstUnticked('- [ ] **M1 — The shelf** docks to the composer'))
      .toBe('M1 — The shelf docks to the composer');
    expect(firstUnticked('- [ ] `VIEW_TYPES` gains both types'))
      .toBe('VIEW_TYPES gains both types');
    expect(firstUnticked('- [ ] __both__ halves ship together'))
      .toBe('both halves ship together');
  });

  it('leaves single underscores alone — a path is worth more than an italic', () => {
    // The conservative rule: `_dream_context/...` must survive intact. An italics-aware
    // strip turns it into `dreamcontext/...`, which is a worse answer than a stray marker.
    expect(firstUnticked('- [ ] `_dream_context/state/x.md` is the source'))
      .toBe('_dream_context/state/x.md is the source');
  });

  it('is null when every criterion is ticked, and when there are none at all', () => {
    expect(firstUnticked('- [x] done\n- [X] also done')).toBeNull();
    expect(firstUnticked('just some prose, no checkboxes here')).toBeNull();
    expect(firstUnticked('')).toBeNull();
  });

  it('skips a checkbox with no text rather than returning an empty string', () => {
    expect(firstUnticked('- [ ] \n- [ ] the real one')).toBe('the real one');
  });

  it('reads the SAME lines countCheckboxes counts — the name can never describe another set', () => {
    const body = [
      '- [x] ticked',
      '  * [ ] a nested asterisk bullet still counts',
      'not a checkbox',
    ].join('\n');
    expect(countCheckboxes(body)).toEqual({ total: 2, done: 1 });
    expect(firstUnticked(body)).toBe('a nested asterisk bullet still counts');
  });
});

// ─── the route ──────────────────────────────────────────────────────────────────────

const FIXTURE = mkdtempSync(join(tmpdir(), 'dc-task-progress-'));
const CONTEXT_ROOT = join(FIXTURE, '_dream_context');
const STATE_DIR = join(CONTEXT_ROOT, 'state');

afterAll(() => { rmSync(FIXTURE, { recursive: true, force: true }); });

function writeTask(slug: string, body: string): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(join(STATE_DIR, `${slug}.md`), `---\nid: task_${slug}\n---\n${body}`, 'utf-8');
}

/** A criteria section with `done` of `total` ticked, plus a LIFO changelog. */
function taskBody(total: number, done: number): string {
  const lines = Array.from({ length: total }, (_, i) =>
    `- [${i < done ? 'x' : ' '}] criterion number ${i + 1}`);
  return [
    '## Acceptance Criteria',
    '',
    ...lines,
    '',
    '## Changelog',
    '<!-- LIFO: newest at top. -->',
    '',
    '### 2026-08-23 - Session Update',
    '- the newest thing that happened',
    '### 2026-08-22 - Created',
    '- Task created.',
  ].join('\n');
}

interface Captured { status: number; body: unknown }

/** A minimal `ServerResponse` stand-in — `sendJson`/`sendError` only ever call these two. */
function fakeRes(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, body: null };
  const res = {
    writeHead(status: number) { captured.status = status; return this; },
    end(payload?: string) { captured.body = payload ? JSON.parse(payload) : null; },
  } as unknown as ServerResponse;
  return { res, captured };
}

async function get(slug: string, contextRoot: string | null = CONTEXT_ROOT): Promise<Captured> {
  const req = {
    url: `/api/agent/task-progress?slug=${encodeURIComponent(slug)}`,
    headers: { host: '127.0.0.1:1234' },
  } as unknown as IncomingMessage;
  const { res, captured } = fakeRes();
  await handleAgentTaskProgress(req, res, {}, contextRoot);
  return captured;
}

describe('GET /api/agent/task-progress', () => {
  beforeEach(() => { process.env.DREAMCONTEXT_DESKTOP = '1'; });

  it('7 of 11 ticked reads 64% — the number tasks doctor would report', async () => {
    writeTask('seven-of-eleven', taskBody(11, 7));
    const { status, body } = await get('seven-of-eleven');
    const p = body as TaskProgress;
    expect(status).toBe(200);
    expect(p.state).toBe('ok');
    expect(p.percent).toBe(64);
    expect(p.done).toBe(7);
    expect(p.total).toBe(11);
    expect(p.notice).toBeNull();
  });

  it('names what is in flight and what was just done', async () => {
    writeTask('in-flight', taskBody(11, 7));
    const p = (await get('in-flight')).body as TaskProgress;
    expect(p.now).toBe('criterion number 8');
    expect(p.last).toBe('the newest thing that happened');
    expect(p.updatedAt).toBeGreaterThan(0);
  });

  it('follows the file as it changes on disk — not frozen at first read', async () => {
    writeTask('moving', taskBody(11, 7));
    expect((await get('moving')).body).toMatchObject({ percent: 64 });
    writeTask('moving', taskBody(11, 8));
    const p = (await get('moving')).body as TaskProgress;
    expect(p.percent).toBe(73);
    expect(p.now).toBe('criterion number 9');
  });

  it('zero criteria degrades LOUDLY — percent null, never NaN', async () => {
    writeTask('no-boxes', '## Acceptance Criteria\n\nSome prose, no checkboxes.\n');
    const p = (await get('no-boxes')).body as TaskProgress;
    expect(p.state).toBe('no-criteria');
    expect(p.percent).toBeNull();
    expect(Number.isNaN(p.percent as unknown as number)).toBe(false);
    expect(p.notice).toBeTruthy();
  });

  it('a missing Acceptance Criteria section degrades the same way, with its own notice', async () => {
    writeTask('no-section', '## Why\n\nnothing else here\n');
    const p = (await get('no-section')).body as TaskProgress;
    expect(p.state).toBe('no-criteria');
    expect(p.percent).toBeNull();
    expect(p.notice).toContain('Acceptance Criteria');
  });

  it('an all-ticked task reads 100% AND says so — a full bar is not self-explanatory', async () => {
    writeTask('all-done', taskBody(5, 5));
    const p = (await get('all-done')).body as TaskProgress;
    expect(p.state).toBe('all-done');
    expect(p.percent).toBe(100);
    expect(p.now).toBeNull();
    expect(p.notice).toBeTruthy();
  });

  it('a well-formed slug with no file is a 200 STATE, not a failed request', async () => {
    const { status, body } = await get('no-such-task-here');
    const p = body as TaskProgress;
    expect(status).toBe(200);
    expect(p.state).toBe('unknown-slug');
    expect(p.percent).toBeNull();
    expect(p.notice).toContain('no-such-task-here');
  });

  it('a hostile slug is 400 — refused before the filesystem is touched', async () => {
    for (const slug of ['../../etc/passwd', '../secrets', '/etc/passwd', '', '\0bad']) {
      const { status, body } = await get(slug);
      expect(status, `slug: ${JSON.stringify(slug)}`).toBe(400);
      expect(body).toMatchObject({ error: 'invalid_slug' });
    }
  });

  it('records where the SHARED guard actually draws the line: contained-but-nested passes', async () => {
    // `isSafeTaskSlug` (task-backend/local.ts) rejects escape, not nesting — `a/b` resolves
    // to `state/a/b.md`, still inside the vault, so it is accepted here exactly as it is by
    // `GET /api/tasks/:slug` (tasks.ts:699). This route deliberately does NOT add a second,
    // stricter definition of "slug": two guards that disagree is the drift the shared helper
    // exists to prevent. It lands in the ordinary missing-file arm.
    const { status, body } = await get('nested/thing');
    expect(status).toBe(200);
    expect((body as TaskProgress).state).toBe('unknown-slug');
  });

  it('the traversal arm answers 400 even when the target file really exists', async () => {
    // Proves the guard is the SLUG check and not "the file wasn't there anyway": write a
    // real file one directory up and try to reach it.
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(join(CONTEXT_ROOT, 'reachable.md'), taskBody(2, 1), 'utf-8');
    const { status } = await get('../reachable');
    expect(status).toBe(400);
  });

  it('off-desktop answers a renderable shape, never a 500', async () => {
    delete process.env.DREAMCONTEXT_DESKTOP;
    writeTask('gated', taskBody(4, 2));
    const { status, body } = await get('gated');
    const p = body as TaskProgress;
    expect(status).toBe(200);
    expect(p.state).toBe('unreadable');
    expect(p.percent).toBeNull();
    expect(p.notice).toBeTruthy();
  });

  it('a null contextRoot answers the same way — no project, no throw', async () => {
    const { status, body } = await get('anything', null);
    expect(status).toBe(200);
    expect((body as TaskProgress).state).toBe('unreadable');
  });
});
