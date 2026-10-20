/**
 * `dreamcontext agents …`, the self-approval guard and `tasks assign-agent`, through the BUILT
 * CLI (`dist/index.js`), against a scratch project and HOME. `claude` is unreachable by
 * construction (SAFE_PATH), so a run that gets as far as a spawn ends `failed` deterministically,
 * with zero real API calls.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { AGENT_BOARD_ENV, AGENT_SCRATCH_ENV, AGENT_SELF_ENV } from '../../src/lib/automations/types.js';

const CLI = join(__dirname, '..', '..', 'dist', 'index.js');
const SAFE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

function makeTmpDir(prefix: string): string {
  const raw = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  return realpathSync(raw);
}

interface RunResult { stdout: string; exitCode: number }

/** A clean env: none of the self-approval or scope vars leak in from the shell running the suite. */
function run(args: string[], cwd: string, home: string, extraEnv: Record<string, string> = {}): RunResult {
  const inherited = { ...process.env };
  for (const k of [AGENT_SELF_ENV, AGENT_BOARD_ENV, AGENT_SCRATCH_ENV, 'CLAUDECODE', 'DREAMCONTEXT_AUTOMATION_RUN']) delete inherited[k];
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      cwd,
      encoding: 'utf-8',
      timeout: 30_000,
      env: { ...inherited, HOME: home, USERPROFILE: home, PATH: SAFE_PATH, ...extraEnv },
    });
    return { stdout, exitCode: 0 };
  } catch (e: any) {
    return { stdout: (e.stdout ?? '') + (e.stderr ?? ''), exitCode: typeof e.status === 'number' ? e.status : 1 };
  }
}

let home: string;
let base: string;
let projectDir: string;

