import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { closeSleepyWindow } from '../lib/sleepy';
import './CaptureBar.css';

interface Vault {
  name: string;
  path: string;
}

type Status = 'idle' | 'saving' | 'saved' | 'error';

const LAST_VAULT_KEY = 'sleepy:lastVault';

/**
 * The notch quick-capture bar. Pick a project, type a thought, hit return — the
 * note is captured into that project's dreamcontext (instant memory + headless
 * claude enrichment). Esc closes. Rendered transparently in its own notch window.
 */
export function CaptureBar() {
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [vault, setVault] = useState('');
  const [text, setText] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const inputRef = useRef<HTMLInputElement>(null);

  // Transparent window: drop the page background so only the frosted bar shows.
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

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') void closeSleepyWindow();
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
      window.setTimeout(() => setStatus('idle'), 1300);
      inputRef.current?.focus();
    } catch {
      setStatus('error');
      window.setTimeout(() => setStatus('idle'), 2200);
    }
  }

  return (
    <div className="cap-root">
      <div className={`cap-bar cap-${status}`} data-tauri-drag-region>
        <span className="cap-mark" aria-hidden>
          ◆
        </span>
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
        <input
          ref={inputRef}
          className="cap-input"
          type="text"
          placeholder="Capture a thought…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
        />
        <span className={`cap-status cap-status-${status}`} aria-hidden>
          {status === 'saving' ? '•••' : status === 'saved' ? '✓' : status === 'error' ? '!' : '⏎'}
        </span>
      </div>
      <div className="cap-hint">
        {status === 'saved'
          ? 'Captured — it will be learned.'
          : status === 'error'
            ? 'Could not capture.'
            : 'Return to capture · Esc to close'}
      </div>
    </div>
  );
}
