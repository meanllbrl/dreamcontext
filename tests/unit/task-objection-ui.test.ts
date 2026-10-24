/**
 * The task page's "why was this opened" row and "Object to this task", driven without React.
 * Everything the header and the dialog decide lives in `dashboard/src/lib/taskObjection.ts`:
 * which row a task gets (none for the owner's own task), when the button shows, which tasks
 * the dialog offers as a target, what the preview and the confirm button say, and what a
 * refused close names. `isOpenChildrenRefusal` is the board's and the drawer's test for the
 * 409 the server answers when a parent still has open sub-tasks.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../dashboard/src/context/VaultContext', () => ({ useApi: () => null }));

import { isOpenChildrenRefusal, type Task } from '../../dashboard/src/hooks/useTasks';
import {
  OBJECTION_KINDS, canObject, filingView, objectionConfirmLabel, objectionPreview, objectionResultLine,
  objectionTargets, openChildrenMessage, shortDate, type Translate,
} from '../../dashboard/src/lib/taskObjection';

const dict: Record<string, string> = {
  'tasks.filing.sleep': 'Uyku açtı',
  'tasks.filing.plan': 'Plan açtı',
  'tasks.filing.agent': 'Agent açtı',
  'tasks.filing.unknown': 'Neden kaydedilmemiş',
  'tasks.filing.kind.ask': 'Sahip istedi:',
  'tasks.filing.kind.defect': 'Hata:',
  'tasks.filing.kind.note': 'Gerekçe:',
  'tasks.filing.planWave': 'Onaylı planın {n}. dalgası',
  'tasks.filing.planWaveAny': 'Onaylı planın bir dalgası',
  'tasks.filing.unknownHint': 'Eski görev.',
  'tasks.objection.previewPick': 'Ait olduğu görevi seçin.',
  'tasks.objection.preview.subtask-of': '«{target}» altına taşınır.',
  'tasks.objection.preview.not-a-task': 'Kapanır.',
  'tasks.objection.confirm.subtask-of': 'İtiraz et ve taşı',
  'tasks.objection.confirm.criterion-on': 'İtiraz et ve kriter yap',
  'tasks.objection.confirm.close': 'İtiraz et ve kapat',
  'tasks.objection.result.criterion-on': '→ «{target}» görevine kriter olarak eklendi',
  'tasks.openChildren.board': '“{task}” görevinin açık alt görevleri var: {list}.',
};
const t: Translate = (k) => dict[k] ?? k;

function task(slug: string, over: Partial<Task> = {}): Task {
  return {
    slug, id: slug, name: slug, description: '', priority: 'medium', urgency: 'medium', status: 'todo',
    created_at: '2026-10-20', updated_at: '2026-10-20', tags: [], parent_task: null, related_feature: null,
    version: null, rice: null, why: '', user_stories: '', acceptance_criteria: '', constraints: '',
    technical_details: '', notes: '', changelog: '', sections: [], body: '', ...over,
  };
}

const isTerminal = (s: string) => s === 'completed' || s === 'cancelled';
const isCancelled = (s: string) => s === 'cancelled';

describe('filingView — the "why was this opened" row', () => {
  it('the owner\'s own task gets no row', () => {
    expect(filingView(task('a', { filed_by: 'human' }), t, 'tr')).toBeNull();
  });

  it('sleep on an owner ask: chip with the date, the label and the quote', () => {
    const v = filingView(task('a', { filed_by: 'sleep', filing_basis: { kind: 'ask', quote: 'dersi tutup taşıyabileyim', at: '2026-10-23', verified: true } }), t, 'tr');
    expect(v).toMatchObject({ tone: 'sleep', label: 'Sahip istedi:', quote: 'dersi tutup taşıyabileyim', line: null, italic: false });
    expect(v?.chip).toBe(`Uyku açtı · ${shortDate('2026-10-23', 'tr')}`);
    expect(v?.chip).toMatch(/23 Eki/);
  });

  it('a defect is italic; a plan wave reads its number from the WN part', () => {
    expect(filingView(task('a', { filed_by: 'sleep', filing_basis: { kind: 'defect', quote: 'TypeError: x', at: '2026-10-23', verified: true } }), t, 'tr')?.italic).toBe(true);
    expect(filingView(task('w', { filed_by: 'plan', filing_basis: { kind: 'plan', quote: 'W2 2-dalga-ui (b.tsx)', at: '2026-10-23', verified: false } }), t, 'tr'))
      .toMatchObject({ tone: 'plan', line: 'Onaylı planın 2. dalgası' });
    expect(filingView(task('w', { filed_by: 'plan', filing_basis: { kind: 'plan', quote: '', at: '2026-10-23', verified: false } }), t, 'tr')?.line).toBe('Onaylı planın bir dalgası');
  });

  it('an older task with nothing recorded says so, dated by its creation', () => {
    const v = filingView(task('old', { created_at: '2026-08-01' }), t, 'en');
    expect(v).toMatchObject({ tone: 'unknown', line: 'Eski görev.' });
    expect(v?.chip).toMatch(/^Neden kaydedilmemiş · Aug 1$/);
  });
});

describe('canObject — when the button shows', () => {
  it('hidden on the owner\'s task, a cancelled task, an applied or unfinished objection', () => {
    expect(canObject(task('a', { filed_by: 'sleep' }), isCancelled)).toBe(true);
    expect(canObject(task('a'), isCancelled)).toBe(true);
    expect(canObject(task('a', { filed_by: 'human' }), isCancelled)).toBe(false);
    expect(canObject(task('a', { filed_by: 'sleep', status: 'cancelled' }), isCancelled)).toBe(false);
    const objection = { id: 'obj_1', as: 'not-a-task' as const, target: null, targetName: null, note: 'n', at: '2026-10-23T10:00:00Z', pending: false, error: null, applied: { action: 'not-a-task', at: '2026-10-23T10:00:01Z' }, rule: null };
    expect(canObject(task('a', { filed_by: 'sleep', objection }), isCancelled)).toBe(false);
    expect(canObject(task('a', { filed_by: 'sleep', objection: { ...objection, applied: null, pending: true } }), isCancelled)).toBe(false);
  });
});

describe('objectionTargets — the dialog\'s task picker', () => {
  const all = [
    task('self'),
    task('open-b', { name: 'B task' }),
    task('open-a', { name: 'A task' }),
    task('done', { status: 'completed' }),
    task('gone', { status: 'cancelled' }),
    task('a-child', { name: 'A child', parent_task: 'open-a' }),
    task('orphan', { name: 'Orphan', parent_task: 'deleted-parent' }),
  ];
  it('open tasks only, never itself, sorted by name; sub-tasks only for kinds other than subtask-of', () => {
    expect(objectionTargets(all[0], all, 'criterion-on', isTerminal).map((x) => x.slug)).toEqual(['a-child', 'open-a', 'open-b', 'orphan']);
    // a dangling parent link reads as top-level, so it may still take sub-tasks
    expect(objectionTargets(all[0], all, 'subtask-of', isTerminal).map((x) => x.slug)).toEqual(['open-a', 'open-b', 'orphan']);
  });
});

describe('preview, confirm label, result line, refused close', () => {
  it('the preview asks for a target first, then says what happens', () => {
    expect(objectionPreview(t, 'subtask-of', null, true)).toBe('Ait olduğu görevi seçin.');
    expect(objectionPreview(t, 'subtask-of', 'Ders planı', true)).toBe('«Ders planı» altına taşınır.');
    expect(objectionPreview(t, 'not-a-task', null, false)).toBe('Kapanır.');
  });

  it('the confirm button names its action', () => {
    expect(objectionConfirmLabel(t, 'subtask-of')).toBe('İtiraz et ve taşı');
    expect(objectionConfirmLabel(t, 'criterion-on')).toBe('İtiraz et ve kriter yap');
    for (const k of ['duplicate-of', 'not-a-task', 'wrong-project'] as const) expect(objectionConfirmLabel(t, k)).toBe('İtiraz et ve kapat');
    expect(OBJECTION_KINDS).toHaveLength(5);
  });

  it('the box line names the target', () => {
    expect(objectionResultLine(t, 'criterion-on', 'Ders planı')).toBe('→ «Ders planı» görevine kriter olarak eklendi');
  });

  it('a refused close names the open sub-tasks only, and is recognised by its code', () => {
    const parent = task('p', { name: 'Ana görev' });
    const all = [parent, task('k1', { name: 'Açık dalga', parent_task: 'p' }), task('k2', { name: 'Biten', parent_task: 'p', status: 'completed' }), task('k3', { name: 'İptal', parent_task: 'p', status: 'cancelled' })];
    expect(openChildrenMessage(t, 'board', parent, all, isTerminal)).toBe('“Ana görev” görevinin açık alt görevleri var: Açık dalga.');
    // a list that has not caught up (a sub-task opened elsewhere): the server's message, which names it
    expect(openChildrenMessage(t, 'board', parent, [parent], isTerminal, 'This task has 1 open sub-task(s): x.')).toBe('This task has 1 open sub-task(s): x.');
    expect(isOpenChildrenRefusal({ status: 409, code: 'parent_has_open_children' })).toBe(true);
    expect(isOpenChildrenRefusal({ status: 409, code: 'sleep_eval_gate' })).toBe(false);
    expect(isOpenChildrenRefusal(new Error('x'))).toBe(false);
  });
});
