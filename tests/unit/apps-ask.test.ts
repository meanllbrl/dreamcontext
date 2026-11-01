import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ASK_MAX_PER_APP, ASK_MAX_PER_MINUTE, appAskArgs, askRoom, readOwnAsk, resetAppAsksForTests, startOwnAsk } from '../../src/lib/apps/assistant-ask.js';
import { registerApp, type AppRecord } from '../../src/lib/apps/registry.js';
import { LIGHT_DISALLOWED_TOOLS } from '../../src/lib/automations/light-run.js';
import type { ClaudeExecution } from '../../src/lib/automations/runner.js';

let home: string; let rec: AppRecord;
beforeEach(() => {
  resetAppAsksForTests();
  home = realpathSync(mkdtempSync(join(tmpdir(), 'dc-ask-')));
  const project = join(home, 'p'); mkdirSync(project);
  const root = join(home, 'p-apps', 'yuk'); mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'dreamcontext-app.json'), JSON.stringify({ slug: 'yuk', name: 'Yuk', agent: { own: true } }));
  writeFileSync(join(root, 'ASSISTANT.md'), 'You watch the load.\n');
  rec = registerApp(home, { projectRoot: project, vault: 'v', slug: 'yuk', name: 'Yuk', root });
});
afterEach(() => { resetAppAsksForTests(); rmSync(home, { recursive: true, force: true }); });

const done = (over: Partial<ClaudeExecution> = {}): ClaudeExecution => ({
  spawned: true, timedOut: false, exitCode: 0, stdout: JSON.stringify({ result: 'ten' }), stderrTail: '', startedAt: new Date(), finishedAt: new Date(), result: null, ...over,
});
const tick = () => new Promise((r) => setTimeout(r, 5));

describe('the envelope', () => {
  const args = appAskArgs('q', '/apps/yuk', '/home/x');
  it('leaves no session and reads only its folder', () => {
    expect(args).toContain('--no-session-persistence');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('');
    expect(args).toContain('Read(//apps/yuk/**)');
    expect(args).not.toContain('Read');
    expect(args).not.toContain('Grep');
  });
  it('denies the whole light list, Bash included, and credentials', () => {
    for (const t of LIGHT_DISALLOWED_TOOLS) expect(args).toContain(t);
    expect(args).toContain('Read(//home/x/.ssh/**)');
    expect(args).toContain('Read(//**/.env*)');
  });
});

describe('a question', () => {
  it('is answered through its poll, then gone', async () => {
    let seenPrompt = '';
    const out = startOwnAsk(rec, 'how much?', { home, exec: (async (a: string[]) => { seenPrompt = a[1]; return done(); }) as never });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(seenPrompt).toContain('You watch the load.');
    expect(seenPrompt).toContain('how much?');
    expect(seenPrompt).not.toContain('thread');
    await tick();
    expect(readOwnAsk(rec.hash, out.id)).toEqual({ state: 'done', answer: 'ten' });
    expect(readOwnAsk(rec.hash, out.id)).toBeNull();
  });
  it('another app cannot read it', async () => {
    const out = startOwnAsk(rec, 'q', { home, exec: (async () => done()) as never });
    await tick();
    if (out.ok) expect(readOwnAsk('other', out.id)).toBeNull();
  });
  it('a failure is a code, never a crash', async () => {
    const out = startOwnAsk(rec, 'q', { home, exec: (async () => done({ exitCode: 1 })) as never });
    await tick();
    if (out.ok) expect(readOwnAsk(rec.hash, out.id)).toMatchObject({ state: 'failed', code: 'ask_failed' });
    const t = startOwnAsk(rec, 'q', { home, exec: (async () => done({ timedOut: true })) as never });
    await tick();
    if (t.ok) expect(readOwnAsk(rec.hash, t.id)).toMatchObject({ state: 'failed', code: 'ask_timeout' });
  });
  it('the fourth at once answers 429', () => {
    const hang = (() => new Promise(() => {})) as never;
    for (let i = 0; i < ASK_MAX_PER_APP; i++) expect(startOwnAsk(rec, 'q', { home, exec: hang }).ok).toBe(true);
    expect(startOwnAsk(rec, 'q', { home, exec: hang })).toMatchObject({ ok: false, status: 429 });
  });
  it('a minute holds at most twenty', () => {
    for (let i = 0; i < ASK_MAX_PER_MINUTE; i++) expect(askRoom('h', 1000)).toBeNull();
    expect(askRoom('h', 1000)).toMatchObject({ status: 429, code: 'ask_rate' });
    expect(askRoom('h', 70_000)).toBeNull();
  });
  it('a missing role or an empty question refuses', () => {
    expect(startOwnAsk(rec, '  ', { home })).toMatchObject({ ok: false, status: 400 });
    rmSync(join(rec.root, 'ASSISTANT.md'));
    expect(startOwnAsk(rec, 'q', { home })).toMatchObject({ ok: false, code: 'no_role' });
  });
});
