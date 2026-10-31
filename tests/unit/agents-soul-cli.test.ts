import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Command } from 'commander';
import { createProgram } from '../../src/cli/program.js';
import { getAgent, recordAgentLesson } from '../../src/lib/agents/store.js';
import { amendMember } from '../../src/lib/agents/amendments.js';
import { getRunTarget } from '../../src/lib/automations/store.js';
import { checkApproval } from '../../src/lib/automations/registry.js';
import { SOUL_TEMPLATE_IDS, soulTemplate } from '../../src/lib/agents/soul-templates.js';

/**
 * `agents create|edit --soul / --soul-file / --soul-template` and `agents show`, through the
 * real command tree, under a fake HOME (create approves on this machine).
 */

let projectRoot: string;
let contextRoot: string;
let cwd: string;
let realHome: string | undefined;
let fakeHome: string;

async function run(argv: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
  const err = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
  const warn = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
  process.exitCode = undefined;
  try {
    await createProgram().parseAsync(argv, { from: 'user' });
  } finally {
    log.mockRestore();
    err.mockRestore();
    warn.mockRestore();
  }
  const code = process.exitCode ?? 0;
  process.exitCode = undefined;
  return { code, out: lines.join('\n') };
}

function sub(name: string): Command {
  const agents = createProgram().commands.find((c) => c.name() === 'agents')!;
  return agents.commands.find((c) => c.name() === name)!;
}

const agentFile = (slug: string) => readFileSync(join(contextRoot, 'agents', `${slug}.md`), 'utf-8');

beforeEach(() => {
  // `agents edit` refuses a Claude session; the suite may itself run inside one.
  vi.stubEnv('CLAUDECODE', undefined as unknown as string);
  cwd = process.cwd();
  projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'dc-soul-cli-')));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
  process.chdir(projectRoot);
  realHome = process.env.HOME;
  fakeHome = mkdtempSync(join(tmpdir(), 'dc-soul-cli-home-'));
  process.env.HOME = fakeHome;
});

