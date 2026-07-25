import { Popover } from '../SkillPickerPopover';

/**
 * The remembered permission-mode DROPDOWN (not a settings checkbox), reusing the same
 * viewport-clamped `Popover` the terminal's skill picker uses. `mode` is the REMEMBERED
 * default (`agentSettings.chatPermissionMode`, T2/T7-wired) — changing it applies from
 * the next chat session, not necessarily this one; see `AgentSurface`'s centralized
 * `spawn()` bypass resolution (plan rev.3 §2 T7).
 *
 * It lives at the LEFT END OF THE COMPOSER TOOLBAR (owner reference 07-25), no longer
 * floating over the pane's top-right corner — so the trigger is a checkbox-style chip
 * reading `☑ bypass ▾` rather than a bordered pill: at a glance it answers "is this
 * conversation on a leash?", and it still opens the two-row explainer menu on click.
 */

const MODES: Array<{ id: 'auto' | 'bypass'; label: string; glyph: string; desc: string }> = [
  { id: 'auto', label: 'Auto', glyph: '🛡', desc: 'Edits auto-approved, risky commands still ask.' },
  { id: 'bypass', label: 'Bypass', glyph: '⚡', desc: 'Everything auto-approved. Use with care.' },
];

export function PermissionModeMenu({
  mode, onChange,
}: {
  mode: 'auto' | 'bypass';
  onChange: (mode: 'auto' | 'bypass') => void;
}) {
  const current = MODES.find((m) => m.id === mode) ?? MODES[0];
  return (
    <Popover
      align="left"
      trigger={(open, toggle) => (
        <button
          type="button"
          className={`chat-permmode-chip${open ? ' open' : ''}`}
          data-mode={mode}
          onClick={toggle}
          title="Permission mode for future chat sessions"
          aria-haspopup="menu"
          aria-expanded={open}
        >
          <span className="chat-permmode-box" aria-hidden>{mode === 'bypass' ? '✓' : ''}</span>
          <span className="chat-permmode-name">{current.label}</span>
          <span className="chat-permmode-caret" aria-hidden>▾</span>
        </button>
      )}
    >
      {(close) => (
        <div className="chat-permmode-menu" role="menu" aria-label="Permission mode">
          <span className="chat-permmode-menu-title">Permission mode</span>
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="menuitemradio"
              aria-checked={m.id === mode}
              className={`chat-permmode-row${m.id === mode ? ' on' : ''}`}
              data-mode={m.id}
              onClick={() => { onChange(m.id); close(); }}
            >
              <span className="chat-permmode-row-label"><span aria-hidden>{m.glyph}</span> {m.label}</span>
              <span className="chat-permmode-row-desc">{m.desc}</span>
            </button>
          ))}
        </div>
      )}
    </Popover>
  );
}
