import { useCallback, useEffect, useState } from 'react';
import { DICTATION_CHANGED_EVENT, notifyDictationChanged } from '../../lib/voice/useDictationReady';

/**
 * Where dictation runs — the owner's choice — and the local install's progress.
 *
 * ASKED, NEVER ASSUMED (owner, 2026-10-27). Turning voice on used to download `large-v3-turbo`
 * and load it at every launch, and 8 GB MacBook Airs went down under it. Now nothing downloads
 * until the owner picks: a local model (the size this Mac can carry is preselected, each with
 * its download and memory cost; one too large is listed but cannot be picked), or the cloud
 * (OpenRouter's transcription, with the voice key — audio then leaves the Mac). The server
 * decides how a local install happens (`lib/voice/dictationInstall.ts`). Shared by Settings →
 * Voice and the Assistant setup.
 */

type ModelId = 'tiny' | 'base' | 'small' | 'medium' | 'large-v3-turbo';

interface ModelOption {
  id: ModelId;
  downloadMB: number;
  ramMB: number;
  onDisk: boolean;
  fits: boolean;
}

interface DictationState {
  installed: boolean;
  choice: { engine: 'local' | 'cloud'; model: ModelId | null } | null;
  engine: boolean;
  model: string | null;
  blocked: 'too_big' | 'load_failed' | null;
  key: boolean;
  machine: { memGB: number; chip: string };
  recommended: ModelId;
  models: ModelOption[];
  brew: boolean;
  phase: 'idle' | 'engine' | 'model' | 'done' | 'error';
  received: number;
  total: number;
  error: string | null;
  /** The size being downloaded; it becomes the choice once it is whole. */
  pending: ModelId | null;
}

const POLL_MS = 1000;
const CLOUD = 'cloud';

function gb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(bytes >= 1e9 ? 2 : 1)} GB`;
}

function size(mb: number): string {
  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`;
}

function optionLabel(m: ModelOption, recommended: ModelId): string {
  const cost = m.onDisk ? 'already on this Mac' : `${size(m.downloadMB)} download`;
  const tail = m.id === recommended ? ' · recommended' : !m.fits ? ' · too large for this Mac' : '';
  return `On this Mac — ${m.id} (${cost}, ~${size(m.ramMB)} memory)${tail}`;
}

