/**
 * The Super Agent's handoff FILE (task super-agent-devrini-…): `dreamcontext super handoff`
 * writes `state/.super/handoff.md` + a pane-keyed record of kind `super`, refuses while a part is
 * missing or outside the handed-over super session, and the file never reads as a task. In the
 * super session `tasks handoff` refuses and points at `super handoff`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Command } from 'commander';
import { registerSuperCommand } from '../../src/cli/commands/super.js';
import { registerTasksCommand } from '../../src/cli/commands/tasks.js';
import { readHandoffRecord, handoffDir, renderHandoffBanner, handoffContinuePrompt } from '../../src/lib/context-watch.js';
import {
  MAX_ENTRIES, MAX_FIELD_BYTES, MAX_FILE_BYTES, SUPER_HANDOFF_REL, parseSuperHandoffEntries, renderSuperHandoffEntry, renderSuperHandoffFile,
} from '../../src/lib/super/handoff-file.js';
import { SUPER_STATE_REL } from '../../src/lib/super/store.js';
import { getTaskBackend } from '../../src/lib/task-backend/index.js';
import { buildBrainGitignore, FULL_REPO_LOCAL_GITIGNORE_ENTRIES } from '../../src/lib/git-sync/brain-repo.js';

const SUPER = '11111111-2222-3333-4444-555555555555';
const SES = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const STATE = [
  '--done', 'Two children merged into super/topic; build 4 installed, 163 files green.',
  '--next', 'c1 runs the JARVIS eval (wait for it), c2 fixes the voice skip; then build 5.',
  '--decisions', 'none',
  '--learned', 'super read --bytes shows the earlier reply.',
  '--style', 'Owner: Turkish, short, result first.',
  '--files', 'none',
];

let projectRoot: string;
let contextRoot: string;
let prevCwd: string;
let prevEnv: Record<string, string | undefined>;

async function cli(register: (p: Command) => void, ...argv: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  register(program);
  await program.parseAsync(['node', 'dreamcontext', ...argv]);
}
const superCli = (...a: string[]) => cli(registerSuperCommand, 'super', ...a);
const tasksCli = (...a: string[]) => cli(registerTasksCommand, 'tasks', ...a);
const filePath = () => join(contextRoot, SUPER_HANDOFF_REL);
const superRecord = (enabled = true) => writeFileSync(join(contextRoot, SUPER_STATE_REL), JSON.stringify({
  session: SUPER, enabled, children: { c1: { sessionId: 'c1' } },
}));
const recordFiles = () => (existsSync(handoffDir(contextRoot)) ? readdirSync(handoffDir(contextRoot)).filter((f) => f.endsWith('.json')) : []);

beforeEach(() => {
  const raw = join(tmpdir(), `dc-super-handoff-file-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  prevCwd = process.cwd();
  process.chdir(projectRoot);
  prevEnv = { DREAMCONTEXT_TAB_SESSION: process.env.DREAMCONTEXT_TAB_SESSION, CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID };
  process.env.DREAMCONTEXT_TAB_SESSION = SUPER;
  process.env.CLAUDE_CODE_SESSION_ID = SES;
  process.exitCode = 0;
  superRecord(true);
});
afterEach(() => {
  process.chdir(prevCwd);
  for (const [k, v] of Object.entries(prevEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  process.exitCode = 0;
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('super handoff', () => {
  it('writes the file and a pane-keyed super record, and touches no task', async () => {
    const before = readdirSync(join(contextRoot, 'state')).filter((f) => f.endsWith('.md'));
    await superCli('handoff', ...STATE, 'extra', 'note');
    expect(process.exitCode).toBe(0);
    const text = readFileSync(filePath(), 'utf-8');
    expect(text).toContain('type: super-handoff');
    expect(text).toContain('# Super Agent devri');
    expect(text).toContain('- **Done:** Two children merged');
    expect(text).toContain('- **Note:** extra note');
    const rec = readHandoffRecord(contextRoot, SUPER)!;
    expect(rec).toMatchObject({ kind: 'super', task: '.super/handoff', title: 'Super Agent', tab: SUPER, fromSession: SES });
    expect(readdirSync(join(contextRoot, 'state')).filter((f) => f.endsWith('.md'))).toEqual(before);
  });

  it('a second handoff goes on top; at most MAX_ENTRIES are kept', async () => {
    for (let i = 0; i < MAX_ENTRIES + 2; i++) {
      await superCli('handoff', ...STATE.map((v) => (v.startsWith('Two children') ? `${v} #${i}` : v)));
    }
    const entries = parseSuperHandoffEntries(readFileSync(filePath(), 'utf-8'));
    expect(entries).toHaveLength(MAX_ENTRIES);
    expect(entries[0]).toContain(`#${MAX_ENTRIES + 1}`);
    expect(entries[MAX_ENTRIES - 1]).toContain('#2');
  });

  it('refuses a missing part and writes nothing', async () => {
    await superCli('handoff', '--done', 'Two children merged into super/topic; build 4 installed.');
    expect(process.exitCode).toBe(1);
    expect(existsSync(filePath())).toBe(false);
    expect(recordFiles()).toEqual([]);
  });

  it('refuses outside the super session, and for a taken-back super', async () => {
    process.env.DREAMCONTEXT_TAB_SESSION = 'c1';
    process.env.CLAUDE_CODE_SESSION_ID = 'cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee';
    await superCli('handoff', ...STATE);
    expect(process.exitCode).toBe(1);
    expect(existsSync(filePath())).toBe(false);

    process.exitCode = 0;
    process.env.DREAMCONTEXT_TAB_SESSION = SUPER;
    superRecord(false);
    await superCli('handoff', ...STATE);
    expect(process.exitCode).toBe(1);
    expect(existsSync(filePath())).toBe(false);
    expect(recordFiles()).toEqual([]);
  });
});

describe('tasks handoff in the super session', () => {
  it('refuses, writes nothing, and names super handoff; a child still hands off into its task', async () => {
    process.env.DREAMCONTEXT_TAB_SESSION = 'c1';
    await tasksCli('create', 'Ship the thing', '-w', 'Because the thing must ship');
    const slug = 'ship-the-thing';
    const taskBefore = readFileSync(join(contextRoot, 'state', `${slug}.md`), 'utf-8');

    process.env.DREAMCONTEXT_TAB_SESSION = SUPER;
    const err: string[] = [];
    const out: string[] = [];
    const origErr = console.error; const origLog = console.log;
    console.error = (...a: unknown[]) => { err.push(a.join(' ')); };
    console.log = (...a: unknown[]) => { out.push(a.join(' ')); };
    try { await tasksCli('handoff', slug, ...STATE); } finally { console.error = origErr; console.log = origLog; }
    expect(process.exitCode).toBe(1);
    expect([...err, ...out].join('\n')).toContain('dreamcontext super handoff');
    expect(readFileSync(join(contextRoot, 'state', `${slug}.md`), 'utf-8')).toBe(taskBefore);
    expect(recordFiles()).toEqual([]);

    process.exitCode = 0;
    process.env.DREAMCONTEXT_TAB_SESSION = 'c1';
    await tasksCli('handoff', slug, ...STATE);
    expect(process.exitCode).toBe(0);
    expect(readHandoffRecord(contextRoot, 'c1')?.task).toBe(slug);
  });
});

describe('the file is never a task and never syncs', () => {
  it('the task backend does not list it', async () => {
    await superCli('handoff', ...STATE);
    const list = await getTaskBackend(contextRoot, null).list();
    expect(list.map((t) => t.slug)).not.toContain('handoff');
    expect(list).toHaveLength(0);
  });

  it('state/.super/ is in both local-only lists', () => {
    expect(buildBrainGitignore().split('\n')).toContain('state/.super/');
    expect(FULL_REPO_LOCAL_GITIGNORE_ENTRIES).toContain('_dream_context/state/.super/');
  });
});

describe('the file format', () => {
  it('caps a field at MAX_FIELD_BYTES and keeps the newest entry under the byte cap', () => {
    const huge = 'x'.repeat(MAX_FIELD_BYTES * 3);
    const entry = renderSuperHandoffEntry('2026-10-22T10:00:00.000Z', { done: huge, next: huge, decisions: huge, learned: huge, style: huge, files: huge });
    expect(entry).toContain('…(kısaltıldı)');
    const many = Array.from({ length: MAX_ENTRIES }, () => entry);
    const text = renderSuperHandoffFile(many, '2026-10-22T10:00:00.000Z');
    expect(Buffer.byteLength(text, 'utf-8')).toBeLessThanOrEqual(MAX_FILE_BYTES);
    expect(parseSuperHandoffEntries(text).length).toBeGreaterThanOrEqual(1);
  });
});

describe('every written entry reads back', () => {
  it('refuses a block the parser would drop on the next write, and keeps history across writes', async () => {
    const { writeSuperHandoff } = await import('../../src/lib/super/handoff-file.js');
    expect(() => writeSuperHandoff(contextRoot, ['### 2026-10-21 - Session Update\n- something'])).toThrow(/ONE/);
    expect(() => writeSuperHandoff(contextRoot, ['## 2026-10-21 - Handoff\n- hyphen, not the dash'])).toThrow(/ONE/);
    expect(existsSync(filePath())).toBe(false);
    // The one-time migration shape: older entries written oldest-last, then a real handoff on top.
    const old = ['## 2026-10-21T23:00:00.000Z — Handoff\r\n- **Note:** end of day', '## 2026-10-21T06:00:00.000Z — Handoff\n- **Done:** 0.32.0 out'];
    writeSuperHandoff(contextRoot, old);
    await superCli('handoff', ...STATE);
    const entries = parseSuperHandoffEntries(readFileSync(filePath(), 'utf-8'));
    expect(entries).toHaveLength(3);
    expect(entries[1]).toContain('end of day');
    expect(entries[2]).toContain('0.32.0 out');
  });

  it('caps a field by UTF-8 bytes, never splitting a character', () => {
    const wide = '界'.repeat(MAX_FIELD_BYTES);
    const entry = renderSuperHandoffEntry('2026-10-22T10:00:00.000Z', { done: wide, next: '🙂'.repeat(MAX_FIELD_BYTES) });
    for (const line of entry.split('\n').slice(1, 3)) expect(Buffer.byteLength(line, 'utf-8')).toBeLessThanOrEqual(MAX_FIELD_BYTES + 32);
    expect(entry).not.toMatch(/\uFFFD/);
    expect(entry.includes('\uD83D…')).toBe(false);
  });

  it('refuses to write through a symlinked state/.super and adds the local-only line on first creation', async () => {
    const { symlinkSync } = await import('node:fs');
    const elsewhere = join(projectRoot, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(contextRoot, 'state', '.super'));
    await superCli('handoff', ...STATE);
    expect(process.exitCode).toBe(1);
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(recordFiles()).toEqual([]);
    rmSync(join(contextRoot, 'state', '.super'));
    process.exitCode = 0;
    await superCli('handoff', ...STATE);
    expect(process.exitCode).toBe(0);
    expect(readFileSync(join(projectRoot, '.gitignore'), 'utf-8')).toContain('_dream_context/state/.super/');
  });
});

describe('the super record\'s banner and continue prompt', () => {
  const rec = { task: '.super/handoff', title: 'Super Agent', kind: 'super' as const, at: '2026-10-22T10:00:00.000Z', contextTokens: 780_000, fromSession: SES, tab: SUPER };
  it('name the file and super state, never a task', () => {
    const banner = renderHandoffBanner(rec);
    expect(banner).toContain('_dream_context/state/.super/handoff.md');
    expect(banner).toContain('super state');
    expect(banner).not.toContain('continuing task');
    const prompt = handoffContinuePrompt(rec);
    expect(prompt).toContain('_dream_context/state/.super/handoff.md');
    expect(prompt).toContain('dreamcontext super state');
    expect(prompt).not.toContain('continue task');
    expect(handoffContinuePrompt(rec, { fallback: true })).toContain('wrote none this time');
  });
  it('a task record keeps today\'s prompt and banner', () => {
    const task = { ...rec, kind: undefined, task: 'ship-the-thing', title: 'Ship the thing' };
    expect(handoffContinuePrompt(task)).toBe('Handoff: continue task Ship the thing (ship-the-thing). Read _dream_context/state/ship-the-thing.md first, then carry on from its latest changelog entry.');
    expect(renderHandoffBanner(task)).toContain('>> HANDOFF: continuing task Ship the thing (ship-the-thing)');
  });
});
