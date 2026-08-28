import { useState } from 'react';
import {
  effortAt, effortIndex, effortLabel, fmtCost, fmtTokens, modelNoteFor, splitModels,
  type ModelConfig, type ModelOption, type UsageLimit,
} from '../../../lib/agentComposer';
import { CHAT_MODE_ROWS, type ChatMode } from '../../../lib/chatModes';
import { SleepyMascot } from '../SleepyMascot';

/**
 * The three panels behind the redesigned composer toolbar: mode+permission (left trigger),
 * model+effort (right trigger) and usage (the ring). Presentational only — every one of them
 * takes its state and its setters, holds nothing but local disclosure UI, and is mounted by
 * `Composer` under `useAnchoredMenu`'s one-open-at-a-time rule.
 *
 * They are absolutely-positioned children of `.chat-cmp`, not portaled `Popover`s: see
 * useAnchoredMenu.ts's header for why (full-card-width panels that line up with the composer's
 * own edges, the same trick `.chat-cmp-slash` uses to escape the card's `overflow: hidden`).
 */

// ── Mode + permission ────────────────────────────────────────────────────────────────

export type PermissionMode = 'auto' | 'bypass';

/** Copy preserved verbatim from the `PermissionModeMenu` this menu replaces — the wording is
 *  the same setting, and a redesign is not a reason to re-litigate what "bypass" means. */
const PERMISSIONS: Array<{ id: PermissionMode; label: string; glyph: string; desc: string }> = [
  { id: 'auto', label: 'Auto', glyph: '🛡', desc: 'Edits auto-approved, risky commands still ask.' },
  // "Reloads" is not a hedge: CLI 2.1.220 refuses every LIVE switch into bypass (a session not
  // launched with --dangerously-skip-permissions cannot acquire it), so AgentSurface's fallback
  // respawn is how this setting is actually delivered — and the user watching their pane
  // reconnect deserves to have been told. The draft rides along (`carryDraftInto`).
  { id: 'bypass', label: 'Bypass', glyph: '⚡', desc: 'Everything auto-approved — reloads this conversation. Use with care.' },
];

export function ModeMenu({
  mode, onModeChange, permission, projectPermission, onPermissionChange, close,
}: {
  mode: ChatMode;
  onModeChange: (mode: ChatMode) => void;
  /** THIS SESSION's permission mode, not the remembered vault default — see Composer.tsx's
   *  prop doc. Rendered verbatim; a security indicator that can disagree with the running
   *  process is worse than none. */
  permission: PermissionMode;
  /**
   * The PROJECT's remembered default — what a click on the segment actually writes.
   *
   * It exists because the segment reads and writes at DIFFERENT SCOPES, and that asymmetry is
   * real rather than a bug to paper over: the display has to be this session's truth (a
   * hand-off runs `auto` inside a `bypass`-remembered project, and a chip that lied about that
   * would be worse than no chip), while the write has to stay project-wide because this is the
   * vault default's only control — re-scoping it would orphan the setting, and the owner's
   * no-set-default rule for this menu forbids adding a second control to carry it.
   *
   * So the two scopes are NAMED instead of conflated. Optional: a caller that has no project
   * value to show gets the plain per-mode description it always had.
   */
  projectPermission?: PermissionMode;
  onPermissionChange: (mode: PermissionMode) => void;
  close: () => void;
}) {
  const note = (PERMISSIONS.find((p) => p.id === permission) ?? PERMISSIONS[0]).desc;
  // ALWAYS stated, not only when the two diverge. A scope line that appears exactly when
  // something is unusual teaches the user to read its ABSENCE as "this one is just for here",
  // which is the misreading it exists to prevent — and the click is project-wide either way.
  const scopeNote = projectPermission
    ? `Applies to every chat in this project (project default: ${projectPermission}).`
    : null;
  return (
    <div className="chat-cmp-modemenu chat-cmp-modelmenu" role="menu" aria-label="Mode and permission">
      <span className="chat-cmp-grouplabel">Mode</span>
      <div className="chat-cmp-scroll is-grid">
        {CHAT_MODE_ROWS.map((row) => (
          <button
            key={row.id}
            type="button"
            role="menuitemradio"
            aria-checked={row.id === mode}
            disabled={row.disabled}
            className={`chat-cmp-modelrow${row.id === mode ? ' is-active' : ''}`}
            onClick={() => { onModeChange(row.id); close(); }}
          >
            {/* The mode SHOWS itself: the same face the dock chip will wear, doing the same
                thing. Basic (and J.A.R.V.I.S) draw the bare face, which is the point — you can
                see what you are turning on and what you are turning off. */}
            <span className="chat-cmp-moderow-face" aria-hidden>
              <SleepyMascot size={54} mood="idle" compact mode={row.id} />
            </span>
            <span className="chat-cmp-modelrow-head">
              <span className="chat-cmp-modelrow-name">{row.name}</span>
              {row.badge && <span className="chat-cmp-badge is-muted">{row.badge}</span>}
            </span>
            <span className="chat-cmp-modelrow-insight">{row.insight}</span>
          </button>
        ))}
      </div>

      {/* A mode is a system-prompt append, applied when the process starts — so switching one
          restarts the conversation under the new brief. Said out loud here rather than
          discovered as a surprise reconnect; the transcript survives (`--resume`) and so does
          a half-typed draft (AgentSurface's `carryDraftInto`), which is why this line promises
          both by name. Switching to Bypass below reloads for the same reason — CLI 2.1.220
          refuses that switch live — and its own note says so. */}
      <p className="chat-cmp-permnote">Switching mode reloads this conversation — the transcript and what you&apos;ve typed are kept.</p>

      <div className="chat-cmp-menu-divider" />

      <div className="chat-cmp-permrow">
        <span className="chat-cmp-grouplabel">Permission</span>
        <span className="chat-cmp-segment">
          {PERMISSIONS.map((p) => (
            <button
              key={p.id}
              type="button"
              role="menuitemradio"
              aria-checked={p.id === permission}
              className={`chat-cmp-segment-opt is-${p.id}${p.id === permission ? ' is-active' : ''}`}
              onClick={() => { onPermissionChange(p.id); close(); }}
            >
              <span aria-hidden>{p.glyph}</span>
              <span>{p.label}</span>
            </button>
          ))}
        </span>
      </div>
      {/* Two lines, deliberately: what the mode DOES, then how far a change REACHES. The
          segment above shows this session's own mode while a click rewrites the project's —
          so the scope is spelled out rather than left to be inferred from a chip. */}
      <p className="chat-cmp-permnote">{note}</p>
      {scopeNote && <p className="chat-cmp-permnote">{scopeNote}</p>}

      {/* NO "Set as default" here, deliberately (owner call). A permission default is
          remembered per project by the surface itself; a MODE is a per-session choice, and a
          menu offering to make "Develop" the default for every future chat would be offering
          to make a working style permanent from inside a five-second decision. */}
    </div>
  );
}

