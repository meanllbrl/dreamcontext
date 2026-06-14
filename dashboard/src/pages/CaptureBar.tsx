import { useEffect, useRef, useState } from 'react';
import { api, setActiveVault } from '../api/client';
import { closeSelf } from '../lib/sleepy';
import './CaptureBar.css';

interface Vault {
  name: string;
  path: string;
}

type Status = 'idle' | 'saving' | 'saved' | 'error';
type Mode = 'idle' | 'sleepy' | 'sleeps';

const LAST_VAULT_KEY = 'sleepy:lastVault';

/** Map a project's sleep debt to a mascot mood. */
function modeForDebt(debt: number): Mode {
  if (debt >= 10) return 'sleeps';
  if (debt >= 4) return 'sleepy';
  return 'idle';
}

/**
 * The notch quick-capture companion. A black panel hangs from the notch with the
 * Sleepy mascot (its mood follows the selected project's sleep debt); below it an
 * input bar captures a thought into that project. Esc closes.
 */
export function CaptureBar() {
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [vault, setVault] = useState('');
  const [text, setText] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [mode, setMode] = useState<Mode>('idle');
  const inputRef = useRef<HTMLInputElement>(null);

  // Transparent window: drop the page background so only our panels show.
  useEffect(() => {
    const html = document.documentElement;
    const prevHtml = html.style.background;
    const prevBody = document.body.style.background;
    html.style.background = 'transparent';
    document.body.style.background = 'transparent';
    return () => {
      html.style.background = prevHtml;
      document.body.style.background = prevBody;
    };
  }, []);

  useEffect(() => {
    api
      .get<{ vaults: Vault[] }>('/vaults')
      .then((d) => {
        setVaults(d.vaults);
        const last = localStorage.getItem(LAST_VAULT_KEY);
        const pick = last && d.vaults.some((v) => v.name === last) ? last : d.vaults[0]?.name ?? '';
        setVault(pick);
      })
      .catch(() => setStatus('error'));
  }, []);

  // Reflect the selected project's sleep debt in the mascot's mood.
  useEffect(() => {
    if (!vault) return;
    setActiveVault(vault);
    let cancelled = false;
    api
      .get<{ debt?: number }>('/sleep')
      .then((s) => {
        if (!cancelled) setMode(modeForDebt(typeof s.debt === 'number' ? s.debt : 0));
      })
      .catch(() => {
        if (!cancelled) setMode('idle');
      });
    return () => {
      cancelled = true;
    };
  }, [vault]);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        void closeSelf();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  async function submit() {
    const t = text.trim();
    if (!t || !vault || status === 'saving') return;
    setStatus('saving');
    try {
      await api.post('/launcher/capture', { vault, text: t });
      localStorage.setItem(LAST_VAULT_KEY, vault);
      setText('');
      setStatus('saved');
      window.setTimeout(() => setStatus('idle'), 1400);
      inputRef.current?.focus();
    } catch {
      setStatus('error');
      window.setTimeout(() => setStatus('idle'), 2200);
    }
  }

  return (
    <div className="cap-root">
      {/* Black panel hanging from the notch — the mascot's home. */}
      <div className="cap-notch" data-tauri-drag-region>
        <video
          key={mode}
          className="cap-char"
          src={`/api/sleepy/video?mode=${mode}`}
          autoPlay
          loop
          muted
          playsInline
        />
      </div>

      {/* Capture input bar. */}
      <div className={`cap-bar cap-${status}`}>
        <div className="cap-bar-head">
          <span className="cap-bar-label">Project</span>
          <div className="cap-vault-wrap">
            <select
              className="cap-vault"
              value={vault}
              onChange={(e) => setVault(e.target.value)}
              aria-label="Project"
            >
              {vaults.length === 0 && <option value="">No projects</option>}
              {vaults.map((v) => (
                <option key={v.name} value={v.name}>
                  {v.name}
                </option>
              ))}
            </select>
            <span className="cap-chev" aria-hidden>
              ⌄
            </span>
          </div>
          <span className={`cap-status cap-status-${status}`} aria-hidden>
            {status === 'saving'
              ? 'saving…'
              : status === 'saved'
                ? 'captured ✓'
                : status === 'error'
                  ? 'failed'
                  : ''}
          </span>
        </div>
        <input
          ref={inputRef}
          className="cap-input"
          type="text"
          placeholder="Capture a thought or command…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
        />
      </div>
    </div>
  );
}
