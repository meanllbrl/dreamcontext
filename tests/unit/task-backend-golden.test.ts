import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Command } from 'commander';

/**
 * GOLDEN TEST — M1 of issue #11 (pluggable task backend).
 *
 * Pins the EXACT bytes the task system writes to `state/*.md` for every CLI
 * verb and every dashboard task endpoint. The fixtures under
 * tests/fixtures/task-backend-golden/ were recorded against the PRE-refactor
 * implementation (direct fs in src/cli/commands/tasks.ts +
 * src/server/routes/tasks.ts). After the TaskBackend refactor the same
 * operation script must produce byte-identical files.
 *
 * Re-record (only when behavior is INTENTIONALLY changed):
 *   GOLDEN_RECORD=1 npx vitest run tests/unit/task-backend-golden.test.ts
 *
 * Determinism: `generateId` and `today` are mocked (nanoid + wall clock are
 * the only nondeterministic inputs to task file bytes).
 */

vi.mock('../../src/lib/id.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/id.js')>();
  let counter = 0;
  return {
    ...actual,
    generateId: (prefix: string) => `${prefix}_golden${String(++counter).padStart(3, '0')}`,
    today: () => '2026-06-11',
  };
});

import { registerTasksCommand } from '../../src/cli/commands/tasks.js';
import {
  handleTasksCreate,
  handleTasksUpdate,
  handleTasksChangelog,
  handleTasksInsert,
  handleTasksList,
  handleTasksGet,
} from '../../src/server/routes/tasks.js';

const RECORD = process.env.GOLDEN_RECORD === '1';
const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'task-backend-golden');

// ─── Harness ────────────────────────────────────────────────────────────────

let projectRoot: string;
let contextRoot: string;
let stateDir: string;
let prevCwd: string;

async function cli(...argv: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerTasksCommand(program);
  await program.parseAsync(['node', 'dreamcontext', ...argv]);
}

function makeReq(body: unknown): IncomingMessage {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  (req as unknown as Record<string, unknown>).headers = {};
  (req as unknown as Record<string, unknown>).method = 'POST';
  return req;
}

interface FakeRes {
  statusCode: number;
  body: string;
}

function makeRes(): ServerResponse & FakeRes {
  const res = {
    statusCode: 0,
    body: '',
    writeHead(code: number) {
      res.statusCode = code;
      return res;
    },
    end(chunk?: unknown) {
      if (chunk !== undefined) res.body = String(chunk);
      return res;
    },
    setHeader() {
      return res;
    },
  };
  return res as unknown as ServerResponse & FakeRes;
}

async function route(
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
    contextRoot: string,
  ) => Promise<void>,
  params: Record<string, string>,
  body?: unknown,
): Promise<FakeRes> {
  const res = makeRes();
  await handler(makeReq(body ?? {}), res, params, contextRoot);
  return res;
}

/**
 * The operation script. Every CLI verb + every mutating dashboard endpoint, in
 * a fixed order, covering the template/formatting branches that produce
 * distinct bytes (placeholder replacement, LIFO inserts, rice rewrite of the
 * frontmatter via gray-matter, body replacement, fallback changelog append).
 */
