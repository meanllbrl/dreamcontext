import { useState, type CSSProperties } from 'react';
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

/** One connected account, as the picker draws it. */
export interface AccountOption {
  id: string;
  email: string;
  organizationName: string;
  preferred: boolean;
  state: 'ok' | 'needs-relogin';
  /** 0-100, or null when nothing is cached for this account yet. */
  sessionPercent: number | null;
}

export function UsageMenu({
  limits, staleAsOf, costUsd, accounts = [], activeAccountId = '', onAccountChange,
  contextHandoff, onContextHandoffChange,
}: {
  /** Already filtered by `usageLimits`: a cap with no readable source, a stale cache or a
   *  rolled-over window is simply ABSENT from this array. This component draws one bar per
   *  entry and has no empty state of its own — that is how "show what's found, hide what
   *  isn't" is enforced structurally rather than by a chain of conditionals here. */
  limits: UsageLimit[];
  staleAsOf: number | null;
  costUsd: number | null;
  /**
   * The connected accounts. EMPTY on a machine with fewer than two, and the picker then draws
   * NOTHING — a single-account user never learns this menu grew a section.
   *
   * It lives HERE rather than as a fourth composer chip because an account IS a usage
   * question: this menu already draws the windows that decide which account can serve a turn,
   * so the choice belongs beside the numbers behind it.
   */
  accounts?: AccountOption[];
  activeAccountId?: string;
  /** Absent ⇒ read-only rows. Present ⇒ picking one RESPAWNS the conversation at the turn
   *  boundary; the row says so, because a picker that silently does nothing is not acceptable
   *  and one that silently restarts is worse. */
  onAccountChange?: (accountId: string) => void;
  /** This pane's context-handoff toggle as the SERVER has it. Absent ⇒ the switch row is
   *  not drawn at all (an unpinned pane has no tab file to hold a toggle), and the context
   *  bar renders exactly as it did before the feature. */
  contextHandoff?: { enabled: boolean; nudgeAt: number; remindEvery: number };
  onContextHandoffChange?: (enabled: boolean) => void;
}) {
  const now = Date.now();
  // The context reading and the account windows answer DIFFERENT questions — "is this
  // conversation full?" versus "is this account spent?" — so they stop being one
  // undifferentiated stack of identical bars. Splitting here is what lets the context
  // block keep its full weight (title, bar, arithmetic, the switch that changes it) while
  // the timed windows collapse to two compact lines each under one shared label.
  const context = limits.find((l) => l.key === 'context');
  const windows = limits.filter((l) => l.key !== 'context');

  return (
    <div className="chat-cmp-usagemenu" role="menu" aria-label="Session usage">
      {context && (() => {
        // The handoff threshold, as a fraction of the window. Present only when the pane
        // has handoff ON (usageLimits() drops it otherwise).
        const handoffAt = context.detail?.handoffAt;
        const markPct = handoffAt && context.detail ? (handoffAt / context.detail.limit) * 100 : null;
        const pastKnee = !!(handoffAt && context.detail && context.detail.used >= handoffAt);
        return (
          <div className="chat-cmp-usageblock">
            <div className="chat-cmp-usagerow">
              <span className="chat-cmp-usagerow-title">{context.title}</span>
              <span className="chat-cmp-usagerow-value">{Math.round(context.percent)}%</span>
            </div>
            <div
              className="chat-cmp-usagebar"
              data-handoff={markPct !== null ? '' : undefined}
              // Geometry only — the CSS owns every colour; this just tells the
              // lighter-track gradient WHERE the threshold falls.
              style={markPct !== null ? ({ '--handoff-mark': `${Math.min(100, markPct)}%` } as CSSProperties) : undefined}
            >
              <span
                className="chat-cmp-usagebar-fill"
                data-past-knee={pastKnee ? '' : undefined}
                style={{ width: `${Math.min(100, context.percent)}%` }}
              />
              {/* The threshold tick. Drawn ON the track rather than as a separate row so
                  the eye reads "this point on this bar" — the whole reason the marker
                  exists is to make the number in the meta line below spatial. */}
              {markPct !== null && (
                <span className="chat-cmp-usagebar-mark" style={{ left: `${Math.min(100, markPct)}%` }} />
              )}
            </div>
            {context.detail && (
              // Two facts, one line, and it STAYS one line: the words "used" and "the agent
              // may" were what wrapped this into a four-line tangle at 244px, and a
              // measurement that reflows is a measurement you re-read every time.
              <div className="chat-cmp-usagemeta">
                <span>{fmtTokens(context.detail.used)} / {fmtTokens(context.detail.limit)}</span>
                {handoffAt
                  ? (
                    <span data-past-knee={pastKnee ? '' : undefined}>
                      {pastKnee ? `past ${fmtTokens(handoffAt)} · may hand off` : `hand off ${fmtTokens(handoffAt)}`}
                    </span>
                  )
                  : <span>{fmtTokens(Math.max(0, context.detail.limit - context.detail.used))} free</span>}
              </div>
            )}
            {/* The switch sits UNDER the bar it changes — the setting is about this number,
                and putting it anywhere else would make the reader hunt for what the
                marker means. */}
            {contextHandoff && (
              <div className="chat-cmp-handoffrow">
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={contextHandoff.enabled}
                  className="chat-cmp-handoffswitch"
                  disabled={!onContextHandoffChange}
                  onClick={() => onContextHandoffChange?.(!contextHandoff.enabled)}
                >
                  <span className="chat-cmp-handoffswitch-label">
                    Hand off at {fmtTokens(contextHandoff.nudgeAt)}
                  </span>
                  <span className="chat-cmp-handoffswitch-track" data-on={contextHandoff.enabled ? '' : undefined}>
                    <span className="chat-cmp-handoffswitch-knob" />
                  </span>
                </button>
                <p className="chat-cmp-handoffnote">
                  At {fmtTokens(contextHandoff.nudgeAt)} the agent is asked to write its state
                  into the task and continue in a fresh session — it picks the moment.
                </p>
              </div>
            )}
          </div>
        );
      })()}

      {windows.length > 0 && (
        <div className="chat-cmp-usageblock">
          <span className="chat-cmp-grouplabel">Rate limits</span>
          {windows.map((l) => (
            // Two lines, not four: the window's name and when it rolls over are the SAME
            // fact ("this cap, this long"), so they share a line and the bar carries the
            // rest. Dividers between them are gone — they are peers in one group, and a
            // rule between peers reads as a boundary that isn't there.
            <div key={l.key} className="chat-cmp-windowrow">
              <div className="chat-cmp-usagerow">
                <span className="chat-cmp-windowrow-title">
                  {l.title}
                  {l.resetsAt != null && (
                    <span className="chat-cmp-windowrow-reset"> · resets {fmtResetIn(l.resetsAt, now)}</span>
                  )}
                </span>
                <span className="chat-cmp-usagerow-value is-sm">{Math.round(l.percent)}%</span>
              </div>
              <div className="chat-cmp-usagebar">
                <span className="chat-cmp-usagebar-fill" style={{ width: `${Math.min(100, l.percent)}%` }} />
              </div>
            </div>
          ))}
        </div>
      )}

      {accounts.length > 1 && (
        <div className="chat-cmp-usageblock">
          <span className="chat-cmp-grouplabel">Account</span>
          <p className="chat-cmp-usagenote">Switching restarts this chat after this turn.</p>
          <div className="chat-cmp-acctlist">
            {accounts.map((a) => {
              const active = a.id === activeAccountId;
              const label = a.email || a.id;
              return (
                // Borderless rows in one list, not four bordered cards: a boxed row per
                // account made the picker the heaviest object in a panel that is mostly
                // measurements. Only the ACTIVE one gets a surface, because only it is
                // making a claim.
                <button
                  key={a.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={active}
                  className={`chat-cmp-acctrow${active ? ' is-active' : ''}`}
                  disabled={!onAccountChange || a.state === 'needs-relogin'}
                  title={a.state === 'needs-relogin'
                    ? `${label} needs to sign in again`
                    : a.organizationName || label}
                  onClick={() => { if (!active) onAccountChange?.(a.id); }}
                >
                  {/* `min-width: 0` + ellipsis on the NAME is what keeps everything to its
                      right on-panel — the old row let a long email push the "preferred"
                      badge off the edge, where it rendered as a clipped word. */}
                  <span className="chat-cmp-acctrow-name">{label}</span>
                  {a.preferred && <span className="chat-cmp-acctrow-flag">preferred</span>}
                  <span
                    className="chat-cmp-acctrow-meta"
                    data-warn={a.state === 'needs-relogin' ? '' : undefined}
                  >
                    {a.state === 'needs-relogin'
                      ? 'sign in again'
                      : a.sessionPercent === null ? '—' : `${Math.round(a.sessionPercent)}%`}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {(costUsd != null || staleAsOf != null) && (
        <div className="chat-cmp-usagefoot">
          {costUsd != null && (
            <>
              <div className="chat-cmp-usagerow">
                <span className="chat-cmp-windowrow-title">Estimated cost</span>
                <span className="chat-cmp-usagerow-value is-sm">{fmtCost(costUsd)}</span>
              </div>
              <p className="chat-cmp-usagenote">
                At public API rates. A Max/Pro plan is flat-rate, so this is a what-if.
              </p>
            </>
          )}
          {staleAsOf != null && (
            <p className="chat-cmp-usagenote">Account usage as of {fmtClock(staleAsOf)}.</p>
          )}
        </div>
      )}
    </div>
  );
}
