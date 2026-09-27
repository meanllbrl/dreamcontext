import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Local dictation's install state, with the button that installs it.
 *
 * Dictation runs ONLY on this machine (owner, 2026-09-27), so a machine without whisper.cpp
 * has no dictation until it is installed. The server decides how (`lib/voice/dictationInstall.ts`:
 * Homebrew for the engine, a model already on disk or a one-time download) — this only asks,
 * shows progress, and says plainly what went wrong. Shared by Settings → Voice and the
 * Assistant setup, which passes `autoStart` so setup installs it without a second click.
 */

interface DictationState {
  installed: boolean;
  engine: boolean;
  model: string | null;
  brew: boolean;
  phase: 'idle' | 'engine' | 'model' | 'done' | 'error';
  received: number;
  total: number;
  error: string | null;
}

const POLL_MS = 1000;

function gb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(bytes >= 1e9 ? 2 : 1)} GB`;
}

export function DictationInstall({ autoStart = false }: { autoStart?: boolean }) {
  const [state, setState] = useState<DictationState | null>(null);
  const [failed, setFailed] = useState(false);
  const started = useRef(false);

  const read = useCallback(async () => {
    try {
      const res = await fetch('/api/agent/voice/dictation');
      if (!res.ok) { setFailed(true); return null; }
      const s = await res.json() as DictationState;
      setState(s);
      return s;
    } catch {
      setFailed(true);
      return null;
    }
  }, []);

  const install = useCallback(async () => {
    try {
      const res = await fetch('/api/agent/voice/dictation', { method: 'POST' });
      if (res.ok) setState(await res.json() as DictationState);
    } catch { /* the poll reports it */ }
  }, []);

  useEffect(() => {
    void read().then((s) => {
      if (autoStart && s && !s.installed && s.phase !== 'error' && !started.current) {
        started.current = true;
        void install();
      }
    });
  }, [read, install, autoStart]);

  const busy = state?.phase === 'engine' || state?.phase === 'model';
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => { void read(); }, POLL_MS);
    return () => clearInterval(t);
  }, [busy, read]);

  if (failed && !state) return <p className="settings-field-hint">Dictation status is unavailable here.</p>;
  if (!state) return <p className="settings-field-hint">Checking dictation…</p>;

  if (state.installed && !busy) {
    return (
      <p className="settings-field-hint" role="status">
        Ready — whisper.cpp {state.model} runs on this Mac. Nothing you say leaves it.
      </p>
    );
  }

  if (busy) {
    const pct = state.total > 0 ? Math.min(100, Math.round((state.received / state.total) * 100)) : null;
    return (
      <div className="dictation-install" role="status" aria-live="polite">
        <p className="settings-field-hint">
          {state.phase === 'engine'
            ? 'Installing the speech engine (whisper.cpp) with Homebrew…'
            : pct !== null
              ? `Downloading the speech model — ${gb(state.received)} of ${gb(state.total)}`
              : 'Downloading the speech model…'}
        </p>
        {state.phase === 'model' && (
          <progress className="dictation-install__bar" max={100} value={pct ?? undefined} aria-label="Speech model download" />
        )}
      </div>
    );
  }

  return (
    <div className="dictation-install">
      <p className="settings-field-hint" role={state.phase === 'error' ? 'alert' : undefined}>
        {state.phase === 'error' && state.error
          ? state.error
          : !state.engine && !state.brew
            ? 'Dictation needs whisper.cpp, and installing it needs Homebrew (brew.sh).'
            : state.engine
              ? 'The speech engine is here; the speech model (about 1.6 GB, once) is not.'
              : 'Dictation is not installed. It installs the speech engine and downloads the model once (about 1.6 GB).'}
      </p>
      <button type="button" className="btn btn--secondary" onClick={() => { void install(); }}>
        {state.phase === 'error' ? 'Try again' : 'Install dictation'}
      </button>
    </div>
  );
}
