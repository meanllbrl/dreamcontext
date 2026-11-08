/**
 * A task's doer and reviewer faces are buttons (plan-r10 1c, AC18; Wave 3 lane C): on the board
 * card, the properties panel, the job row and the review rounds, a face opens that member's stage
 * with the task (`requestOpenAgents({ slug, task })`). The button is called as a function with
 * its hooks pinned, and its click is fired by hand; the four surfaces are a source scan.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const opened: unknown[] = [];
vi.mock('../../dashboard/src/lib/openAgents.js', () => ({ requestOpenAgents: (f: unknown) => { opened.push(f); } }));
vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({ locale: 'tr', setLocale: () => {}, t: (k: string) => ({ 'tasks.agent.openMember': '{name} sayfasını aç' } as Record<string, string>)[k] ?? k }),
}));
vi.mock('../../dashboard/src/hooks/useAgents.js', () => ({
  useAgents: () => ({ data: [{ slug: 'rota', title: 'Rota' }] }),
  findAgent: (list: Array<{ slug: string }> | undefined, slug: string) => list?.find((a) => a.slug === slug),
}));
vi.mock('../../dashboard/src/components/tasks/AssignToAgentComposer.js', () => ({ TaskAgentFace: () => null }));

const { TaskFaceButton } = await import('../../dashboard/src/components/tasks/detail/AgentJobRow.js');

const ROOT = join(import.meta.dirname, '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, 'dashboard/src', rel), 'utf-8');

describe('the face button', () => {
  it('is the pinned test id with its role and an accessible name', () => {
    const el = TaskFaceButton({ slug: 'rota', task: 'fiyat-sayfasi', role: 'reviewer' }) as any;
    expect(el.type).toBe('button');
    expect(el.props['data-testid']).toBe('task-agent-face');
    expect(el.props['data-slug']).toBe('rota');
    expect(el.props['data-role']).toBe('reviewer');
    expect(el.props['aria-label']).toBe('Rota sayfasını aç');
  });

  it('a click opens the member with the task, and never reaches the card under it', () => {
    opened.length = 0;
    const el = TaskFaceButton({ slug: 'rota', task: 'fiyat-sayfasi', role: 'doer' }) as any;
    let stopped = 0;
    el.props.onClick({ stopPropagation: () => { stopped += 1; } });
    el.props.onPointerDown({ stopPropagation: () => { stopped += 1; } });
    expect(opened).toEqual([{ slug: 'rota', task: 'fiyat-sayfasi' }]);
    expect(stopped).toBe(2);
  });
});

describe('the four surfaces draw it with the slug and the task', () => {
  it('the board card: doer and reviewer', () => {
    const src = read('components/tasks/BoardCard.tsx');
    expect(src).toContain('<TaskFaceButton slug={agent} task={task.slug} role="doer" />');
    expect(src).toContain('<TaskFaceButton slug={reviewer} task={task.slug} role="reviewer" />');
  });

  it('the properties panel: doer and reviewer', () => {
    const src = read('components/tasks/detail/PropertiesPanel.tsx');
    expect(src).toContain('<TaskFaceButton slug={task.agent} task={task.slug} role="doer" size={20} />');
    expect(src).toContain('<TaskFaceButton slug={task.agent_job.reviewer} task={task.slug} role="reviewer" size={20} />');
  });

  it('the job row: "Open its stage" carries the task too', () => {
    const src = read('components/tasks/detail/AgentJobRow.tsx');
    expect(src).toContain('requestOpenAgents({ slug: task.agent ?? undefined, task: task.slug })');
    expect(src).toContain('requestOpenAgents({ slug, task })');
  });

  it('the review rounds: the reviewer, with the task when the caller names it', () => {
    const src = read('components/tasks/detail/ReviewRoundsSection.tsx');
    expect(src).toContain('<TaskFaceButton slug={job.reviewer} task={taskSlug ?? \'\'} role="reviewer" size={20} />');
  });
});
