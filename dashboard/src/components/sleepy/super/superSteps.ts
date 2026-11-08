import { toolResultText } from '../chat/chatEntities';
import { actionText, toolAction } from '../chat/toolAction';
import { describeDreamAction, dreamActionPhrase, dreamOutcome, parseDreamActions } from '../chat/dreamCommand';
import type { ChatToolItem } from '../chatSession';

/** The pure half of `SuperStepsLine`: what a step is called, whether it failed, how long a turn took. */

/** A step failed: the tool said so, or a dreamcontext call printed its `✗` (DreamActionCard's rule). */
export function stepFailed(item: ChatToolItem): boolean {
  if (item.status === 'error') return true;
  if (item.name !== 'Bash' || item.result === undefined) return false;
  const command = (item.input as { command?: unknown } | null)?.command;
  const actions = parseDreamActions(typeof command === 'string' ? command : undefined);
  if (!actions.length) return false;
  return dreamOutcome(toolResultText(item.result), actions[0].domain)?.tone === 'error';
}

/** One step in plain words, in the tense of its status, with no raw command in it. */
export function stepPhrase(item: ChatToolItem): { text: string; quiet: boolean } {
  const command = item.name === 'Bash' ? (item.input as { command?: unknown } | null)?.command : undefined;
  const dream = parseDreamActions(typeof command === 'string' ? command : undefined);
  const action = toolAction(item.name, item.input, item.status);
  if (dream.length && !action.quiet) {
    const phrase = dreamActionPhrase(describeDreamAction(dream[0]), item.status);
    return { text: item.status === 'running' ? `${phrase.verb}…` : phrase.verb, quiet: false };
  }
  return { text: actionText(action.subject?.kind === 'prose' ? { ...action, subject: null } : action), quiet: action.quiet };
}

/** The step in hand: the latest one still running, else the latest one. Bookkeeping never leads. */
export function nowStep(items: readonly ChatToolItem[]): string {
  const visible = items.filter((i) => !stepPhrase(i).quiet);
  const current = [...visible].reverse().find((i) => i.status === 'running') ?? visible[visible.length - 1];
  return current ? stepPhrase(current).text : '';
}

/** "61 s", "2 min 5 s": seconds up to 99 (the owner's "61 sn"), then minutes. */
export function stepsDuration(ms: number, t: (key: string) => string): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 100) return t('super.steps.seconds').replace('{n}', String(s));
  const m = Math.floor(s / 60);
  const rest = s % 60;
  const min = t('super.steps.minutes').replace('{n}', String(m));
  return rest ? `${min} ${t('super.steps.seconds').replace('{n}', String(rest))}` : min;
}

/**
 * What the live line says (owner 2026-11-07): waiting on the owner, the step in hand, or
 * "Thinking" in the gap between steps, where the plain Chat used to pop a separate Working pill.
 */
export function liveLabel(items: readonly ChatToolItem[], waiting: boolean, t: (key: string) => string): string {
  if (waiting) return t('super.steps.waiting');
  if (!items.some((i) => i.status === 'running')) return t('super.steps.thinking');
  return nowStep(items) || t('super.steps.working');
}

/** The turn's running clock on the live line: "0 s", "28 s", then minutes as `stepsDuration`. */
export function turnClock(ms: number, t: (key: string) => string): string {
  return ms < 1000 ? t('super.steps.seconds').replace('{n}', '0') : stepsDuration(ms, t);
}
