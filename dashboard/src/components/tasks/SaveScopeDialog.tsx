import type { CSSProperties } from 'react';
import type { SaveScope } from './boardModel';

interface SaveScopeDialogProps {
  /** What's being saved — shown in the title. e.g. "Save “At Risk”" or "Create view". */
  title: string;
  /** Whether this view already has a private (local) override, to hint the default. */
  defaultScope?: SaveScope;
  onPick: (scope: SaveScope) => void;
  onCancel: () => void;
}

const optionStyle = (accent: boolean): CSSProperties => ({
  display: 'flex', alignItems: 'flex-start', gap: 12, padding: '14px 14px', borderRadius: 11,
  cursor: 'pointer', textAlign: 'left', width: '100%',
  border: `1px solid ${accent ? 'var(--color-accent)' : 'var(--color-border)'}`,
  background: accent ? 'var(--color-accent-soft)' : 'var(--color-bg)',
  transition: 'all .12s',
});

function GlyphBox({ glyph, accent }: { glyph: string; accent: boolean }) {
  return (
    <span style={{
      flex: '0 0 auto', width: 34, height: 34, borderRadius: 9, display: 'flex', alignItems: 'center',
      justifyContent: 'center', fontSize: 16,
      background: accent ? 'var(--color-accent)' : 'var(--color-bg-tertiary)',
      color: accent ? '#fff' : 'var(--color-text-secondary)',
    }}>{glyph}</span>
  );
}

export function SaveScopeDialog({ title, defaultScope = 'shared', onPick, onCancel }: SaveScopeDialogProps) {
  return (
    <>
      <div onClick={onCancel} style={{ position: 'absolute', inset: 0, background: 'rgba(8,10,14,0.5)', zIndex: 70 }} />
      <div
        className="bd-pop"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{
          position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', zIndex: 71,
          width: 420, maxWidth: '92%', background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)',
          borderRadius: 16, boxShadow: 'var(--shadow-xl)', padding: 22,
        }}
      >
        <div style={{ fontFamily: 'var(--font-family-display)', fontWeight: 700, fontSize: 18, color: 'var(--color-text)', letterSpacing: '-0.01em' }}>{title}</div>
        <div style={{ fontSize: 13, color: 'var(--color-text-tertiary)', lineHeight: 1.5, margin: '6px 0 18px' }}>
          Choose where this view and its filter / sort / grouping combination is stored.
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <button className="bd-chip" onClick={() => onPick('shared')} style={optionStyle(defaultScope === 'shared')}>
            <GlyphBox glyph="🌐" accent={defaultScope === 'shared'} />
            <span style={{ flex: 1 }}>
              <span style={{ display: 'block', fontWeight: 650, fontSize: 14, color: 'var(--color-text)' }}>Save for everyone</span>
              <span style={{ display: 'block', fontSize: 12, color: 'var(--color-text-tertiary)', lineHeight: 1.45, marginTop: 3 }}>
                Writes to the version-controlled <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>overrides/board.json</code> — committed with your repo, shared by everyone on the project.
              </span>
            </span>
          </button>

          <button className="bd-chip" onClick={() => onPick('local')} style={optionStyle(defaultScope === 'local')}>
            <GlyphBox glyph="💻" accent={defaultScope === 'local'} />
            <span style={{ flex: 1 }}>
              <span style={{ display: 'block', fontWeight: 650, fontSize: 14, color: 'var(--color-text)' }}>Save for yourself</span>
              <span style={{ display: 'block', fontSize: 12, color: 'var(--color-text-tertiary)', lineHeight: 1.45, marginTop: 3 }}>
                Stored only on this computer (git-ignored <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>state/board.local.json</code>) — overrides the shared view just for you.
              </span>
            </span>
          </button>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 18 }}>
          <button className="bd-hover" onClick={onCancel} style={{ padding: '7px 14px', borderRadius: 9, fontSize: 12.5, color: 'var(--color-text-secondary)', background: 'transparent' }}>Cancel</button>
        </div>
      </div>
    </>
  );
}