// ── Model + effort ───────────────────────────────────────────────────────────────────

function ModelRow({
  option, active, onSelect,
}: {
  option: ModelOption;
  active: boolean;
  onSelect: () => void;
}) {
  const note = modelNoteFor(option.id);
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      className={`chat-cmp-modelrow${active ? ' is-active' : ''}`}
      onClick={onSelect}
    >
      <span className="chat-cmp-modelrow-head">
        <span className="chat-cmp-modelrow-name">{option.label}</span>
        {note?.badge && <span className="chat-cmp-badge">{note.badge}</span>}
        {/* Price is the SERVER's number (one table, the same one the cost estimate charges
            with). A server that can't price this id simply omits it and the row carries its
            name and sentence alone — never "$undefined/M". */}
        {option.priceIn != null && (
          <span className="chat-cmp-modelrow-meta">${option.priceIn}/M in</span>
        )}
      </span>
      {note && <span className="chat-cmp-modelrow-insight">{note.insight}</span>}
    </button>
  );
}

export function ModelMenu({
  config, model, effort, onModelChange, onEffortChange, onSetDefault, savedDefault, close,
}: {
  config: ModelConfig;
  model: string;
  effort: string;
  onModelChange: (id: string) => void;
  onEffortChange: (level: string) => void;
  /**
   * Persist THIS model + effort as the default for future chats. OPTIONAL, and the footer is
   * not rendered at all without it — deliberately, because the alternative is a button that
   * flips to "Saved as default" having saved nothing. An absent control is honest; a control
   * that reports a write it did not make is not.
   */
  onSetDefault?: () => void;
  savedDefault: boolean;
  close: () => void;
}) {
  const [otherOpen, setOtherOpen] = useState(false);
  const { primary, other } = splitModels(config, model);
  const efforts = config.efforts;
  const index = effortIndex(efforts, effort);

  return (
    <div className="chat-cmp-modelmenu" role="menu" aria-label="Model and reasoning effort">
      <span className="chat-cmp-grouplabel">Model</span>
      <div className="chat-cmp-scroll">
        {primary.map((m) => (
          <ModelRow
            key={m.id}
            option={m}
            active={m.id === model}
            onSelect={() => { onModelChange(m.id); close(); }}
          />
        ))}
        {other.length > 0 && (
          <button
            type="button"
            className="chat-cmp-disclosure"
            aria-expanded={otherOpen}
            onClick={() => setOtherOpen((v) => !v)}
          >
            <span>Other models</span>
            <span className="chat-cmp-disclosure-caret" aria-hidden>{otherOpen ? '▴' : '▾'}</span>
          </button>
        )}
        {otherOpen && other.map((m) => (
          <ModelRow
            key={m.id}
            option={m}
            active={m.id === model}
            onSelect={() => { onModelChange(m.id); close(); }}
          />
        ))}
      </div>

      {efforts.length > 0 && (
        <>
          <div className="chat-cmp-menu-divider" />
          <div className="chat-cmp-effort-head">
            <span className="chat-cmp-grouplabel">Reasoning effort</span>
            {/* `effortLabel(effort)` — the REAL string, not `efforts[index]`. An unrecognised
                level parks the thumb at 0 (see effortIndex) and this line still reads what is
                actually running. */}
            <span className="chat-cmp-effort-value">{effortLabel(effort)}</span>
          </div>
          <input
            type="range"
            className="chat-cmp-effort-slider"
            min={0}
            max={efforts.length - 1}
            step={1}
            value={index}
            aria-label="Reasoning effort"
            aria-valuetext={effortLabel(effort)}
            onChange={(e) => onEffortChange(effortAt(efforts, Number(e.target.value)))}
          />
          <div className="chat-cmp-effort-ticks" aria-hidden>
            {efforts.map((lvl, i) => (
              <span key={lvl} className={i === index ? 'is-active' : ''}>{effortLabel(lvl)}</span>
            ))}
          </div>
        </>
      )}

      {/* KEPT here (owner call), unlike the mode menu's: model and effort are a cost/quality
          preference that genuinely is the same in every new chat, and re-picking it at every
          spawn is the friction this button removes. */}
      {onSetDefault && (
        <div className="chat-cmp-menu-foot">
          <button type="button" className="chat-cmp-setdefault" onClick={onSetDefault}>
            {savedDefault ? 'Saved as default' : 'Set as default'}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Usage ────────────────────────────────────────────────────────────────────────────

/** "2h 40m" / "12m" — how long this cap's window has left. Coarse on purpose: the reading it
 *  labels is itself a cached percentage, so minute precision would imply an accuracy the
 *  number does not have. */
function fmtResetIn(resetsAt: number, now: number): string {
  const mins = Math.max(0, Math.round((resetsAt - now) / 60_000));
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** Local time, for the "as of" caption on a stale account reading. */
function fmtClock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function UsageMenu({
  limits, staleAsOf, costUsd,
}: {
  /** Already filtered by `usageLimits`: a cap with no readable source, a stale cache or a
   *  rolled-over window is simply ABSENT from this array. This component draws one bar per
   *  entry and has no empty state of its own — that is how "show what's found, hide what
   *  isn't" is enforced structurally rather than by a chain of conditionals here. */
  limits: UsageLimit[];
  staleAsOf: number | null;
  costUsd: number | null;
}) {
  const now = Date.now();
  return (
    <div className="chat-cmp-usagemenu" role="menu" aria-label="Session usage">
      {limits.map((l, i) => (
        <div key={l.key}>
          {i > 0 && <div className="chat-cmp-menu-divider" />}
          <div className="chat-cmp-usagerow">
            <span className="chat-cmp-usagerow-title">{l.title}</span>
            <span className="chat-cmp-usagerow-value">{Math.round(l.percent)}%</span>
          </div>
          <div className="chat-cmp-usagebar">
            <span className="chat-cmp-usagebar-fill" style={{ width: `${Math.min(100, l.percent)}%` }} />
          </div>
          {l.detail ? (
            <div className="chat-cmp-usagemeta">
              <span>{fmtTokens(l.detail.used)} / {fmtTokens(l.detail.limit)} used</span>
              <span>{fmtTokens(Math.max(0, l.detail.limit - l.detail.used))} free</span>
            </div>
          ) : l.resetsAt != null && (
            <div className="chat-cmp-usagemeta">
              <span>resets in {fmtResetIn(l.resetsAt, now)}</span>
            </div>
          )}
        </div>
      ))}

      {staleAsOf != null && (
        <p className="chat-cmp-usagenote">Account usage as of {fmtClock(staleAsOf)}.</p>
      )}

      {costUsd != null && (
        <>
          <div className="chat-cmp-menu-divider" />
          <div className="chat-cmp-usagerow">
            <span className="chat-cmp-usagerow-title">Estimated cost</span>
            <span className="chat-cmp-usagerow-value">{fmtCost(costUsd)}</span>
          </div>
          <p className="chat-cmp-usagenote">
            At public API rates. A Max/Pro plan is flat-rate, so this is a what-if.
          </p>
        </>
      )}
    </div>
  );
}