afterEach(() => {
  process.chdir(cwd);
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

describe('agents create --soul-template / --soul-file / --soul', () => {
  it('a template writes exactly its text, and nothing records which template it was', async () => {
    const { code } = await run(['agents', 'create', 'x', '--title', 'X', '--prompt', 'P', '--soul-template', 'harsh-reviewer']);
    expect(code).toBe(0);
    expect(getAgent(contextRoot, 'x')?.soul).toBe(soulTemplate('harsh-reviewer')!.text);
    expect(agentFile('x')).not.toContain('harsh-reviewer');
  });

  it('--soul-file reads the soul from a file', async () => {
    const file = join(projectRoot, 'soul.md');
    writeFileSync(file, 'Be calm.\n### Tone\nDry.\n');
    const { code } = await run(['agents', 'create', 'x', '--title', 'X', '--prompt', 'P', '--soul-file', file]);
    expect(code).toBe(0);
    expect(getAgent(contextRoot, 'x')?.soul).toBe('Be calm.\n### Tone\nDry.');
  });

  it('two soul flags fail with exit 1 and write nothing', async () => {
    const { code, out } = await run(['agents', 'create', 'x', '--title', 'X', '--prompt', 'P', '--soul', 'A', '--soul-template', 'fast-doer']);
    expect(code).toBe(1);
    expect(out).toContain('--soul, --soul-file and --soul-template');
    expect(getAgent(contextRoot, 'x')).toBeNull();
  });

  it('an unknown template exits 1 and names all five ids; --help lists them', async () => {
    const { code, out } = await run(['agents', 'create', 'x', '--title', 'X', '--prompt', 'P', '--soul-template', 'nope']);
    expect(code).toBe(1);
    for (const id of SOUL_TEMPLATE_IDS) expect(out).toContain(id);
    const help = sub('create').helpInformation();
    for (const id of SOUL_TEMPLATE_IDS) expect(help).toContain(id);
    expect(sub('edit').helpInformation()).toContain('--soul-template');
  });

  it('P8: a soul with a "## " line exits 1 and writes nothing', async () => {
    const { code } = await run(['agents', 'create', 'x', '--title', 'X', '--prompt', 'P', '--soul', 'Be terse.\n## Tone']);
    expect(code).toBe(1);
    expect(getAgent(contextRoot, 'x')).toBeNull();
  });
});

describe('agents edit and show', () => {
  it('edit --soul sets it, edit --soul "" clears it', async () => {
    await run(['agents', 'create', 'x', '--title', 'X', '--prompt', 'P']);
    expect((await run(['agents', 'edit', 'x', '--soul', 'Be calm.'])).code).toBe(0);
    expect(getAgent(contextRoot, 'x')?.soul).toBe('Be calm.');
    expect((await run(['agents', 'edit', 'x', '--soul', ''])).code).toBe(0);
    expect(getAgent(contextRoot, 'x')?.soul).toBe('');
    expect(agentFile('x')).not.toContain('## Soul');
  });

  it('show --json carries the soul and the parsed pattern; plain show prints both', async () => {
    await run(['agents', 'create', 'x', '--title', 'X', '--prompt', 'P', '--soul', 'Be calm.']);
    recordAgentLesson(contextRoot, 'x', { lesson: 'Check the date.', now: new Date('2026-10-01T09:00:00Z') });
    const json = await run(['agents', 'show', 'x', '--json']);
    const parsed = JSON.parse(json.out) as { agent: { soul: string; pattern: { playbook: string; lessons: unknown[] } } };
    expect(parsed.agent.soul).toBe('Be calm.');
    expect(parsed.agent.pattern).toEqual({ playbook: '', lessons: [{ date: '2026-10-01', text: 'Check the date.' }] });
    const plain = await run(['agents', 'show', 'x']);
    expect(plain.out).toContain('soul:');
    expect(plain.out).toContain('Be calm.');
    expect(plain.out).toContain('pattern: 1 lessons, playbook empty');
  });
});

describe('agents edit from a session', () => {
  beforeEach(async () => {
    await run(['agents', 'create', 'scout', '--title', 'Scout', '--prompt', 'Look around.']);
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it.each([
    ['--prompt', 'New text.'],
    ['--soul', 'Short sentences.'],
    ['--autonomy', 'free'],
    ['--model', 'opus'],
    ['--effort', 'max'],
    ['--whiteboard', 'home'],
  ])('%s is refused in a Claude session: an edit re-approves, and approving is the owner\'s', async (flag, value) => {
    vi.stubEnv('CLAUDECODE', '1');
    const before = agentFile('scout');
    const r = await run(['agents', 'edit', 'scout', flag, value]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('super team amend');
    expect(agentFile('scout')).toBe(before);
  });

  it('is refused for a member\'s own run too', async () => {
    vi.stubEnv('DREAMCONTEXT_AGENT_SELF', 'scout');
    expect((await run(['agents', 'edit', 'scout', '--prompt', 'I rewrite myself.'])).code).toBe(1);
  });

  it('still lets a session rename a member or place it in the team', async () => {
    vi.stubEnv('CLAUDECODE', '1');
    expect((await run(['agents', 'edit', 'scout', '--title', 'Finder', '--team', 'growth'])).code).toBe(0);
    expect(getAgent(contextRoot, 'scout')?.title).toBe('Finder');
  });

  it('the Super Agent\'s crew creates a member unapproved; no session deletes one', async () => {
    vi.stubEnv('CLAUDECODE', '1');
    vi.stubEnv('DREAMCONTEXT_SUPER_CREW', '1');
    const created = await run(['agents', 'create', 'newcomer', '--title', 'New', '--prompt', 'Hello.']);
    expect(created.code).toBe(0);
    expect(created.out).toContain('waits for the owner');
    const target = getRunTarget(contextRoot, 'newcomer', 'agent')!;
    expect(checkApproval(projectRoot, target, undefined, 'run').approved).toBe(false);
    expect((await run(['agents', 'remove', 'newcomer', '-y'])).code).toBe(1);
    expect(getAgent(contextRoot, 'newcomer')).not.toBeNull();
  });

  it('the crew cannot give the owner\'s yes to a question', async () => {
    const src = readFileSync(join(cwd, 'src', 'cli', 'commands', 'automations.ts'), 'utf-8');
    expect(src).toMatch(/answerFlowHitlQuestion[\s\S]{0,200}createNeedsOwner\(\)/);
  });

  it('the owner\'s own chat still approves what it creates: he is the one who wrote it', async () => {
    vi.stubEnv('CLAUDECODE', '1');
    expect((await run(['agents', 'create', 'helper', '--title', 'Helper', '--prompt', 'Hello.'])).code).toBe(0);
    expect(checkApproval(projectRoot, getRunTarget(contextRoot, 'helper', 'agent')!, undefined, 'run').approved).toBe(true);
  });

  it('the crew creates a routine unapproved too', async () => {
    vi.stubEnv('DREAMCONTEXT_SUPER_CREW', '1');
    const r = await run(['automations', 'create', 'scout-daily', '--title', 'Daily', '--agent', 'scout', '--job', 'Look.', '--days', 'daily', '--at', '09:00']);
    expect(r.out).toContain('waits for the owner');
    expect(checkApproval(projectRoot, getRunTarget(contextRoot, 'scout-daily', 'automation')!, undefined, 'run').approved).toBe(false);
  });

  it('works from the owner\'s terminal', async () => {
    expect((await run(['agents', 'edit', 'scout', '--prompt', 'New text.'])).code).toBe(0);
    expect(getAgent(contextRoot, 'scout')?.prompt).toBe('New text.');
  });

  it('`agents revert` is the owner\'s: a session is refused, and sees the history', async () => {
    const a = amendMember(contextRoot, { member: 'scout', why: 'A wording fix.', prompt: 'Look around twice.' });
    vi.stubEnv('CLAUDECODE', '1');
    expect((await run(['agents', 'revert', 'scout', a.id])).code).toBe(1);
    expect(getAgent(contextRoot, 'scout')?.prompt).toBe('Look around twice.');
    expect((await run(['agents', 'amendments', 'scout'])).out).toContain('A wording fix.');
    vi.unstubAllEnvs();
    vi.stubEnv('CLAUDECODE', undefined as unknown as string);
    expect((await run(['agents', 'revert', 'scout', a.id])).code).toBe(0);
    expect(getAgent(contextRoot, 'scout')?.prompt).toBe('Look around.');
  });
});
