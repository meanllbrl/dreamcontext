/**
 * The words of the "Does the Super Agent raise token use?" card (StatsSuperEffect.tsx), kept pure
 * so a test reads every state without a renderer. `t` is the page's translator.
 */
import { fmtCost, fmtDay, fmtPct } from './statsFormat';
import type { SuperEffect, SuperStratum } from './statsTypes';

type T = (k: string) => string;

/** Under this the row reads "~aynı" (the same threshold as the verdict's "no difference"). */
export const SAME_UNDER_PCT = 10;

export function stratumLabel(s: Pick<SuperStratum, 'mode' | 'model'>, t: T): string {
  const mode = s.mode === null ? t('stats.super.mode.unknown') : t(`stats.super.mode.${s.mode}`);
  const modeText = mode.startsWith('stats.super.mode.') ? (s.mode as string).charAt(0).toUpperCase() + (s.mode as string).slice(1) : mode;
  const model = t(`stats.super.model.${s.model}`);
  return `${modeText} · ${model.startsWith('stats.super.model.') ? s.model : model}`;
}

/** The diff column: a signed percent, "~aynı" under the threshold, "az veri" with too few. */
export function stratumDiff(s: SuperStratum, t: T): { text: string; tone: 'good' | 'warn' | null } {
  if (s.diffPct === null) return { text: t('stats.super.fewData'), tone: null };
  if (Math.abs(s.diffPct) < SAME_UNDER_PCT) return { text: t('stats.super.rowSame'), tone: null };
  const p = fmtPct(Math.abs(s.diffPct));
  return s.diffPct < 0 ? { text: `-${p}`, tone: 'good' } : { text: `+${p}`, tone: 'warn' };
}

/** The verdict's sentence beside the verdict word. */
export function superWhy(e: SuperEffect, t: T): string {
  const p = e.diffPct === null ? '' : `~${fmtPct(Math.abs(e.diffPct))}`;
  switch (e.verdict) {
    case 'reduces': return t('stats.super.reduces.why').replace('{p}', p);
    case 'increases': return t('stats.super.increases.why').replace('{p}', p).replace('{top}', e.top ? stratumLabel(e.top, t) : '');
    case 'same': return t('stats.super.same.why');
    case 'unknown':
      // Name the side that is short (the server decides which): his own sessions only, the
      // Super's jobs under 10, else the plain jobs under 10.
      if (e.missing.short === 'ownOnly') return t('stats.super.unknown.ownOnly');
      if (e.missing.short === 'super') return t('stats.super.unknown.superWhy').replace('{n}', String(e.missing.superShort));
      return t('stats.super.unknown.why').replace('{n}', String(e.missing.plainShort));
    default: return t('stats.super.noSuper.why');
  }
}

/** The foot's lines: cache share, the method, the dollar line, what is counted nowhere. */
export function superFoot(e: SuperEffect, t: T): string[] {
  const lines: string[] = [];
  if (e.cacheShare.super !== null && e.cacheShare.plain !== null) {
    lines.push(t('stats.super.cache').replace('{a}', fmtPct(e.cacheShare.super * 100)).replace('{b}', fmtPct(e.cacheShare.plain * 100)));
  }
  lines.push(t('stats.super.method'));
  if (e.costDiff !== null && Math.abs(e.costDiff) >= 0.01) {
    lines.push(t(e.costDiff < 0 ? 'stats.super.costLess' : 'stats.super.costMore').replace('{c}', `~${fmtCost(Math.abs(e.costDiff))}`));
  }
  if (e.overhead.tokens > 0 && !e.overhead.attributed) lines.push(t('stats.super.overheadAlone'));
  if (e.missing.unlinkedSuccessors > 0) lines.push(t('stats.super.unlinked').replace('{n}', String(e.missing.unlinkedSuccessors)));
  lines.push(t('stats.super.machine'));
  return lines;
}

/** A row's window note: only for a row compared against the 30 days before the Super. */
export function windowNote(s: SuperStratum, t: T): string | null {
  return s.window === 'before' ? t('stats.super.before').replace('{a}', fmtDay(s.windowFrom)).replace('{b}', fmtDay(s.windowTo)) : null;
}
