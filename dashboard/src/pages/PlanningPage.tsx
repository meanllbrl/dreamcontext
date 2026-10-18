import { useState } from 'react';
import { useCycles } from '../hooks/useCycles';
import { useTasks } from '../hooks/useTasks';
import { useI18n } from '../context/I18nContext';
import type { Page } from '../components/layout/Sidebar';
import { CycleList } from '../components/planning/CycleList';
import { NewCycleForm } from '../components/planning/NewCycleForm';
import { PlanningBoard } from '../components/planning/PlanningBoard';
import { CloseDeck } from '../components/planning/CloseDeck';
import '../components/planning/Planning.css';

/**
 * Planning (plan r3 § 5d): the cycles, a new one, the board that moves work between the Next
 * queue and a cycle with the capacity hint beside it, and the Close deck for the active cycle.
 */
export function PlanningPage({ onNavigate }: { onNavigate: (page: Page, id: string | null) => void }) {
  const { t } = useI18n();
  const { data, isLoading, error } = useCycles();
  const { data: tasks = [] } = useTasks();
  const [picked, setPicked] = useState<string | null>(null);
  const [closing, setClosing] = useState<string | null>(null);

  const cycles = data?.cycles ?? [];
  // The cycle on the board: the one picked, else a planned one, else the active one.
  const selected = cycles.find((c) => c.id === picked && c.status !== 'closed')
    ?? cycles.find((c) => c.status === 'planned')
    ?? cycles.find((c) => c.id === data?.active)
    ?? null;

  return (
    <div className="pln-page" data-planning-ready={data ? 'true' : undefined}>
      <h1 className="pln-page-title">{t('nav.planning')}</h1>
      {isLoading && <p className="pln-empty">{t('taskPage.loading')}</p>}
      {error && <p className="pln-error" role="alert">{(error as Error).message}</p>}
      {data && (
        <>
          {closing ? (
            <CloseDeck cycleId={closing} onDone={() => setClosing(null)} onCancel={() => setClosing(null)} />
          ) : (
            <>
              <section className="pln-section" aria-labelledby="pln-new">
                <h2 className="pln-section-title" id="pln-new">{t('planning.new.title')}</h2>
                <NewCycleForm defaultWeeks={data.defaultWeeks} onCreated={setPicked} />
              </section>
              <section className="pln-section" aria-labelledby="pln-cycles">
                <h2 className="pln-section-title" id="pln-cycles">{t('planning.cycles.title')}</h2>
                <CycleList cycles={cycles} active={data.active} selected={selected?.id ?? null} onSelect={setPicked} onClose={setClosing} />
              </section>
              <section className="pln-section" aria-labelledby="pln-board">
                <h2 className="pln-section-title" id="pln-board">{t('planning.board.title')}</h2>
                {selected ? (
                  <PlanningBoard
                    tasks={tasks}
                    cycles={cycles}
                    cycle={selected}
                    capacityHint={data.capacityHint}
                    onOpenTask={(slug) => onNavigate('task', slug)}
                  />
                ) : (
                  <p className="pln-empty">{t('planning.board.noCycle')}</p>
                )}
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}
