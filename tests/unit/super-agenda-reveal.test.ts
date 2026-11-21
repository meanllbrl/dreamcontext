/**
 * The header pill's "needs you" jumps to the agenda's first pink row (plan super-v3 D13, v3-4):
 * an agenda mounted now answers the event, one mounting a moment later takes the fresh request,
 * and with no agenda answering the chat scrolls to the head question instead.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

class FakeWindow extends EventTarget {
  setTimeout = (fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number;
}

describe('agendaReveal', () => {
  let win: FakeWindow;
  let seen: string[];
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    win = new FakeWindow();
    vi.stubGlobal('window', win);
    seen = [];
    win.addEventListener('super:reveal-question', (e) => seen.push((e as CustomEvent).detail.itemId));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('an agenda that answers (clears the request) leaves the chat alone', async () => {
    const m = await import('../../dashboard/src/components/sleepy/super/agendaReveal');
    win.addEventListener(m.REVEAL_AGENDA_WAITING_EVENT, () => m.clearPendingReveal());
    m.revealAgendaWaiting('q-head');
    vi.advanceTimersByTime(m.REVEAL_FRESH_MS + 10);
    expect(seen).toEqual([]);
  });

  it('an agenda mounting just after the press takes the fresh request, once', async () => {
    const m = await import('../../dashboard/src/components/sleepy/super/agendaReveal');
    const t0 = 1_000_000;
    m.revealAgendaWaiting('q-head', t0);
    expect(m.takePendingReveal(t0 + 300)).toEqual({ headId: 'q-head' });
    expect(m.takePendingReveal(t0 + 310)).toBeNull();
    vi.advanceTimersByTime(m.REVEAL_FRESH_MS + 10);
    expect(seen).toEqual([]);
  });

  it('a stale request is not taken by a later mount', async () => {
    const m = await import('../../dashboard/src/components/sleepy/super/agendaReveal');
    const t0 = 1_000_000;
    m.revealAgendaWaiting('q-head', t0);
    expect(m.takePendingReveal(t0 + m.REVEAL_FRESH_MS + 1)).toBeNull();
  });

  it('no agenda answers: the chat scrolls to the head question, never a dead press', async () => {
    const m = await import('../../dashboard/src/components/sleepy/super/agendaReveal');
    m.revealAgendaWaiting('q-head');
    vi.advanceTimersByTime(m.REVEAL_FRESH_MS + 10);
    expect(seen).toEqual(['q-head']);
  });
});

describe('the agenda listens and shows its first waiting row', () => {
  const SRC = readFileSync(join(__dirname, '..', '..', 'dashboard', 'src', 'components', 'sleepy', 'super', 'SuperAgenda.tsx'), 'utf-8');
  const REVEAL = readFileSync(join(__dirname, '..', '..', 'dashboard', 'src', 'components', 'sleepy', 'super', 'agendaReveal.ts'), 'utf-8');
  it('turns medium\'s filter to waiting, takes an early request, falls back when no pink row is drawn', () => {
    expect(SRC).toContain('window.addEventListener(REVEAL_AGENDA_WAITING_EVENT, on);');
    expect(SRC).toContain("setFilter('waiting');");
    expect(SRC).toContain('const early = takePendingReveal();');
    expect(SRC).toContain('if (!showFirstWaitingRow(rootRef.current)) revealFallback(headId);');
    // The first pink row is the first row of the waiting group, in the order drawn.
    expect(REVEAL).toContain(`root?.querySelector<HTMLElement>('.super-agenda-row[data-group="waiting"]')`);
  });
});