export function DictationInstall() {
  const [state, setState] = useState<DictationState | null>(null);
  const [failed, setFailed] = useState(false);
  const [picking, setPicking] = useState(false);
  const [pick, setPick] = useState<string>('');
  const [sending, setSending] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);

  const read = useCallback(async () => {
    try {
      const res = await fetch('/api/agent/voice/dictation');
      if (!res.ok) { setFailed(true); return null; }
      setFailed(false);
      const s = await res.json() as DictationState;
      setState((prev) => {
        // Ready now (or no longer): every composer's mic gate asks again (K7).
        if (prev && prev.installed !== s.installed) notifyDictationChanged();
        return s;
      });
      return s;
    } catch {
      setFailed(true);
      return null;
    }
  }, []);

  const choose = useCallback(async (value: string) => {
    const body = value === CLOUD ? { engine: 'cloud' } : { engine: 'local', model: value };
    setSending(true);
    setPostError(null);
    try {
      const res = await fetch('/api/agent/voice/dictation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null) as { message?: string } | null;
        setPostError(err?.message ?? 'The choice could not be saved. Try again.');
        return;
      }
      const s = await res.json() as DictationState;
      setState(s);
      setPicking(false);
      notifyDictationChanged();
    } catch {
      setPostError('dreamcontext could not be reached. Try again.');
    } finally {
      setSending(false);
    }
  }, []);

  useEffect(() => { void read(); }, [read]);
  // A key saved elsewhere on the card (or in setup) makes the cloud ready: read again then.
  useEffect(() => {
    const again = () => { void read(); };
    window.addEventListener(DICTATION_CHANGED_EVENT, again);
    return () => window.removeEventListener(DICTATION_CHANGED_EVENT, again);
  }, [read]);

  const busy = state?.phase === 'engine' || state?.phase === 'model';
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => { void read(); }, POLL_MS);
    return () => clearInterval(t);
  }, [busy, read]);

  if (failed && !state) {
    return (
      <div className="dictation-install">
        <p className="settings-field-hint">Dictation status is unavailable here.</p>
        <button type="button" className="btn btn--secondary" onClick={() => { void read(); }}>Try again</button>
      </div>
    );
  }
  if (!state) return <p className="settings-field-hint">Checking dictation…</p>;

  if (busy) {
    const pct = state.total > 0 ? Math.min(100, Math.round((state.received / state.total) * 100)) : null;
    return (
      <div className="dictation-install" role="status" aria-live="polite">
        <p className="settings-field-hint">
          {state.phase === 'engine'
            ? 'Installing the speech engine (whisper.cpp) with Homebrew…'
            : pct !== null
              ? `Downloading the ${state.pending ? `${state.pending} ` : ''}speech model — ${gb(state.received)} of ${gb(state.total)}`
              : 'Downloading the speech model…'}
        </p>
        <p className="settings-field-hint">The current setting keeps working until this finishes; you can choose again then.</p>
        {state.phase === 'model' && (
          <progress className="dictation-install__bar" max={100} value={pct ?? undefined} aria-label="Speech model download" />
        )}
      </div>
    );
  }

  // What is in use, and the way to change it. A legacy install (from before the choice) counts.
  const settled = !picking && state.phase !== 'error' && (state.choice !== null || state.installed);
  if (settled) {
    const cloud = state.choice?.engine === 'cloud';
    const line = cloud
      ? state.key
        ? 'Cloud — OpenRouter transcribes each take. Nothing runs on this Mac.'
        : 'Cloud is chosen, but no OpenRouter key is set yet. Add it in the OpenRouter key field.'
      : state.blocked === 'too_big'
        ? `${state.model} is too large for this Mac's ${state.machine.memGB} GB of memory, so it is not loaded. Choose ${state.recommended} or the cloud.`
        : state.blocked === 'load_failed'
          ? `${state.model} could not be loaded on this Mac. Choose a smaller model or the cloud.`
          : state.installed
            ? `On this Mac — whisper.cpp ${state.model}. Loaded on your first take, unloaded when idle or when the Mac is under load. Nothing you say leaves it.`
            : 'The chosen model is not installed yet.';
    return (
      <div className="dictation-install">
        <p className="settings-field-hint" role={state.blocked ? 'alert' : 'status'}>{line}</p>
        <button
          type="button"
          className="btn btn--secondary"
          onClick={() => {
            setPick(cloud ? CLOUD : state.choice?.model ?? state.recommended);
            setPicking(true);
          }}
        >
          Change
        </button>
      </div>
    );
  }

  const value = pick || state.recommended;
  const chosen = state.models.find((m) => m.id === value);
  const canCancel = state.choice !== null || state.installed;
  return (
    <div className="dictation-install">
      <p className="settings-field-hint" role={state.phase === 'error' ? 'alert' : undefined}>
        {state.phase === 'error' && state.error
          ? state.error
          : `Choose where dictation runs. Nothing is downloaded until you choose. This Mac has ${state.machine.memGB} GB of memory, so ${state.recommended} is preselected.`}
      </p>
      <select
        className="settings-text-input dictation-install__select"
        aria-label="Dictation engine"
        value={value}
        onChange={(e) => setPick(e.target.value)}
      >
        {state.models.map((m) => (
          <option key={m.id} value={m.id} disabled={!m.fits}>{optionLabel(m, state.recommended)}</option>
        ))}
        <option value={CLOUD}>Cloud — OpenRouter (uses your OpenRouter key; audio leaves this Mac)</option>
      </select>
      {value !== CLOUD && !state.engine && !state.brew && (
        <p className="settings-field-hint">A local model needs whisper.cpp, and installing it needs Homebrew (brew.sh).</p>
      )}
      {postError && <p className="settings-field-hint" role="alert">{postError}</p>}
      <div className="dictation-install__actions">
        <button
          type="button"
          className="btn btn--secondary"
          disabled={sending || (value !== CLOUD && chosen?.fits === false)}
          onClick={() => { void choose(value); }}
        >
          {value === CLOUD
            ? 'Use the cloud'
            : chosen?.onDisk && state.engine ? `Use ${value}` : `Install ${value}`}
        </button>
        {canCancel && (
          <button type="button" className="btn btn--ghost" disabled={sending} onClick={() => { setPicking(false); setPostError(null); }}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
