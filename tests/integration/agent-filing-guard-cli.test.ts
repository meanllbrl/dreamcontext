import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInitTemplate, copyInitTemplate } from '../helpers/init-template.js';
import { SUPER_STATE_REL } from '../../src/lib/super/store.js';

/**
 * The awake-agent guard, end to end through the REAL binary (audit TK-1, TK-2). The unit test
 * proves the predicate; this proves `tasks create` reads the session from the env, counts the
 * board, finds a Super child on the super record, and refuses with the way out named.
 */

const CLI = join(__dirname, '..', '..', 'dist', 'index.js');
const INIT = 'init --yes --name "T" --description "d" --stack "Node" --priority "p"';
const AGENT = { CLAUDECODE: '1' };
const OWNER_WORDS = 'bunun için ayrı bir görev aç lütfen';
// The semantic gates need the on-disk model and a task index; a temp vault has neither, and this
// file must never load a model.
const NO_MODEL = { DREAMCONTEXT_FILING_BAR_SEMANTIC: '0' };
let root = '';

function cli(args: string, env: Record<string, string> = {}): { out: string; code: number } {
  try {
    const out = execSync(`node ${CLI} ${args} 2>&1`, {
      cwd: root, encoding: 'utf-8', timeout: 30000, env: { ...process.env, ...NO_MODEL, ...env },
    });
    return { out, code: 0 };
  } catch (e: any) {
    return { out: (e.stdout ?? '') + (e.stderr ?? ''), code: e.status ?? 1 };
  }
}
const taskText = (slug: string) => readFileSync(join(root, '_dream_context', 'state', `${slug}.md`), 'utf-8');

let initTemplate = '';
beforeAll(() => {
  initTemplate = buildInitTemplate(mkdtempSync(join(tmpdir(), 'dc-agent-guard-')), (dir) => {
    execSync(`node ${CLI} ${INIT}`, { cwd: dir, encoding: 'utf-8', timeout: 30000 });
  });
});
afterAll(() => rmSync(initTemplate, { recursive: true, force: true }));
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-agent-guard-'));
  copyInitTemplate(initTemplate, root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('tasks create inside an agent session', () => {
  it('the owner at his terminal is never held to the budget', () => {
    for (let i = 1; i <= 5; i++) expect(cli(`tasks create "owner task ${i}" -w "why" --by human`).code).toBe(0);
  });

  it('agents file 3 a day; the 4th is refused with the reason and the way out; his words file it', () => {
    for (let i = 1; i <= 3; i++) expect(cli(`tasks create "agent job number ${i}" -w "why"`, AGENT).code).toBe(0);
    const refused = cli('tasks create "agent job number 4" -w "why"', AGENT);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain('budget 3 a day');
    expect(refused.out).toContain('--owner-asked');
    expect(refused.out).toContain('dreamcontext config agent-task-budget <n>');

    const asked = cli(`tasks create "agent job number 4" -w "why" --owner-asked "${OWNER_WORDS}"`, AGENT);
    expect(asked.code).toBe(0);
    const body = taskText('agent-job-number-4');
    expect(body).toContain('filed_by: agent');
    expect(body).toContain('kind: ask');
    expect(body).toContain(OWNER_WORDS);
    // An owner-confirmed batch (the initializer's manifest) is never cut at the budget.
    for (let i = 5; i <= 8; i++) {
      expect(cli(`tasks create "agent job number ${i}" -w "why" --owner-asked "${OWNER_WORDS}"`, AGENT).code).toBe(0);
    }
    // And his asks spend nothing: the unasked count is still 3, so the next unasked one is refused.
    expect(cli('tasks create "agent job number 9" -w "why"', AGENT).code).toBe(1);
  });

  it('--by human inside an agent session is recorded as the agent it is, and counts', () => {
    for (let i = 1; i <= 3; i++) expect(cli(`tasks create "claimed human ${i}" -w "why" --by human`, AGENT).code).toBe(0);
    expect(taskText('claimed-human-1')).toContain('filed_by: agent');
    expect(cli('tasks create "claimed human 4" -w "why" --by human', AGENT).code).toBe(1);
  });

  it('the owner sets the budget; 0 refuses the first one', () => {
    expect(cli('config agent-task-budget 0').code).toBe(0);
    const r = cli('tasks create "anything at all" -w "why"', AGENT);
    expect(r.code).toBe(1);
    expect(r.out).toContain('agent task budget = 0');
    expect(cli('config agent-task-budget x').code).toBe(1);
  });

  it('an agent never opens a sub-task without the owner\'s words, a plan wave included', () => {
    expect(cli('tasks create "the parent job" -w "why" --by human').code).toBe(0);
    const sub = cli('tasks create "a slice of it" --parent the-parent-job', AGENT);
    expect(sub.code).toBe(1);
    expect(sub.out).toContain('dreamcontext tasks insert the-parent-job acceptance_criteria');
    const wave = cli('tasks create "Wave 1: part" --parent the-parent-job --basis plan --quote "W1 part"', AGENT);
    expect(wave.code).toBe(1);
    const asked = cli(`tasks create "a slice of it" --parent the-parent-job --owner-asked "${OWNER_WORDS}"`, AGENT);
    expect(asked.code).toBe(0);
    expect(taskText('a-slice-of-it')).toContain('parent_task: the-parent-job');
  });

  it('a Super Agent\'s child never files, and is told to ask the Super', () => {
    const child = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    writeFileSync(join(root, '_dream_context', SUPER_STATE_REL), JSON.stringify({
      session: '11111111-2222-3333-4444-555555555555', enabled: true, children: { [child]: { sessionId: child } },
    }));
    const r = cli('tasks create "my delegated job" -w "why"', { ...AGENT, DREAMCONTEXT_TAB_SESSION: child });
    expect(r.code).toBe(1);
    expect(r.out).toContain('Super Agent\'s child');
    expect(r.out).toContain('AskUserQuestion');
    // Somebody else's session in the same brain is not the child.
    expect(cli('tasks create "my delegated job" -w "why"', { ...AGENT, DREAMCONTEXT_TAB_SESSION: 'other' }).code).toBe(0);
  });
});
