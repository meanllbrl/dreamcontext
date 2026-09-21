import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProgram } from '../../src/cli/program.js';
import { createAutomation } from '../../src/lib/automations/store.js';
import { appendThreadEntry, readThread, threadUnread } from '../../src/lib/automations/threads.js';

/**
 * `automations post` — the ONE way anything reaches a channel on an agent's
 * own behalf — driven through the real command tree rather than by calling the
 * store directly. What is under test is the VERB: how it resolves the run a
 * post belongs to, and what it does when it cannot.
 *
 * The refusals are the point. A post that invents a run id lands in a thread
 * no run will ever close, which reads to a human as an agent talking to
 * itself; a post that lands minus its attachment is a claim about a file the
 * reader cannot open. So every refusal below is asserted twice — non-zero
 * exit, AND an untouched channel.
 */

let projectRoot: string;
let contextRoot: string;
let cwd: string;
let realHome: string | undefined;
let fakeHome: string;

const RUN_ID = '2026-09-20T18:00:00.000Z';

/** Drive the real CLI and hand back what a run's shell would see. */
async function run(argv: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
  const err = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
  process.exitCode = undefined;
  try {
    await createProgram().parseAsync(argv, { from: 'user' });
  } finally {
    log.mockRestore();
    err.mockRestore();
  }
  const code = process.exitCode ?? 0;
  process.exitCode = undefined;
  return { code, out: lines.join('\n') };
}

beforeEach(() => {
  cwd = process.cwd();
  // realpath, because `chdir` resolves symlinks (/var → /private/var on macOS)
  // and the CLI therefore derives a different — equally correct — absolute root
  // than the one mkdtemp handed back. The read watermark is KEYED by that root,
  // so without this the CLI writes one key and the assertion reads another, and
  // `read` looks broken when it is not.
  projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'dc-threads-cli-')));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
  createAutomation(contextRoot, {
    slug: 'digest', title: 'Daily digest', days: 'daily', at: '18:00', prompt: 'Say hello.',
  });
  process.chdir(projectRoot);
  // The read watermark resolves through `homedir()` and no command line can
  // inject a different one, so moving HOME is the ONLY way to keep
  // `automations read` in a test run off the developer's own channels.
  realHome = process.env.HOME;
  fakeHome = mkdtempSync(join(tmpdir(), 'dc-threads-cli-home-'));
  process.env.HOME = fakeHome;
  delete process.env.DREAMCONTEXT_AUTOMATION_RUN;
  delete process.env.DREAMCONTEXT_AUTOMATION_SLUG;
});

afterEach(() => {
  process.chdir(cwd);
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
  delete process.env.DREAMCONTEXT_AUTOMATION_RUN;
  delete process.env.DREAMCONTEXT_AUTOMATION_SLUG;
});

describe('automations post — which run a post belongs to', () => {
  it('binds to the run in the environment, with no ids passed', async () => {
    process.env.DREAMCONTEXT_AUTOMATION_RUN = RUN_ID;
    const { code } = await run(['automations', 'post', 'digest', 'WAU is down 4% week-over-week.']);
    expect(code).toBe(0);

    const entries = readThread(contextRoot, 'digest');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      runId: RUN_ID, kind: 'agent', via: 'cli', text: 'WAU is down 4% week-over-week.',
    });
  });

  it('--run wins over the environment — a catch-up post can answer for an earlier fire', async () => {
    process.env.DREAMCONTEXT_AUTOMATION_RUN = RUN_ID;
    await run(['automations', 'post', 'digest', 'late note', '--run', '2026-09-19T18:00:00.000Z']);
    expect(readThread(contextRoot, 'digest')[0].runId).toBe('2026-09-19T18:00:00.000Z');
  });

  it('with no environment, falls back to the newest run already in the channel', async () => {
    appendThreadEntry(contextRoot, 'digest', {
      runId: '2026-09-19T18:00:00.000Z', kind: 'system', event: 'started', text: 'Run started.', via: 'runner',
      now: new Date('2026-09-19T18:00:01.000Z'),
    });
    appendThreadEntry(contextRoot, 'digest', {
      runId: RUN_ID, kind: 'system', event: 'started', text: 'Run started.', via: 'runner',
      now: new Date('2026-09-20T18:00:01.000Z'),
    });

    const { code } = await run(['automations', 'post', 'digest', 'found something']);
    expect(code).toBe(0);
    const posts = readThread(contextRoot, 'digest').filter((e) => e.kind === 'agent');
    expect(posts).toHaveLength(1);
    expect(posts[0].runId).toBe(RUN_ID);
  });

  it('refuses with a non-zero exit and writes NOTHING when no run resolves', async () => {
    const { code, out } = await run(['automations', 'post', 'digest', 'orphan post']);
    expect(code).toBe(1);
    expect(out).toContain('No run to post to');
    expect(readThread(contextRoot, 'digest')).toEqual([]);
  });

  it('refuses an unknown slug and writes nothing', async () => {
    process.env.DREAMCONTEXT_AUTOMATION_RUN = RUN_ID;
    const { code } = await run(['automations', 'post', 'not-an-agent', 'hello']);
    expect(code).toBe(1);
    expect(readThread(contextRoot, 'not-an-agent')).toEqual([]);
  });

  it('refuses an empty post', async () => {
    process.env.DREAMCONTEXT_AUTOMATION_RUN = RUN_ID;
    const { code } = await run(['automations', 'post', 'digest', '   ']);
    expect(code).toBe(1);
    expect(readThread(contextRoot, 'digest')).toEqual([]);
  });
});

