import { useEffect, useRef, type CSSProperties } from 'react';
import { ACCENT, type ConfirmRequest } from './agentSession';

/**
 * The non-terminal chrome of the Agent surface: the destructive-action confirmation
 * sheet, the bypass toggles, and the small presentational
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

// Two-state contract: bypass OFF means AUTO — new sessions run `--permission-mode auto`
// (the CLI's auto mode; its no-flag default would be `manual`); bypass ON skips every
// prompt. The controls below present that two-state contract instead of a bare on/off
// checkbox.
export function BypassToggle({ bypass, setBypass }: { bypass: boolean; setBypass: (b: boolean) => void }) {
  return (
    <div style={{ marginTop: '24px', width: '100%', maxWidth: '440px' }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', userSelect: 'none' }}>
        <input type="checkbox" checked={bypass} onChange={e => setBypass(e.target.checked)} style={{ accentColor: 'var(--color-error)', width: '16px', height: '16px' }} />
        <span style={{ fontSize: '13.5px', color: 'var(--color-text-secondary)' }}>Bypass permissions <span style={{ color: 'var(--color-text-tertiary)' }}>— off = Auto: claude's auto permission mode</span></span>
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
    <label
      title={bypass
        ? 'Bypass: new sessions skip ALL approval prompts (each pane shows ⚡ while armed). Click for Auto.'
        : 'Auto: new sessions run in claude’s auto permission mode. Click to arm Bypass.'}
      className={'agent-term-pill' + (bypass ? ' on' : ' auto')}
    >
      <input type="checkbox" checked={bypass} onChange={e => setBypass(e.target.checked)} />
      {bypass ? 'bypass' : 'auto'}
    </label>
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

const bannerStyle: CSSProperties = { marginTop: '12px', padding: '10px 14px', borderRadius: '10px', background: 'rgba(248,81,73,0.1)', border: '1px solid rgba(248,81,73,0.32)', color: '#f8a39d', fontSize: '12.5px', lineHeight: 1.5, textAlign: 'left' };

export const titleStyle: CSSProperties = { fontFamily: 'var(--font-family-display)', fontWeight: 700, fontSize: '23px', color: 'var(--color-text)', margin: '0 0 8px', letterSpacing: '-0.02em' };
export const subStyle: CSSProperties = { fontSize: '14px', color: 'var(--color-text-secondary)', margin: 0, lineHeight: 1.55 };
export const primaryBtn: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: '7px', padding: '11px 20px', borderRadius: '11px', border: 'none', cursor: 'pointer', background: 'var(--gradient-brand-strong)', color: 'var(--color-accent-text)', fontSize: '14px', fontWeight: 600, fontFamily: 'var(--font-family-text)', boxShadow: '0 6px 18px -6px rgba(123,104,238,0.85)' };
export const secondaryBtn: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: '7px', padding: '11px 20px', borderRadius: '11px', cursor: 'pointer', background: 'var(--color-bg-secondary)', color: 'var(--color-text-secondary)', border: '1px solid var(--color-border)', fontSize: '14px', fontWeight: 600, fontFamily: 'var(--font-family-text)' };