beforeEach(() => {
  home = makeTmpDir('dc-agents-cli-home');
  base = makeTmpDir('dc-agents-cli-base');
  projectDir = join(base, 'proj');
  mkdirSync(join(projectDir, '_dream_context', 'state'), { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(base, { recursive: true, force: true });
});

const SELF_ENVS: Record<string, string>[] = [
  { CLAUDECODE: '1' },
  { [AGENT_SELF_ENV]: 'scout' },
  { DREAMCONTEXT_AUTOMATION_RUN: '2026-10-12T09:00:00.000Z' },
];

function seedTask(slug: string, status = 'todo'): string {
  const path = join(projectDir, '_dream_context', 'state', `${slug}.md`);
  writeFileSync(path, ['---', 'id: task_t1', 'name: Fix login', `status: ${status}`, 'created_at: "2026-10-01"', 'updated_at: "2026-10-01"', '---', '', '## Changelog', ''].join('\n'));
  return path;
}

describe('agents CLI', () => {
  it('create → list → show → edit, approved on this machine', () => {
    const c = run(['agents', 'create', 'scout', '--title', 'Scout', '--prompt', 'Scout the market.'], projectDir, home);
    expect(c.exitCode).toBe(0);
    expect(existsSync(join(projectDir, '_dream_context', 'agents', 'scout.md'))).toBe(true);

    const list = run(['agents', 'list', '--json'], projectDir, home);
    expect(list.exitCode).toBe(0);
    expect(JSON.parse(list.stdout).agents).toEqual([
      expect.objectContaining({ slug: 'scout', approvedForChat: true, approvedToRun: true }),
    ]);

    const e = run(['agents', 'edit', 'scout', '--prompt', 'Scout harder.'], projectDir, home);
    expect(e.exitCode).toBe(0);
    const show = run(['agents', 'show', 'scout', '--json'], projectDir, home);
    expect(JSON.parse(show.stdout).agent).toMatchObject({ prompt: 'Scout harder.', approvedToRun: true });
  });

  it('has no flag that edits call settings', () => {
    run(['agents', 'create', 'scout', '--title', 'Scout', '--prompt', 'p'], projectDir, home);
    for (const flag of ['--timeout', '--output-dir', '--review']) {
      expect(run(['agents', 'edit', 'scout', flag, 'x'], projectDir, home).exitCode).not.toBe(0);
    }
  });
});

describe('the self-approval guard', () => {
  it('agents approve and automations approve both refuse under each env var, naming the Agents page and no command', () => {
    run(['agents', 'create', 'scout', '--title', 'Scout', '--prompt', 'p'], projectDir, home);
    run(['automations', 'create', 'digest', '--title', 'Digest', '--days', 'daily', '--at', '18:00'], projectDir, home);
    for (const env of SELF_ENVS) {
      for (const args of [['agents', 'approve', 'scout', '--yes'], ['automations', 'approve', 'digest', '--yes']]) {
        const out = run(args, projectDir, home, env);
        expect(out.exitCode, `${args.join(' ')} under ${Object.keys(env)[0]}`).toBe(1);
        expect(out.stdout).toContain('AI Team page');
        expect(out.stdout).not.toMatch(/dreamcontext \w+ approve/);
      }
    }
  });
});

/**
 * `automations answer <id> approve` is approving too. Mutations checked:
 *  - drop the `refuseSelfApproval` guard in `answerApprovalQuestion` ⇒ the answer exits 0 or
 *    claims the question, and the "still pending" assertion fails;
 *  - the questions hint printing the approve line regardless of the shell ⇒ the in-session
 *    listing assertion fails; never printing it ⇒ the owner-shell assertion fails.
 */
describe('answering an approval question', () => {
  function seedApprovalQuestion(): string {
    run(['automations', 'create', 'digest', '--title', 'Digest', '--days', 'daily', '--at', '18:00'], projectDir, home);
    const dir = join(projectDir, '_dream_context', 'automations', 'hitl', 'digest');
    mkdirSync(dir, { recursive: true });
    const id = 'q_test1';
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({
      id, slug: 'digest', runFiredAt: '2026-10-12T09:00:00.000Z', sessionId: null, kind: 'approval', channel: 'chat',
      question: 'Digest was edited. Approve it?', choices: ['approve', 'not now'], state: 'pending', answeredAt: null,
      answeredVia: null, answer: null, resolutionNote: null, resolutionError: null, steers: [], channelRefs: {},
      createdAt: '2026-10-12T09:00:00.000Z',
    }));
    return id;
  }

  it('refuses approve inside a session or an agent run, naming the Agents page; the question stays open', () => {
    const id = seedApprovalQuestion();
    for (const env of SELF_ENVS) {
      const out = run(['automations', 'answer', id, 'approve'], projectDir, home, env);
      expect(out.exitCode, `answer approve under ${Object.keys(env)[0]}`).toBe(1);
      expect(out.stdout).toContain('AI Team page');
      expect(out.stdout).not.toMatch(/dreamcontext \w+ (approve|answer)/);
    }
    const listed = run(['automations', 'questions', 'digest'], projectDir, home, { CLAUDECODE: '1' });
    expect(listed.stdout).toContain(id);
    expect(listed.stdout).not.toContain('automations answer');
    expect(listed.stdout).toContain('page in the dashboard');
    // The owner's shell still gets the line.
    expect(run(['automations', 'questions', 'digest'], projectDir, home).stdout).toContain(`automations answer ${id} approve`);
  });
});

/**
 * An approval question an agent call-target run asked on a same-slug pair. Mutation checked:
 * `answerApprovalQuestion` resolving the slug with `getAutomation` approves the JOB and leaves the
 * agent unapproved, failing both approval assertions.
 */
describe("answering an agent target's approval question from the owner's shell", () => {
  it('approves the agent, never the job, and does not re-run without a recorded task', () => {
    run(['agents', 'create', 'scout', '--title', 'Scout', '--prompt', 'Scout the market.'], projectDir, home);
    run(['automations', 'create', 'scout', '--title', 'Scout daily', '--agent', 'scout', '--days', 'daily', '--at', '09:00'], projectDir, home);
    const agentFile = join(projectDir, '_dream_context', 'agents', 'scout.md');
    writeFileSync(agentFile, readFileSync(agentFile, 'utf-8').replace('Scout the market.', 'Scout every market.'));
    const dir = join(projectDir, '_dream_context', 'automations', 'hitl', 'scout');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'q_agent1.json'), JSON.stringify({
      id: 'q_agent1', slug: 'scout', target: 'agent', runFiredAt: '2026-10-12T09:00:00.000Z', sessionId: null,
      kind: 'approval', channel: 'chat', question: 'Scout was edited. Approve it?', choices: ['approve', 'not now'],
      state: 'pending', answeredAt: null, answeredVia: null, answer: null, resolutionNote: null, resolutionError: null,
      steers: [], channelRefs: {}, createdAt: '2026-10-12T09:00:00.000Z',
    }));
    expect(JSON.parse(run(['agents', 'show', 'scout', '--json'], projectDir, home).stdout).agent.approvedToRun).toBe(false);

    const out = run(['automations', 'answer', 'q_agent1', 'approve'], projectDir, home);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain('did not run again');
    expect(JSON.parse(run(['agents', 'show', 'scout', '--json'], projectDir, home).stdout).agent.approvedToRun).toBe(true);
    expect(run(['automations', 'show', 'scout'], projectDir, home).stdout).toMatch(/approval: NOT approved/);
  });
});

/**
 * D5: `automations share <slug>` on a split automation publishes its agent too; `unshare` leaves
 * the agent published. Mutation checked: dropping `sharedAgentOpts(...)` from the `share` command's
 * `shareAutomation` call leaves `!agents/scout.md` out of the brain `.gitignore`, failing this.
 */
