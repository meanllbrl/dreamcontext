import { useEffect, useRef, useState, useCallback, type CSSProperties } from 'react';
import { api } from '../../api/client';
import { ACCENT, type Capabilities, type ConfirmRequest } from './agentSession';

/**
 * The non-terminal chrome of the Agent surface: the destructive-action confirmation
 * sheet, the bypass toggles, the prerequisite installer, and the small presentational
 * helpers + shared inline styles used by the surface's intro/empty states.
 */

// ── Native-style confirmation sheet (guards destructive session actions) ─────────

export function ConfirmDialog({ req, onConfirm, onCancel }: {
  req: ConfirmRequest;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const btnRef = useRef<HTMLButtonElement | null>(null);
  // Land focus on the confirm button so ↵ confirms and the sheet reads to AT.
  useEffect(() => { btnRef.current?.focus(); }, []);
  // ↵ confirms · esc cancels — captured at the window so the keystrokes never leak
  // into the (now-backgrounded) terminal underneath.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); onConfirm(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onConfirm, onCancel]);

  return (
    <div className="agent-confirm-scrim" onMouseDown={onCancel}>
      <div
        className="agent-confirm"
        role="alertdialog"
        aria-modal="true"
        aria-label={req.title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className={'agent-confirm-icon ' + req.tone} aria-hidden>{req.tone === 'danger' ? '!' : '↻'}</div>
        <div className="agent-confirm-title">{req.title}</div>
        <div className="agent-confirm-msg">{req.message}</div>
        <div className="agent-confirm-actions">
          <button
            className="agent-confirm-btn ghost"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onCancel}
          >Cancel</button>
          <button
            ref={btnRef}
            className={'agent-confirm-btn ' + req.tone}
            onClick={onConfirm}
          >{req.confirmLabel}</button>
        </div>
        <div className="agent-confirm-hint"><kbd>↵</kbd> confirm<span>·</span><kbd>esc</kbd> cancel</div>
      </div>
    </div>
  );
}

// ── Bypass UI ─────────────────────────────────────────────────────────────────

export function BypassToggle({ bypass, setBypass }: { bypass: boolean; setBypass: (b: boolean) => void }) {
  return (
    <div style={{ marginTop: '24px', width: '100%', maxWidth: '440px' }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', userSelect: 'none' }}>
        <input type="checkbox" checked={bypass} onChange={e => setBypass(e.target.checked)} style={{ accentColor: 'var(--color-error)', width: '16px', height: '16px' }} />
        <span style={{ fontSize: '13.5px', color: 'var(--color-text-secondary)' }}>Bypass permissions <span style={{ color: 'var(--color-text-tertiary)' }}>— skip per-action approval prompts</span></span>
      </label>
      {bypass && (
        <div style={bannerStyle}>
          ⚠ Bypass is ON — new sessions can edit files and run commands in this project <strong>without asking</strong>. Only use it when you trust the task.
        </div>
      )}
    </div>
  );
}

export function BypassPill({ bypass, setBypass }: { bypass: boolean; setBypass: (b: boolean) => void }) {
  return (
    <label title="Default for NEW sessions (each pane shows ⚡ while armed)" className={'agent-term-pill' + (bypass ? ' on' : '')}>
      <input type="checkbox" checked={bypass} onChange={e => setBypass(e.target.checked)} />
      bypass
    </label>
  );
}

// ── Setup panel: one-click install of the embedded terminal's prerequisites ──────
// Shown when `claude` and/or `node-pty` are missing. Each install runs server-side
// in the user's login shell (so a Finder-launched app sees their real PATH) and is
// polled to completion; a success re-checks capabilities so the row flips to ready.

type InstallTarget = 'claude' | 'pty';

export function Prereqs({ caps, onRefresh }: { caps: Capabilities; onRefresh: () => Promise<Capabilities | null> }) {
  const [busy, setBusy] = useState<InstallTarget | null>(null);
  const [log, setLog] = useState('');
  const [err, setErr] = useState('');

  const runInstall = useCallback(async (target: InstallTarget) => {
    setBusy(target); setErr(''); setLog('');
    try {
      const { runId } = await api.post<{ ok: boolean; runId: string }>('/agent/install', { target });
      // Poll until the background install ends (the server watchdog caps it ~5 min).
      for (let i = 0; i < 260; i++) {
        await new Promise(r => setTimeout(r, 1300));
        const s = await api.get<{ state: string; output: string }>(`/agent/install/status?id=${encodeURIComponent(runId)}`);
        if (s.output) setLog(s.output);
        if (s.state === 'done') { await onRefresh(); return; }
        if (s.state === 'error') { setErr(s.output || 'Install failed.'); return; }
        if (s.state === 'unknown') { setErr('The install run expired before it finished.'); return; }
      }
      setErr('Install is taking unusually long — check a real terminal.');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not start the install.');
    } finally {
      setBusy(null);
    }
  }, [onRefresh]);

  const rows: { target: InstallTarget; label: string; ok: boolean; desc: string }[] = [
    { target: 'claude', label: 'Claude CLI', ok: caps.claudeCli, desc: 'Anthropic’s claude command — the agent that runs in the terminal.' },
    { target: 'pty', label: 'Embedded terminal engine', ok: caps.nodePty, desc: 'The native node-pty module that renders Claude Code in-app.' },
  ];
  const canInstall = caps.npm;
  const blocked = !canInstall || busy !== null;

  return (
    <div style={{ marginTop: '22px', width: '100%', maxWidth: '440px', textAlign: 'left' }}>
      <p style={{ ...subStyle, fontSize: '13px', marginBottom: '12px', color: 'var(--color-text-tertiary)' }}>
        Set up what the in-app terminal needs:
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {rows.map(row => (
          <div key={row.target} style={prereqRow}>
            <span style={{ fontSize: '15px', width: '18px', flexShrink: 0, textAlign: 'center' }}>{row.ok ? '✅' : '⬜'}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '13.5px', fontWeight: 600, color: 'var(--color-text)' }}>{row.label}</div>
              <div style={{ fontSize: '12px', color: 'var(--color-text-tertiary)', lineHeight: 1.4 }}>{row.desc}</div>
            </div>
            {row.ok
              ? <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--color-success)', flexShrink: 0 }}>Ready</span>
              : (
                <button
                  onClick={() => runInstall(row.target)}
                  disabled={blocked}
                  style={{ ...secondaryBtn, padding: '7px 14px', fontSize: '13px', flexShrink: 0, opacity: blocked ? 0.55 : 1, cursor: blocked ? 'not-allowed' : 'pointer' }}
                >
                  {busy === row.target ? '⏳ Installing…' : 'Install'}
                </button>
              )}
          </div>
        ))}
      </div>

      {!canInstall && (
        <div style={{ ...bannerStyle, marginTop: '12px', background: 'rgba(255,174,59,0.1)', border: '1px solid rgba(255,174,59,0.32)', color: 'var(--color-text-secondary)' }}>
          npm wasn’t found on your PATH, so these can’t be auto-installed. Install Node.js from <code>nodejs.org</code> (or via Homebrew), then reopen this screen.
        </div>
      )}
      {busy && log && (
        <pre style={installLog}>{log.split('\n').slice(-6).join('\n')}</pre>
      )}
      {err && <div style={{ ...bannerStyle, marginTop: '10px' }}>{err}</div>}
    </div>
  );
}

