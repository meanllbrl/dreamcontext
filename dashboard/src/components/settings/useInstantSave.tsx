import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../context/I18nContext';

/**
 * Instant-save plumbing for Settings.
 *
 * The page used to run two save models side by side: Platforms, native memory and
 * the ten cloud-task fields waited behind a global Save button parked in the top-left
 * corner, while learning, recall, cloud sync, Connections, Agents and Sleepy wrote
 * through on change. Nothing on screen said which control belonged to which model,
 * and the button sat disabled most of the time.
 *
 * Now every control writes immediately, and this hook is what makes that legible:
 * a per-control state the caller renders as a small mark BESIDE the control it
 * belongs to — never a page-level banner, which is the mistake we just removed.
 */

export type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string };

const SAVED_MS = 1800;

export function useInstantSave() {
  const [state, setState] = useState<SaveState>({ kind: 'idle' });
  const timer = useRef<number | null>(null);
  const alive = useRef(true);

  useEffect(() => () => {
    alive.current = false;
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  /**
   * Run a write and track it. Returns true on success so the caller can decide
   * whether to revert its optimistic local state (a failed write must not leave
   * the control showing a value that never reached disk).
   */
  const save = async (fn: () => Promise<unknown>): Promise<boolean> => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    setState({ kind: 'saving' });
    try {
      await fn();
      if (!alive.current) return true;
      setState({ kind: 'saved' });
      timer.current = window.setTimeout(() => {
        if (alive.current) setState({ kind: 'idle' });
      }, SAVED_MS);
      return true;
    } catch (err) {
      if (alive.current) {
        setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      }
      return false;
    }
  };

  return { state, save };
}

/**
 * The mark that goes next to a control. An error is NOT auto-dismissed — a write
 * that never landed has to keep saying so until the next attempt replaces it.
 */
export function SaveMark({ state }: { state: SaveState }) {
  const { t } = useI18n();
  if (state.kind === 'idle') return null;
  if (state.kind === 'saving') return <span className="settings-save-mark">{t('settings.saving')}</span>;
  if (state.kind === 'saved') return <span className="settings-save-mark settings-save-mark--ok">✓ {t('settings.saved')}</span>;
  return <span className="settings-save-mark settings-save-mark--err">✗ {state.message}</span>;
}
