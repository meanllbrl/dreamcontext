import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import matter from 'gray-matter';
import { createProgram } from '../../src/cli/program.js';
import { listAgents, withRestamp } from '../../src/lib/agents/store.js';
import { membersNamedIn } from '../../src/lib/agents/member-mention.js';
import { getAutomation, readManifestParts, automationPath } from '../../src/lib/automations/store.js';
import { checkApproval } from '../../src/lib/automations/registry.js';
import { createNeedsOwner } from '../../src/lib/automations/types.js';
import { buildStageView } from '../../src/server/routes/agents.js';
import { routineOf, type TeamAutomation } from '../../dashboard/src/components/aiteam/teamModel.js';
import { isAutomationRow, type AutomationSummary } from '../../dashboard/src/hooks/useAutomations.js';

/**
 * Extending an existing AI Team member must never make a second one (owner 2026-11-17): a bare
 * `automations create` that names a member is refused with the member's routine command, an agent
 * session must ask for a new member out loud (`--new-member`), a member can own an ON-CALL routine
 * (`--agent <m> --mode call`), and a duplicate already made is re-attached in place
 * (`automations edit <slug> --agent <m>`), keeping its slug, id and schedule and never approving
 * itself from a run. Fictional vault: member `ada` (Ada, a kitchen planner).
 */

let projectRoot: string;
let contextRoot: string;
let cwd: string;
let realHome: string | undefined;
let fakeHome: string;

async function run(argv: string[], env: Record<string, string | undefined> = {}): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
  const err = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
  const warn = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v as string);
  process.exitCode = undefined;
  try {
    await createProgram().parseAsync(argv, { from: 'user' });
  } finally {
    log.mockRestore();
    err.mockRestore();
    warn.mockRestore();
    for (const k of Object.keys(env)) vi.stubEnv(k, undefined as unknown as string);
  }
  const code = process.exitCode ?? 0;
  process.exitCode = undefined;
  return { code, out: lines.join('\n') };
}

const memberSlugs = () => listAgents(contextRoot, fakeHome).map((a) => a.slug);
const file = (slug: string) => readFileSync(automationPath(contextRoot, slug), 'utf-8');
const approved = (slug: string) => checkApproval(projectRoot, getAutomation(contextRoot, slug)!, undefined, 'run').approved;
const faceOf = (text: string) => matter(text).data.face as unknown;
const promptFile = (text: string) => { const p = join(projectRoot, 'prompt.md'); writeFileSync(p, text); return p; };

beforeEach(async () => {
  // The suite may run inside a Claude or Codex session: every test starts as the owner's shell.
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'DREAMCONTEXT_VIA_BRAIN_MCP', 'DREAMCONTEXT_AUTOMATION_RUN', 'DREAMCONTEXT_AGENT_SELF']) {
    vi.stubEnv(k, undefined as unknown as string);
  }
  cwd = process.cwd();
  projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'dc-member-routine-')));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  process.chdir(projectRoot);
  realHome = process.env.HOME;
  fakeHome = realpathSync(mkdtempSync(join(tmpdir(), 'dc-member-routine-home-')));
  process.env.HOME = fakeHome;
  expect((await run(['agents', 'create', 'ada', '--title', 'Ada', '--prompt', 'You plan the kitchen: shopping, menus, orders.'])).code).toBe(0);
});