describe('automations share on a split automation', () => {
  it('shares the agent it runs as, and unshare leaves the agent shared', () => {
    run(['agents', 'create', 'scout', '--title', 'Scout', '--prompt', 'p'], projectDir, home);
    run(['automations', 'create', 'scout-daily', '--title', 'Scout daily', '--agent', 'scout', '--days', 'daily', '--at', '09:00'], projectDir, home);
    const gitignore = join(projectDir, '_dream_context', '.gitignore');
    const agentLine = /^!agents\/scout\.md$/m;
    expect(existsSync(gitignore) ? readFileSync(gitignore, 'utf-8') : '').not.toMatch(agentLine);

    const agentShared = () => JSON.parse(run(['agents', 'show', 'scout', '--json'], projectDir, home).stdout).agent.shared;
    expect(agentShared()).toBe(false);

    expect(run(['automations', 'share', 'scout-daily'], projectDir, home).exitCode).toBe(0);
    expect(readFileSync(gitignore, 'utf-8')).toMatch(agentLine);
    // Published AND flagged: mutation checked, dropping `setAgentShared` in `shareWithAgent` fails here.
    expect(agentShared()).toBe(true);

    expect(run(['automations', 'unshare', 'scout-daily', '--yes'], projectDir, home).exitCode).toBe(0);
    const after = readFileSync(gitignore, 'utf-8');
    expect(after).not.toMatch(/^!automations\/scout-daily\.md$/m);
    expect(after).toMatch(agentLine);
    expect(agentShared()).toBe(true);
  });
});

/**
 * An agent-target approval question whose agent was deleted. Mutation checked: restoring the
 * early "not found" return before the decision is read makes `reject` fail, and the question
 * stays open.
 */
describe('an approval question whose agent is gone', () => {
  it('approve is refused plainly; reject claims and closes it', () => {
    const dir = join(projectDir, '_dream_context', 'automations', 'hitl', 'ghost');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'q_ghost1.json'), JSON.stringify({
      id: 'q_ghost1', slug: 'ghost', target: 'agent', runFiredAt: '2026-10-12T09:00:00.000Z', sessionId: null,
      kind: 'approval', channel: 'chat', question: 'Ghost was edited. Approve it?', choices: ['approve', 'not now'],
      state: 'pending', answeredAt: null, answeredVia: null, answer: null, resolutionNote: null, resolutionError: null,
      steers: [], channelRefs: {}, createdAt: '2026-10-12T09:00:00.000Z',
    }));
    const approve = run(['automations', 'answer', 'q_ghost1', 'approve'], projectDir, home);
    expect(approve.exitCode).toBe(1);
    expect(approve.stdout).toContain('no longer exists');
    expect(run(['automations', 'questions'], projectDir, home).stdout).toContain('q_ghost1');

    expect(run(['automations', 'answer', 'q_ghost1', 'reject'], projectDir, home).exitCode).toBe(0);
    expect(run(['automations', 'questions'], projectDir, home).stdout).not.toContain('q_ghost1');
  });
});

describe('tasks assign-agent', () => {
  it('assigns, moves an open task, runs the agent and logs one result line', () => {
    run(['agents', 'create', 'scout', '--title', 'Scout', '--prompt', 'p'], projectDir, home);
    const path = seedTask('fix-login');
    const out = run(['tasks', 'assign-agent', 'fix-login', 'scout', '--note', 'Start with the tests.'], projectDir, home);
    // claude is unreachable here, so the run itself fails — after the assignment landed.
    expect(out.stdout).toContain('Assigned fix-login to Scout');
    const text = readFileSync(path, 'utf-8');
    expect(text).toMatch(/^agent: scout$/m);
    expect(text).toMatch(/^status: in_progress$/m);
    expect(text.match(/- Run [^\n]*: \w[\w-]*\. Document: /g)).toHaveLength(1);
  });

  it('refuses inside an agent run, writing nothing', () => {
    run(['agents', 'create', 'scout', '--title', 'Scout', '--prompt', 'p'], projectDir, home);
    const path = seedTask('fix-login');
    const before = readFileSync(path, 'utf-8');
    for (const env of [{ [AGENT_SELF_ENV]: 'scout' }, { DREAMCONTEXT_AUTOMATION_RUN: '2026-10-12T09:00:00.000Z' }]) {
      const out = run(['tasks', 'assign-agent', 'fix-login', 'scout'], projectDir, home, env);
      expect(out.exitCode).toBe(1);
    }
    expect(readFileSync(path, 'utf-8')).toBe(before);
  });

  it('refuses an agent not approved to run, naming the Agents page', () => {
    mkdirSync(join(projectDir, '_dream_context', 'agents'), { recursive: true });
    writeFileSync(join(projectDir, '_dream_context', 'agents', 'writer.md'), '---\nid: agt_w1\ntitle: Writer\n---\n\n## Prompt\n\nWrite.\n');
    seedTask('fix-login');
    const out = run(['tasks', 'assign-agent', 'fix-login', 'writer'], projectDir, home);
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain('Approve it on the AI Team page.');
  });
});