async function runOperationScript(): Promise<void> {
  // ── CLI verbs ──
  await cli('tasks', 'create', 'Golden Alpha', '-d', 'First golden task', '-w', 'Because golden bytes matter', '-t', 'alpha,golden', '-v', '0.7.1');
  await cli('tasks', 'create', 'Golden Beta', '--priority', 'high', '--urgency', 'low', '-s', 'in_progress', '--reach', '5', '--impact', '4', '--confidence', '75', '--effort', '2');
  await cli('tasks', 'insert', 'golden-alpha', 'acceptance_criteria', 'Criterion one is met');
  await cli('tasks', 'insert', 'golden-alpha', 'user_stories', 'As a dev, I can replay golden ops, so that refactors are provably safe');
  await cli('tasks', 'insert', 'golden-alpha', 'notes', 'A working note');
  await cli('tasks', 'insert', 'golden-alpha', 'constraints', 'Constraint captured');
  await cli('tasks', 'insert', 'golden-alpha', 'technical_details', 'Lives under tests/unit');
  await cli('tasks', 'insert', 'golden-alpha', 'why', 'Extra rationale appended');
  await cli('tasks', 'insert', 'golden-alpha', 'changelog', 'Inserted changelog line');
  await cli('tasks', 'log', 'golden-alpha', 'Session progress note');
  await cli('tasks', 'status', 'golden-alpha', 'in_review', 'Ready for review');
  await cli('tasks', 'rice', 'golden-alpha', '--reach', '8', '--impact', '3', '--confidence', '100', '--effort', '1');
  await cli('tasks', 'rice', 'golden-beta', '--impact', '5');
  await cli('tasks', 'complete', 'golden-beta', 'All done, verified.');
  await cli('tasks', 'status', 'golden-alpha', 'todo');
  await cli('tasks', 'rice', 'golden-beta', '--clear');
  // list/tags are read-only; exercised for crash-safety, not bytes
  await cli('tasks', 'list', '--all', '--long');
  await cli('tasks', 'tags', '--all');

  // ── Dashboard endpoints ──
  await route(handleTasksCreate, {}, {
    name: 'Dash Gamma',
    description: 'Dashboard-created task',
    priority: 'low',
    urgency: 'high',
    tags: ['dash'],
    why: 'Dashboard why',
    version: 'v9',
    rice: { reach: 2, impact: 2, confidence: 50, effort: 4 },
  });
  await route(handleTasksUpdate, { slug: 'dash-gamma' }, {
    status: 'in_progress',
    priority: 'critical',
    tags: ['dash', 'x'],
    description: 'Updated description',
  });
  await route(handleTasksUpdate, { slug: 'dash-gamma' }, { rice: { effort: 3 } });
  await route(handleTasksUpdate, { slug: 'dash-gamma' }, {
    version: 'v10',
    related_feature: 'feat-x',
    name: 'Dash Gamma Renamed',
  });
  await route(handleTasksChangelog, { slug: 'dash-gamma' }, { content: 'Changelog via dedicated route' });
  await route(handleTasksInsert, { slug: 'dash-gamma' }, { section: 'notes', content: 'Note via insert route' });
  await route(handleTasksInsert, { slug: 'dash-gamma' }, { section: 'changelog', content: 'Changelog via insert route' });
  await route(handleTasksInsert, { slug: 'dash-gamma' }, { section: 'constraints', content: 'Constraint via insert route' });
  await route(handleTasksInsert, { slug: 'dash-gamma' }, { section: 'acceptance_criteria', content: 'AC via insert route' });
  await route(handleTasksUpdate, { slug: 'dash-gamma' }, {
    body: '## Why\n\nReplaced body wholesale\n\n## Changelog\n\n### 2026-06-11 - Created\n- Task created.\n',
  });
  await route(handleTasksUpdate, { slug: 'golden-alpha' }, { rice: null });
  // read-only routes for crash-safety
  await route(handleTasksList, {});
  await route(handleTasksGet, { slug: 'dash-gamma' });
}

// ─── Test ───────────────────────────────────────────────────────────────────

describe('task backend golden (M1 — byte-identical state/*.md)', () => {
  beforeAll(async () => {
    const raw = join(tmpdir(), `dc-golden-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(raw, { recursive: true });
    projectRoot = realpathSync(raw);
    contextRoot = join(projectRoot, '_dream_context');
    stateDir = join(contextRoot, 'state');
    mkdirSync(stateDir, { recursive: true });
    // The op script PATCHes related_feature: feat-x, which is now validated
    // against the features store at write time — the referenced PRD must exist
    // for the (byte-pinned) link write to go through.
    const featuresDir = join(contextRoot, 'knowledge', 'features');
    mkdirSync(featuresDir, { recursive: true });
    writeFileSync(
      join(featuresDir, 'feat-x.md'),
      '---\nid: feat_x\ntype: feature\nname: feat-x\nstatus: planning\nrelated_tasks: []\n---\n\n## Why\n\nGolden link target.\n',
    );
    prevCwd = process.cwd();
    process.chdir(projectRoot);
    await runOperationScript();
  });

  afterAll(() => {
    process.chdir(prevCwd);
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('GOLDEN: list/create/updateFields/insert/changelog/complete produce byte-identical state/*.md vs the pre-refactor CLI', () => {
    const produced = readdirSync(stateDir)
      .filter((f) => f.endsWith('.md'))
      .sort();

    if (RECORD) {
      rmSync(FIXTURE_DIR, { recursive: true, force: true });
      mkdirSync(FIXTURE_DIR, { recursive: true });
      for (const f of produced) {
        writeFileSync(join(FIXTURE_DIR, f), readFileSync(join(stateDir, f)));
      }
      writeFileSync(join(FIXTURE_DIR, 'MANIFEST.json'), JSON.stringify(produced, null, 2) + '\n');
      // eslint-disable-next-line no-console
      console.log(`[golden] recorded ${produced.length} fixtures to ${FIXTURE_DIR}`);
      return;
    }

    expect(existsSync(FIXTURE_DIR), `fixture dir missing: ${FIXTURE_DIR} — run GOLDEN_RECORD=1 first`).toBe(true);
    const manifest = JSON.parse(readFileSync(join(FIXTURE_DIR, 'MANIFEST.json'), 'utf-8')) as string[];
    expect(produced).toEqual(manifest);
    for (const f of manifest) {
      const expected = readFileSync(join(FIXTURE_DIR, f), 'utf-8');
      const actual = readFileSync(join(stateDir, f), 'utf-8');
      expect(actual, `byte mismatch in ${f}`).toBe(expected);
    }
  });
});