afterEach(() => {
  vi.unstubAllEnvs();
  process.chdir(cwd);
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

describe('membersNamedIn: exact, never fuzzy', () => {
  it('names a member by slug, display name or file path; a longer word or another word does not', async () => {
    expect((await run(['agents', 'create', 'pastry', '--title', 'Chef Bruno', '--prompt', 'Bakes.'])).code).toBe(0);
    expect(membersNamedIn(contextRoot, ['Ask chef bruno for a cake'], fakeHome)).toEqual([{ slug: 'pastry', title: 'Chef Bruno', via: 'name' }]);
    expect(membersNamedIn(contextRoot, ["You are Ada's helper"], fakeHome).map((m) => m.via)).toEqual(['slug']);
    expect(membersNamedIn(contextRoot, ['identity: _dream_context/agents/ada.md'], fakeHome).map((m) => m.via)).toEqual(['path']);
    expect(membersNamedIn(contextRoot, ['ADA: order lunch'], fakeHome)).toHaveLength(1);
    expect(membersNamedIn(contextRoot, ['ada-notes and adamant and Canada'], fakeHome)).toEqual([]);
    expect(membersNamedIn(contextRoot, ['Weekly digest of the repo'], fakeHome)).toEqual([]);
  });
});

describe('automations create without --agent', () => {
  it('refuses when the prompt names an existing member, prints the member routine command, writes nothing', async () => {
    const r = await run(['automations', 'create', 'ada-lunch', '--title', 'Order lunch', '--mode', 'call',
      '--prompt-file', promptFile('You are Ada; your identity is in _dream_context/agents/ada.md. Order lunch.')]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('automations create ada-lunch --agent ada --title "Order lunch"');
    expect(r.out).toContain('--mode call');
    expect(existsSync(automationPath(contextRoot, 'ada-lunch'))).toBe(false);
    expect(memberSlugs()).toEqual(['ada']);
  });

  it('refuses when the title names the member, from the owner shell too, with its schedule in the suggestion', async () => {
    const r = await run(['automations', 'create', 'ada-shop', '--title', 'Ada weekly shopping', '--slot', 'sat@09:00']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('--agent ada');
    expect(r.out).toContain('--slot "sat@09:00"');
  });

  it('an agent session must ask for a new member; --new-member passes, and the owner shell is unchanged', async () => {
    const asAgent = await run(['automations', 'create', 'repo-digest', '--title', 'Repo digest', '--slot', 'daily@18:00'], { CLAUDECODE: '1' });
    expect(asAgent.code).toBe(1);
    expect(asAgent.out).toContain('NEW AI Team member');
    expect(existsSync(automationPath(contextRoot, 'repo-digest'))).toBe(false);
    for (const env of [{ CODEX_THREAD_ID: 't-1' }, { DREAMCONTEXT_VIA_BRAIN_MCP: '1' }]) {
      expect((await run(['automations', 'create', 'repo-digest', '--title', 'Repo digest', '--slot', 'daily@18:00'], env)).code).toBe(1);
    }

    const meant = await run(['automations', 'create', 'repo-digest', '--title', 'Repo digest', '--slot', 'daily@18:00', '--new-member'], { CLAUDECODE: '1' });
    expect(meant.code).toBe(0);
    expect(memberSlugs()).toEqual(['ada', 'repo-digest']);

    expect((await run(['automations', 'create', 'notes-tidy', '--title', 'Tidy notes', '--slot', 'daily@08:00'])).code).toBe(0);
    expect(memberSlugs()).toContain('notes-tidy');
  });
});

describe('a member owns an on-call routine', () => {
  it('--agent ada --mode call: a routine of Ada with no schedule, never a second member', async () => {
    const r = await run(['automations', 'create', 'ada-lunch', '--agent', 'ada', '--mode', 'call', '--title', 'Order lunch', '--job', 'Order lunch from the usual place.']);
    expect(r.code).toBe(0);
    const parts = readManifestParts(automationPath(contextRoot, 'ada-lunch'));
    expect(parts.kind).toBe('bound');
    if (parts.kind === 'bound') {
      expect(parts.job).toMatchObject({ agent: 'ada', mode: 'call', schedule: null, job: 'Order lunch from the usual place.' });
    }
    expect(memberSlugs()).toEqual(['ada']);
    expect(approved('ada-lunch')).toBe(true);
  });

  it('the AI Team lists it under Ada (stage and page); a file of its own you only call stays the member itself', async () => {
    expect((await run(['automations', 'create', 'ada-lunch', '--agent', 'ada', '--mode', 'call', '--title', 'Order lunch', '--job', 'Order lunch.'])).code).toBe(0);
    expect(buildStageView(contextRoot, 'ada')?.routines.map((r) => r.slug)).toEqual(['ada-lunch']);
    const row = (over: Partial<TeamAutomation>): TeamAutomation => ({ slug: 'ada-lunch', title: 'Order lunch', agent: 'ada', runKind: 'automation', mode: 'call', enabled: true, approved: true, ...over } as TeamAutomation);
    expect(routineOf(row({}), 'ada')).toBe(true);
    expect(routineOf(row({ slug: 'helper', agent: 'helper' }), 'helper')).toBe(false);
    expect(routineOf(row({ slug: 'helper', agent: undefined }), 'helper')).toBe(false);
    expect(routineOf(row({ mode: 'sched', slug: 'digest', agent: 'digest' }), 'digest')).toBe(true);
    expect(isAutomationRow(row({}) as unknown as AutomationSummary)).toBe(true);
    expect(isAutomationRow(row({ slug: 'helper', agent: 'helper' }) as unknown as AutomationSummary)).toBe(false);
    // The member's own name is the member: an on-call routine needs a name of its own.
    expect((await run(['automations', 'create', 'ada', '--agent', 'ada', '--mode', 'call', '--title', 'Ada'])).code).toBe(1);
  });

  it('refuses a schedule on an on-call routine', async () => {
    const r = await run(['automations', 'create', 'ada-lunch', '--agent', 'ada', '--mode', 'call', '--title', 'Order lunch', '--slot', 'daily@12:00']);
    expect(r.code).toBe(1);
    expect(existsSync(automationPath(contextRoot, 'ada-lunch'))).toBe(false);
  });
});

describe('automations edit --agent: re-attach in place', () => {
  async function seedDuplicate(slug: string, args: string[]): Promise<void> {
    // The mistake as it was made: a member of its own whose prompt names Ada (passed with --new-member).
    const r = await run(['automations', 'create', slug, '--title', 'Kitchen run', ...args, '--new-member',
      '--prompt-file', promptFile('You are Ada (_dream_context/agents/ada.md). Plan the run.')]);
    expect(r.code).toBe(0);
  }

  it('keeps slug, id, face and schedule; the prompt becomes the job; the duplicate member is gone; still approved from the owner shell', async () => {
    await seedDuplicate('kitchen-run', ['--slot', 'mon@10:00']);
    expect(memberSlugs()).toEqual(['ada', 'kitchen-run']);
    const before = getAutomation(contextRoot, 'kitchen-run')!;
    const faceBefore = faceOf(file('kitchen-run'));
    expect(faceBefore).toBeTruthy();
    expect(approved('kitchen-run')).toBe(true);

    const r = await run(['automations', 'edit', 'kitchen-run', '--agent', 'ada']);
    expect(r.code, r.out).toBe(0);
    const after = getAutomation(contextRoot, 'kitchen-run')!;
    expect(after).toMatchObject({ id: before.id, agent: 'ada', mode: 'sched', job: 'You are Ada (_dream_context/agents/ada.md). Plan the run.' });
    expect(after.schedule).toEqual(before.schedule);
    expect(faceOf(file('kitchen-run'))).toEqual(faceBefore);
    expect(file('kitchen-run')).not.toContain('## Prompt');
    expect(memberSlugs()).toEqual(['ada']);
    expect(approved('kitchen-run')).toBe(true);
  });

  it('an on-call duplicate becomes Ada\'s on-call routine', async () => {
    await seedDuplicate('kitchen-order', ['--mode', 'call']);
    expect((await run(['automations', 'edit', 'kitchen-order', '--agent', 'ada'])).code).toBe(0);
    expect(getAutomation(contextRoot, 'kitchen-order')).toMatchObject({ agent: 'ada', mode: 'call', schedule: null });
    expect(memberSlugs()).toEqual(['ada']);
  });

  it('never approves itself from an agent run, and a routine that was never approved stays unapproved', async () => {
    await seedDuplicate('kitchen-run', ['--slot', 'mon@10:00']);
    const runEnv = { DREAMCONTEXT_AUTOMATION_RUN: '2026-11-17T09:00:00.000Z' };
    vi.stubEnv('DREAMCONTEXT_AUTOMATION_RUN', runEnv.DREAMCONTEXT_AUTOMATION_RUN);
    expect(createNeedsOwner()).toBe(true);
    vi.stubEnv('DREAMCONTEXT_AUTOMATION_RUN', undefined as unknown as string);
    const r = await run(['automations', 'edit', 'kitchen-run', '--agent', 'ada'], runEnv);
    expect(r.code, r.out).toBe(0);
    expect(approved('kitchen-run')).toBe(false);

    // Unapproved before (a hand edit moved its hash): the owner shell does not approve it either.
    await seedDuplicate('kitchen-order', ['--mode', 'call']);
    writeFileSync(automationPath(contextRoot, 'kitchen-order'), file('kitchen-order').replace('Plan the run.', 'Plan the run now.'));
    expect(approved('kitchen-order')).toBe(false);
    expect((await run(['automations', 'edit', 'kitchen-order', '--agent', 'ada'])).code).toBe(0);
    expect(approved('kitchen-order')).toBe(false);
  });

  it('refuses while something else still leans on the duplicate member, and refuses an unknown member', async () => {
    await seedDuplicate('kitchen-run', ['--slot', 'mon@10:00']);
    expect((await run(['automations', 'create', 'kitchen-extra', '--agent', 'kitchen-run', '--title', 'Extra', '--slot', 'tue@10:00'])).code).toBe(0);
    const r = await run(['automations', 'edit', 'kitchen-run', '--agent', 'ada']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('routine kitchen-extra');
    expect((await run(['automations', 'edit', 'kitchen-extra', '--agent', 'nobody'])).code).toBe(1);
  });

  it('--no-agent detaches into its own member; an agent session must add --new-member', async () => {
    expect((await run(['automations', 'create', 'ada-shop', '--agent', 'ada', '--title', 'Shopping', '--job', 'Write the list.', '--slot', 'sat@09:00'])).code).toBe(0);
    expect((await run(['automations', 'edit', 'ada-shop', '--no-agent'], { CLAUDECODE: '1' })).code).toBe(1);
    expect(getAutomation(contextRoot, 'ada-shop')?.agent).toBe('ada');

    const r = await run(['automations', 'edit', 'ada-shop', '--no-agent']);
    expect(r.code, r.out).toBe(0);
    const after = getAutomation(contextRoot, 'ada-shop')!;
    expect(after.agent).toBe('ada-shop');
    expect(after.prompt).toBe('You plan the kitchen: shopping, menus, orders.\n\nWrite the list.');
    expect(memberSlugs()).toEqual(['ada', 'ada-shop']);
  });

  it('never changes what is published: a shared duplicate and a private member are refused both ways', async () => {
    await seedDuplicate('kitchen-run', ['--slot', 'mon@10:00', '--shared']);
    const r = await run(['automations', 'edit', 'kitchen-run', '--agent', 'ada']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('never publishes a member');
    expect(getAutomation(contextRoot, 'kitchen-run')?.agent).toBe('kitchen-run');
    expect(listAgents(contextRoot, fakeHome).find((a) => a.slug === 'ada')?.shared).toBe(false);

    expect((await run(['automations', 'create', 'ada-shop', '--agent', 'ada', '--title', 'Shopping', '--slot', 'sat@09:00'])).code).toBe(0);
    writeFileSync(automationPath(contextRoot, 'ada-shop'), file('ada-shop').replace('shared: false', 'shared: true'));
    const d = await run(['automations', 'edit', 'ada-shop', '--no-agent']);
    expect(d.code).toBe(1);
    expect(d.out).toContain('would publish');
  });

  it('names every field it leaves behind (a Telegram reply too), and refuses a condition on a board-limited member', async () => {
    await seedDuplicate('kitchen-run', ['--slot', 'mon@10:00', '--model', 'sonnet']);
    writeFileSync(automationPath(contextRoot, 'kitchen-run'), file('kitchen-run').replace('enabled: true', 'enabled: true\nreply: telegram'));
    const r = await run(['automations', 'edit', 'kitchen-run', '--agent', 'ada']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/Left behind.*model.*reply|Left behind.*reply.*model/);
  });

  it('detach never shares the member\'s photo file: removing the detached one keeps Ada\'s face', async () => {
    const png = join(projectRoot, 'ada.png');
    writeFileSync(png, Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex'));
    expect((await run(['agents', 'edit', 'ada', '--photo', png])).code).toBe(0);
    const adaPhoto = listAgents(contextRoot, fakeHome).find((a) => a.slug === 'ada')!.photo!;
    expect(adaPhoto).toBeTruthy();
    expect((await run(['automations', 'create', 'ada-shop', '--agent', 'ada', '--title', 'Shopping', '--slot', 'sat@09:00'])).code).toBe(0);
    const r = await run(['automations', 'edit', 'ada-shop', '--no-agent']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('Not carried over from the member: photo');
    expect(getAutomation(contextRoot, 'ada-shop')?.photo).toBeNull();
    expect((await run(['automations', 'remove', 'ada-shop', '--yes'])).code).toBe(0);
    expect(existsSync(join(contextRoot, adaPhoto))).toBe(true);
  });

  it('detach carries the member\'s envelope, and refuses one a file of its own cannot hold', async () => {
    expect((await run(['agents', 'edit', 'ada', '--model', 'sonnet', '--effort', 'low'])).code).toBe(0);
    expect((await run(['automations', 'create', 'ada-shop', '--agent', 'ada', '--title', 'Shopping', '--job', 'List.', '--slot', 'sat@09:00'])).code).toBe(0);
    expect((await run(['automations', 'edit', 'ada-shop', '--no-agent'])).code).toBe(0);
    expect(getAutomation(contextRoot, 'ada-shop')).toMatchObject({ agent: 'ada-shop', model: 'sonnet', effort: 'low' });

    // `--autonomy ask` is refused since uye-ask-yok; an OLD stored ask (written before it) still is one.
    withRestamp(contextRoot, projectRoot, 'ada', { autonomy: 'ask' }, fakeHome);
    expect((await run(['automations', 'create', 'ada-menu', '--agent', 'ada', '--title', 'Menu', '--slot', 'sun@09:00'])).code).toBe(0);
    const r = await run(['automations', 'edit', 'ada-menu', '--no-agent']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('autonomy "ask"');
    expect(getAutomation(contextRoot, 'ada-menu')?.agent).toBe('ada');
  });
});

describe('an edit ends in a state a create accepts', () => {
  it('refuses on call under the member\'s own name, and on call while a condition is set', async () => {
    const { updateAutomation } = await import('../../src/lib/automations/store.js');
    expect((await run(['automations', 'create', 'ada', '--agent', 'ada', '--title', 'Ada daily', '--slot', 'daily@09:00'])).code).toBe(0);
    expect(() => updateAutomation(contextRoot, 'ada', { mode: 'call' })).toThrow(/member's own routine/);
    expect((await run(['automations', 'create', 'ada-check', '--agent', 'ada', '--title', 'Check', '--slot', 'daily@09:00', '--condition', 'test -s orders.csv'])).code).toBe(0);
    expect(() => updateAutomation(contextRoot, 'ada-check', { mode: 'call' })).toThrow(/remove the condition first/);
    expect(updateAutomation(contextRoot, 'ada-check', { mode: 'call', condition: null })).toMatchObject({ mode: 'call', schedule: null });
  });

  it('the routine card draws no schedule for an on-call routine and its save sends no slots', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'dashboard', 'src', 'components', 'aiteam', 'TeamPanel.tsx'), 'utf-8');
    expect(src).toContain("const onCall = routine.mode === 'call';");
    expect(src).toMatch(/\{onCall \? \(\s*<div className="agent-field">[\s\S]*?routine-on-call/);
    expect(src).toContain("...(!onCall && !('error' in parsed) && JSON.stringify(parsed.slots) !== seededSlots.current ? { slots: parsed.slots } : {})");
  });
});