describe('automations post — attachments stay inside the brain', () => {
  beforeEach(() => {
    process.env.DREAMCONTEXT_AUTOMATION_RUN = RUN_ID;
  });

  it('attaches brain-relative paths, repeatably', async () => {
    await run([
      'automations', 'post', 'digest', 'the report',
      '--file', 'automations/output/digest/2026-09-20.md',
      '--file', 'knowledge/wau.md',
    ]);
    expect(readThread(contextRoot, 'digest')[0].files).toEqual([
      'automations/output/digest/2026-09-20.md', 'knowledge/wau.md',
    ]);
  });

  it('refuses a path that escapes the brain, and writes neither the file nor the text', async () => {
    writeFileSync(join(projectRoot, 'secret.md'), 'secret\n', 'utf-8');
    const { code, out } = await run(['automations', 'post', 'digest', 'look at this', '--file', '../secret.md']);
    expect(code).toBe(1);
    expect(out).toContain('outside the brain');
    expect(readThread(contextRoot, 'digest')).toEqual([]);
  });

  it('refuses an absolute path', async () => {
    const { code } = await run(['automations', 'post', 'digest', 'look', '--file', '/etc/hosts']);
    expect(code).toBe(1);
    expect(readThread(contextRoot, 'digest')).toEqual([]);
  });

  it('refuses a fifth file rather than silently dropping it', async () => {
    const { code } = await run([
      'automations', 'post', 'digest', 'five files',
      '--file', 'a.md', '--file', 'b.md', '--file', 'c.md', '--file', 'd.md', '--file', 'e.md',
    ]);
    expect(code).toBe(1);
    expect(readThread(contextRoot, 'digest')).toEqual([]);
  });
});

describe('automations thread / read', () => {
  it('thread --json emits the channel and this machine\'s unread count', async () => {
    process.env.DREAMCONTEXT_AUTOMATION_RUN = RUN_ID;
    await run(['automations', 'post', 'digest', 'first']);
    await run(['automations', 'post', 'digest', 'second']);

    const { out } = await run(['automations', 'thread', 'digest', '--json']);
    const payload = JSON.parse(out) as { slug: string; entries: { text: string }[]; unread: { count: number } };
    expect(payload.slug).toBe('digest');
    expect(payload.entries.map((e) => e.text)).toEqual(['first', 'second']);
    expect(payload.unread.count).toBe(2);
  });

  it('thread --run narrows to one run', async () => {
    process.env.DREAMCONTEXT_AUTOMATION_RUN = RUN_ID;
    await run(['automations', 'post', 'digest', 'today']);
    await run(['automations', 'post', 'digest', 'yesterday', '--run', '2026-09-19T18:00:00.000Z']);

    const { out } = await run(['automations', 'thread', 'digest', '--json', '--run', RUN_ID]);
    const payload = JSON.parse(out) as { entries: { text: string }[] };
    expect(payload.entries.map((e) => e.text)).toEqual(['today']);
  });

  it('read clears this machine\'s unread, and an older id never rewinds it', async () => {
    process.env.DREAMCONTEXT_AUTOMATION_RUN = RUN_ID;
    await run(['automations', 'post', 'digest', 'first']);
    const firstId = readThread(contextRoot, 'digest')[0].id;
    await run(['automations', 'post', 'digest', 'second']);
    expect(threadUnread(contextRoot, 'digest', fakeHome).count).toBe(2);

    expect((await run(['automations', 'read', 'digest'])).code).toBe(0);
    expect(threadUnread(contextRoot, 'digest', fakeHome).count).toBe(0);

    // Re-reading an OLDER entry must not re-open the two already read — the
    // refusal `ackAttention` makes, for the same reason: a badge you have
    // already dismissed must not come back.
    await run(['automations', 'read', 'digest', '--up-to', firstId]);
    expect(threadUnread(contextRoot, 'digest', fakeHome).count).toBe(0);
  });

  it('an empty channel answers the question instead of failing', async () => {
    createAutomation(contextRoot, {
      slug: 'quiet', title: 'Quiet one', days: 'daily', at: '09:00', prompt: 'Nothing.',
    });
    const { code, out } = await run(['automations', 'thread', 'quiet']);
    expect(code).toBe(0);
    expect(out).toMatch(/No runs yet/);
  });
});
