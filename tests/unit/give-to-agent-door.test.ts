/**
 * The one "Give to an agent" door (plan r3 § 5e). Root vitest has no DOM, so the wiring is
 * pinned two ways: the pure bridges are driven for real (the door's event and the delegate
 * detail it sends for Develop ride the project's bus, never `window`), and the component and
 * surface edits are read as source.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../../dashboard/src/api/client', () => ({
  api: { post: vi.fn() },
  getActiveVault: () => 'test-vault',
}));

const { openGiveToAgent, GIVE_TO_AGENT_EVENT } = await import('../../dashboard/src/lib/giveToAgent');
const { requestDelegateAgent, DELEGATE_AGENT_EVENT } = await import('../../dashboard/src/lib/delegateAgent');

const ROOT = join(import.meta.dirname, '..', '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf-8');
/** The source with its comments taken out, so a pin cannot pass on a comment. */
const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

describe('the door rides the project bus', () => {
  it('opens on the bus it was given, with the slug and preset, and never on window', () => {
    const bus = new EventTarget();
    const seen: unknown[] = [];
    bus.addEventListener(GIVE_TO_AGENT_EVENT, (e) => seen.push((e as CustomEvent).detail));
    const onWindow = vi.fn();
    globalThis.addEventListener?.(GIVE_TO_AGENT_EVENT, onWindow);
    openGiveToAgent(bus, { slug: 'fix-login', preset: 'develop' });
    openGiveToAgent(bus);
    expect(seen).toEqual([{ slug: 'fix-login', preset: 'develop' }, {}]);
    expect(onWindow).not.toHaveBeenCalled();
  });

  it('Develop is a delegate request that carries the task, not a prompt, and is acked synchronously', () => {
    const bus = new EventTarget();
    let got: Record<string, unknown> | null = null;
    bus.addEventListener(DELEGATE_AGENT_EVENT, (e) => {
      const d = (e as CustomEvent<Record<string, unknown>>).detail;
      got = { ...d };
      if (d.mode === 'develop' && d.taskSlug) d.accepted = true;
    });
    const ok = requestDelegateAgent(bus, { mode: 'develop', taskSlug: 'fix-login', title: 'Fix login', prompt: '', promptToken: '', bypass: false });
    expect(ok).toBe(true);
    expect(got).toMatchObject({ mode: 'develop', taskSlug: 'fix-login', prompt: '', promptToken: '' });
  });
});

describe('the Agent surface opens Develop before the prompt guard', () => {
  const src = code(read('dashboard/src/components/sleepy/AgentSurface.tsx'));
  const listener = /useInstanceEvent<DelegateAgentDetail>\(DELEGATE_AGENT_EVENT, \(detail\) => \{[\s\S]*?\n {2}\}\);/.exec(src)?.[0] ?? '';

  it('the develop branch comes first and returns', () => {
    const develop = listener.indexOf("detail?.mode === 'develop' && detail.taskSlug");
    const guard = listener.indexOf('detail?.prompt || detail?.promptToken');
    expect(develop).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(develop);
    expect(listener.slice(develop, guard)).toMatch(/openDevelopSession\(detail\.taskSlug\)[\s\S]*return;/);
  });

  it('openDevelopSession is synchronous, seeds developKickoffPrompt and opens a develop chat', () => {
    const fn = /const openDevelopSession = useCallback\(\(taskSlug: string\): boolean => \{[\s\S]*?\n {2}\}, \[/.exec(src)?.[0] ?? '';
    expect(fn).toContain('developKickoffPrompt(taskSlug)');
    expect(fn).toContain("'develop')");
    expect(fn).toMatch(/if \(promptFitsInline\(prompt\)\) \{\s*open\(prompt, ''\);\s*return true;/);
    expect(fn).not.toMatch(/await /);
  });
});

describe('task surfaces reduce to the one door', () => {
  it('the board no longer hosts the delegate, assign or author composers', () => {
    const board = code(read('dashboard/src/components/tasks/KanbanBoard.tsx'));
    for (const name of ['DelegateComposer', 'AssignToAgentComposer', 'AuthorTaskComposer']) expect(board).not.toContain(name);
    expect(board).toContain("giveToAgent({ slug: task.slug })");
    expect(board).toContain("giveToAgent({ preset: 'author' })");
  });

  it('the task page opens the door, and the door embeds the three composers reading useTask', () => {
    expect(code(read('dashboard/src/pages/TaskPage.tsx'))).toContain('giveToAgent({ slug: task.slug })');
    const dialog = code(read('dashboard/src/components/agent-door/GiveToAgentDialog.tsx'));
    expect(dialog).toContain('useTask(slug)');
    for (const name of ['<AssignToAgentComposer task={task}', '<DelegateComposer task={task}', '<AuthorTaskComposer']) expect(dialog).toContain(name);
    expect(dialog).toContain("mode: 'develop', taskSlug: slug");
    expect(dialog).toContain('useTaskReadiness(slug');
  });

  it('the dialog is mounted once, in ProjectInstance', () => {
    expect(code(read('dashboard/src/ProjectInstance.tsx')).match(/<GiveToAgentDialog \/>/g)).toHaveLength(1);
  });
});
