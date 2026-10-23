import type { ObjectionKind, Task } from '../hooks/useTasks';

/**
 * What the task page decides about "why was this opened" and "Object to this task", with no
 * React in it, so tests can drive it (tests/unit/task-objection-ui.test.ts). The header
 * (`detail/DetailHeader.tsx`) and the dialog (`detail/ObjectionDialog.tsx`) render these.
 */

export type Translate = (key: string) => string;

/** The kinds the dialog offers, in its order. */
export const OBJECTION_KINDS: ObjectionKind[] = ['subtask-of', 'criterion-on', 'duplicate-of', 'not-a-task', 'wrong-project'];

/** `t(key)` with every `{var}` filled. */
export function fill(t: Translate, key: string, vars: Record<string, string> = {}): string {
  let out = t(key);
  for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(v);
  return out;
}

/** "2026-10-23" (or an ISO timestamp) → "23 Eki" / "Oct 23". Empty on junk. */
export function shortDate(value: string | null | undefined, locale: string): string {
  if (!value) return '';
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(locale === 'tr' ? 'tr-TR' : 'en-US', { day: 'numeric', month: 'short' }).format(d);
}

export interface FilingView {
  /** "Sleep opened it · 23 Oct" */
  chip: string;
  tone: 'sleep' | 'agent' | 'plan' | 'unknown';
  /** The label before the quote ("The owner asked:"), or null. */
  label: string | null;
  /** The quoted basis, or null. */
  quote: string | null;
  /** A line instead of label + quote (a plan wave, an unrecorded reason). */
  line: string | null;
  italic: boolean;
}

/** The "why was this opened" row, or null for the owner's own tasks (no row at all). */
export function filingView(task: Pick<Task, 'filed_by' | 'filing_basis' | 'created_at'>, t: Translate, locale: string): FilingView | null {
  const by = task.filed_by ?? null;
  if (by === 'human') return null;
  const basis = task.filing_basis ?? null;
  const date = shortDate(basis?.at || task.created_at, locale);
  const tone: FilingView['tone'] = by === 'sleep' || by === 'agent' || by === 'plan' ? by : 'unknown';
  const who = t(`tasks.filing.${tone}`);
  const chip = date ? `${who} · ${date}` : who;
  if (tone === 'unknown' || !basis) {
    return { chip, tone, label: null, quote: null, line: t('tasks.filing.unknownHint'), italic: false };
  }
  if (basis.kind === 'plan') {
    const wave = /^\s*W(\d+)\b/.exec(basis.quote)?.[1];
    return { chip, tone, label: null, quote: null, line: wave ? fill(t, 'tasks.filing.planWave', { n: wave }) : t('tasks.filing.planWaveAny'), italic: false };
  }
  return { chip, tone, label: t(`tasks.filing.kind.${basis.kind}`), quote: basis.quote, line: null, italic: basis.kind === 'defect' };
}

/**
 * May the owner object to this task now? Not to their own task, not to a cancelled one, and
 * not again once an objection is applied. An unfinished objection is finished from its box,
 * not by opening a second dialog.
 */
export function canObject(task: Pick<Task, 'filed_by' | 'status' | 'objection'>, isCancelled: (status: string) => boolean): boolean {
  if ((task.filed_by ?? null) === 'human') return false;
  if (isCancelled(task.status)) return false;
  const o = task.objection ?? null;
  return !o || (!o.applied && !o.pending);
}

/**
 * The tasks the dialog offers as a target: open ones, never the task itself, sorted by name;
 * for "sub-task of" only tasks that are not sub-tasks themselves (two levels max).
 */
export function objectionTargets(
  task: Pick<Task, 'slug'>,
  allTasks: readonly Task[],
  as: ObjectionKind,
  isTerminal: (status: string) => boolean,
): Task[] {
  const exists = new Set(allTasks.map((x) => x.slug));
  return allTasks
    .filter((x) => x.slug !== task.slug && !isTerminal(x.status))
    .filter((x) => as !== 'subtask-of' || !x.parent_task || !exists.has(x.parent_task))
    .sort((a, b) => (a.name || a.slug).localeCompare(b.name || b.slug));
}

/** The dialog's "What happens:" text. */
export function objectionPreview(t: Translate, as: ObjectionKind, targetName: string | null, needsTarget: boolean): string {
  if (needsTarget && !targetName) return t('tasks.objection.previewPick');
  return fill(t, `tasks.objection.preview.${as}`, { target: targetName ?? '' });
}

/** The confirm button: it says what it will do. */
export function objectionConfirmLabel(t: Translate, as: ObjectionKind): string {
  return as === 'subtask-of' || as === 'criterion-on' ? t(`tasks.objection.confirm.${as}`) : t('tasks.objection.confirm.close');
}

/** The box's "→ moved under «X»" line. */
export function objectionResultLine(t: Translate, as: ObjectionKind, targetName: string | null): string {
  return fill(t, `tasks.objection.result.${as}`, { target: targetName ?? '' });
}

/** What a refused close says: which sub-tasks are still open, from the list the page holds. */
export function openChildrenMessage(
  t: Translate,
  where: 'board' | 'detail',
  task: Pick<Task, 'slug' | 'name'>,
  allTasks: readonly Task[],
  isTerminal: (status: string) => boolean,
): string {
  const open = allTasks.filter((x) => x.parent_task === task.slug && !isTerminal(x.status)).map((x) => x.name || x.slug);
  return fill(t, `tasks.openChildren.${where}`, { task: task.name || task.slug, list: open.join(', ') });
}