// ── Small presentational helpers ────────────────────────────────────────────────

export function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ height: '100%', width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '40px' }}>
      <div style={{ maxWidth: '560px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>{children}</div>
    </div>
  );
}

export function BotMark() {
  return (
    <div style={{ width: '76px', height: '76px', borderRadius: '20px', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '18px', background: 'linear-gradient(150deg, rgba(139,123,255,0.18), rgba(111,92,224,0.08))', border: '1px solid rgba(139,123,255,0.3)', color: ACCENT, fontFamily: 'var(--font-mono)', fontSize: '30px' }}>
      &gt;_
    </div>
  );
}

// ── Shared inline styles (exported where the surface's intro states reuse them) ──

const prereqRow: CSSProperties = { display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', borderRadius: '10px', background: 'var(--color-bg-secondary)', border: '1px solid var(--color-border)' };
const installLog: CSSProperties = { padding: '10px 12px', borderRadius: '8px', background: 'var(--color-bg-tertiary)', color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)', fontSize: '11px', lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '120px', overflow: 'auto', margin: '10px 0 0' };
const bannerStyle: CSSProperties = { marginTop: '12px', padding: '10px 14px', borderRadius: '10px', background: 'rgba(248,81,73,0.1)', border: '1px solid rgba(248,81,73,0.32)', color: '#f8a39d', fontSize: '12.5px', lineHeight: 1.5, textAlign: 'left' };

export const titleStyle: CSSProperties = { fontFamily: 'var(--font-family-display)', fontWeight: 700, fontSize: '23px', color: 'var(--color-text)', margin: '0 0 8px', letterSpacing: '-0.02em' };
export const subStyle: CSSProperties = { fontSize: '14px', color: 'var(--color-text-secondary)', margin: 0, lineHeight: 1.55 };
export const primaryBtn: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: '7px', padding: '11px 20px', borderRadius: '11px', border: 'none', cursor: 'pointer', background: 'linear-gradient(150deg,#8b7bff,#6f5ce0)', color: '#fff', fontSize: '14px', fontWeight: 600, fontFamily: 'var(--font-family-text)', boxShadow: '0 6px 18px -6px rgba(123,104,238,0.85)' };
export const secondaryBtn: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: '7px', padding: '11px 20px', borderRadius: '11px', cursor: 'pointer', background: 'var(--color-bg-secondary)', color: 'var(--color-text-secondary)', border: '1px solid var(--color-border)', fontSize: '14px', fontWeight: 600, fontFamily: 'var(--font-family-text)' };
