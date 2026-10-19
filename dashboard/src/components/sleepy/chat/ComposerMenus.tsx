import { useState } from 'react';
import {
  CONTEXT_TIGHT_PCT,
  contextBands,
  effortAt, effortIndex, effortLabel, fmtCost, fmtTokens, modelNoteFor, splitModels,
  type ModelConfig, type ModelOption, type UsageLimit,
} from '../../../lib/agentComposer';
import { CHAT_MODE_ROWS, type ChatMode } from '../../../lib/chatModes';
import { MaturityTag } from '../../common/MaturityTag';
import { SleepyMascot } from '../SleepyMascot';
import { AgentAvatar } from '../../agents/AgentAvatar';
import { useAgents } from '../../../hooks/useAgents';
import { requestOpenAgents } from '../../../lib/openAgents';
import { useI18n } from '../../../context/I18nContext';

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

// ── Agent (who this chat talks to) ───────────────────────────────────────────────────

/** An agent picked in the composer: what the surface needs to open its chat. */
export interface ChatAgentPick {
  slug: string;
  title: string;
}

const Check = () => (
  <svg className="chat-cmp-pickrow-check" width="16" height="16" viewBox="0 0 16 16" aria-hidden>
    <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/**
 * WHO this chat talks to, listed under the modes the way a model picker lists models (owner,
 * 2026-10-12). The rows are the AGENT roster (`/api/agents`, the list the whiteboard reads), not
 * the automations: an agent is who does the work, and one you only ever talk to has no
 * automation at all.
 *
 * Conversation asks the CHAT verdict (`approvedForChat`), never the run one. An agent approved
 * for chat is one row, picked as is. One that is not is still listed, with a note, and picking
 * it opens it on the Agents page, where approval happens in place: the composer never approves.
 *
 * Picking an agent opens a NEW conversation with it (AgentSurface's `pickChatAgent`). "Claude"
 * is the way back, so it is only listed while an agent holds the chat: otherwise the modes
 * above already ARE Claude, and a row repeating them would be a second answer to one question.
 */
function AgentList({ agent, onPick, close }: {
  agent: string;
  onPick: (agent: ChatAgentPick | null) => void;
  close: () => void;
}) {
  const { t } = useI18n();
  const tx = (k: string, fallback: string) => { const v = t(k); return v === k ? fallback : v; };
  const { data: agents = [] } = useAgents();
  if (agents.length === 0 && !agent) return null;
  const pick = (next: ChatAgentPick | null) => { onPick(next); close(); };
  const openOnAgentsPage = (slug: string) => { requestOpenAgents({ slug }); close(); };
  const row = (slug: string | null, title: string, hasPhoto: boolean, opts: { unapproved?: boolean; tip?: string } = {}) => {
    const selected = (slug ?? '') === agent;
    return (
      <button
        key={slug ?? 'claude'}
        type="button"
        role="menuitemradio"
        aria-checked={selected}
        title={opts.tip}
        className={`chat-cmp-pickrow${selected ? ' is-active' : ''}${opts.unapproved ? ' is-unapproved' : ''}`}
        data-agent={slug ?? ''}
        onClick={() => {
          if (slug && opts.unapproved) openOnAgentsPage(slug);
          else pick(slug ? { slug, title } : null);
        }}
      >
        <span className={`chat-cmp-agentface${slug ? '' : ' is-claude'}`} aria-hidden>
          {slug
            ? <AgentAvatar slug={slug} title={title} hasPhoto={hasPhoto} size={24} of="agent" />
            : <SleepyMascot size={24} mood="idle" compact mode="basic" />}
        </span>
        <span className="chat-cmp-pickrow-body">
          <span className="chat-cmp-pickrow-name">{title}</span>
          {opts.unapproved && (
            <span className="chat-cmp-pickrow-insight">{tx('agents.picker.unapproved', 'Not approved for chat on this Mac')}</span>
          )}
        </span>
        {selected && <Check />}
      </button>
    );
  };
  const openHint = tx('agents.roster.open', 'Open {name}');
  return (
    <>
      <div className="chat-cmp-menu-divider" />
      <span className="chat-cmp-grouplabel">{tx('agents.page.title', 'Agents')}</span>
      <div className="chat-cmp-picklist is-agents">
        {agent && row(null, 'Claude', false, { tip: 'Back to Claude, in a new chat' })}
        {agents.map((a) => row(a.slug, a.title, a.hasPhoto, a.approvedForChat
          ? { tip: oneLineAbout(a.description) }
          : { unapproved: true, tip: openHint.replace('{name}', a.title) }))}
        <button
          type="button"
          role="menuitem"
          className="chat-cmp-pickrow"
          onClick={() => { requestOpenAgents({}); close(); }}
        >
          <span className="chat-cmp-pickrow-body">
            <span className="chat-cmp-pickrow-name">{tx('agents.picker.manage', 'Manage agents')}</span>
          </span>
        </button>
      </div>
    </>
  );
}

/** An agent's prompt as a one-line tooltip: who it is, in the owner's words, never a wall. */
function oneLineAbout(description: string): string | undefined {
  const line = description.replace(/\s+/g, ' ').trim();
  if (!line) return undefined;
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}

/** The trigger's name for a chat bound to an agent: its face and title. */
export function AgentTriggerName({ slug, title, hasPhoto }: { slug: string; title: string; hasPhoto: boolean }) {
  return (
    <>
      <AgentAvatar slug={slug} title={title} hasPhoto={hasPhoto} size={16} of="agent" />
      <span className="chat-cmp-modeltrigger-model">{title}</span>
    </>
  );
}

export function ModeMenu({
  mode, onModeChange, agent = '', onAgentPick, permission, projectPermission, onPermissionChange, close,
}: {
  mode: ChatMode;
  onModeChange: (mode: ChatMode) => void;
  /** The agent this chat speaks as, `''` for Claude. */
  agent?: string;
  /** Absent = no Agent section (a surface whose agent is fixed, or that has none to offer). */
  onAgentPick?: (agent: ChatAgentPick | null) => void;
  /** THIS SESSION's permission mode, not the remembered vault default — see Composer.tsx's
   *  prop doc. Rendered verbatim; a security indicator that can disagree with the running
   *  process is worse than none. */
  permission: PermissionMode;
  /**
   * The PROJECT's remembered default — what a NEW chat in this project will open under.
   *
   * The segment used to read per-session and write per-project, and this prop existed to name
   * that asymmetry out loud. The write has since been narrowed to the session (one click was
   * respawning every pane in the vault — see AgentSurface's `changeChatPermissionMode`), so
   * the two scopes no longer disagree about what the click does. The prop survives because the
   * click still has a SECOND effect worth stating: the mode is remembered, so the next chat
   * opens under it.
   *
   * Optional: a caller with no project value to show gets the plain per-mode description it
   * always had.
   */
  projectPermission?: PermissionMode;
  onPermissionChange: (mode: PermissionMode) => void;
  close: () => void;
}) {
  const note = (PERMISSIONS.find((p) => p.id === permission) ?? PERMISSIONS[0]).desc;
  // ALWAYS stated, not only when the two diverge. A scope line that appears exactly when
  // something is unusual teaches the user to read its ABSENCE as "this applies everywhere",
  // which is the misreading it exists to prevent — and both halves of the sentence are true
  // on every click.
  const scopeNote = projectPermission
    ? `Applies to this chat, and becomes the default for new chats (currently: ${projectPermission}).`
    : null;
  return (
    <div className="chat-cmp-modemenu chat-cmp-modelmenu" role="menu" aria-label="Mode and permission">
      <span className="chat-cmp-grouplabel">Modes</span>
      {/* One row per mode, the way a model picker lists models: face, name, the version of
          its brief. Only the CHOSEN row says what it does; the rest say it on hover, so the
          list reads at a glance and the sentence you need is the one under your pick.

          A mode is a system-prompt append, applied when the process starts, so switching
          restarts the conversation under the new brief. The transcript survives (`--resume`)
          and so does a half-typed draft (AgentSurface's `carryDraftInto`). That used to be a
          paragraph under the grid; it is now each row's tooltip, beside the click it is
          about. */}
      <div className="chat-cmp-picklist">
        {CHAT_MODE_ROWS.map((row) => {
          const active = row.id === mode;
          return (
            <button
              key={row.id}
              type="button"
              role="menuitemradio"
              aria-checked={active}
              disabled={row.disabled}
              title={active ? undefined : `${row.insight} Switching reloads this conversation; the transcript and your draft are kept.`}
              className={`chat-cmp-pickrow is-mode${active ? ' is-active' : ''}`}
              onClick={() => { if (!active) onModeChange(row.id); close(); }}
            >
              <span className="chat-cmp-pickrow-face" aria-hidden>
                <SleepyMascot size={28} mood="idle" compact mode={row.id} />
              </span>
              <span className="chat-cmp-pickrow-body">
                <span className="chat-cmp-pickrow-line">
                  <span className="chat-cmp-pickrow-name">{row.name}</span>
                  <span className="chat-cmp-pickrow-version">{row.version}</span>
                  {/* `label`, so the chip is MUTED whichever field it came from: `badge` is a
                      mode you cannot pick, `maturity` one that is not finished, and neither
                      is a recommendation. chatModes.ts owns the distinction. */}
                  <MaturityTag label={row.badge ?? row.maturity} className="chat-cmp-badge" />
                </span>
                {active && <span className="chat-cmp-pickrow-insight">{row.insight}</span>}
              </span>
              {active && <Check />}
            </button>
          );
        })}
      </div>

      {onAgentPick && <AgentList agent={agent} onPick={onAgentPick} close={close} />}

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
        {/* NOT a MaturityTag, deliberately: this badge says "Recommended" — it steers you
            TOWARD the row. A maturity chip makes the opposite claim ("not finished") and is
            muted for that reason, so routing this through it would both misname the thing
            and grey out the one word in the menu whose job is to stand out. It keeps
            `.chat-cmp-badge`'s accent rules, which now exist for this row alone. */}
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
  contextHandoff?: { enabled: boolean; nudgeAt: number; hardAt: number; remindEvery: number };
  onContextHandoffChange?: (enabled: boolean) => void;
}) {
  const [acctOpen, setAcctOpen] = useState(false);
  const now = Date.now();
  // The context reading and the account windows answer DIFFERENT questions — "is this
  // conversation full?" versus "is this account spent?" — so they stop being one
  // undifferentiated stack of identical bars. The split is also what lets the context
  // block stay PINNED while everything under it scrolls (see the panel's max-height):
  // the reading you opened the panel for can never be the part that falls off-screen.
  const context = limits.find((l) => l.key === 'context');
  const windows = limits.filter((l) => l.key !== 'context');

  return (
    <div className="chat-cmp-usagemenu" role="menu" aria-label="Session usage">
      {context && (() => {
        // The handoff threshold, as a fraction of the window. Present only when the pane
        // has handoff ON (usageLimits() drops it otherwise).
        const handoffAt = context.detail?.handoffAt;
        return (
          <div className="chat-cmp-usageblock is-lead">
            <div className="chat-cmp-usagerow">
              <span className="chat-cmp-usagerow-title">{context.title}</span>
              <span className="chat-cmp-usagerow-value">{Math.round(context.percent)}%</span>
            </div>
            {/* The same three bands the composer's gauge draws, laid flat. One reading, one
                language: the gauge says how many bands are lit, this says where inside them
                you are — and neither can invent a tone the other doesn't have, because both
                read `contextBands()`. Each segment is as wide as its share of the window, so
                the seams ARE the 300k and 650k marks and no separate tick is needed for them. */}
            <div className="chat-cmp-bandbar">
              {(context.detail ? contextBands(context.detail.used, context.detail.limit) : []).map((band) => {
                const share = (band.to - band.from) / (context.detail!.limit || 1);
                const tickAt = handoffAt && handoffAt > band.from && handoffAt < band.to
                  ? ((handoffAt - band.from) / (band.to - band.from)) * 100
                  : null;
                return (
                  <div key={band.key} className="chat-cmp-bandseg" style={{ flexGrow: share }}>
                    <span
                      className="chat-cmp-bandseg-fill"
                      data-band={band.key}
                      style={{ width: `${band.frac * 100}%` }}
                    />
                    {tickAt !== null && (
                      <span className="chat-cmp-bandseg-mark" style={{ left: `${tickAt}%` }} />
                    )}
                  </div>
                );
              })}
            </div>
            {context.detail && (
              // The threshold NUMBER is deliberately absent here. It was being said three
              // times inside 40px — meta line, switch label, explanatory note — and a
              // value repeated three times is not emphasis, it is noise. The bar's tick
              // says WHERE the threshold is, the switch label below says WHAT it is, and
              // this line is left to say the one thing neither of them can: the count.
              <div className="chat-cmp-usagemeta">
                <span>{fmtTokens(context.detail.used)} / {fmtTokens(context.detail.limit)}</span>
                <span>{fmtTokens(Math.max(0, context.detail.limit - context.detail.used))} free</span>
              </div>
            )}
            {/* The switch sits UNDER the bar it changes — the setting is about this number,
                and putting it anywhere else would make the reader hunt for what the
                marker means. */}
            {/* A car's ECO badge, not a settings toggle: the pill IS the control, it lights
                when the mode is on, and it says what it does in one line rather than in a
                paragraph underneath. The glyph never travels alone — a state with no
                universal symbol needs its word beside it. */}
            {contextHandoff && (
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={contextHandoff.enabled}
                className="chat-cmp-eco"
                data-on={contextHandoff.enabled ? '' : undefined}
                title={`ECO mode — past ${fmtTokens(contextHandoff.nudgeAt)} the agent is told to write its state into the task and continue in a fresh session unless it has a reason not to. Past ${fmtTokens(contextHandoff.hardAt)} it is told to hand off, and to tell you if it decides otherwise. It decides; ECO is what asks.`}
                disabled={!onContextHandoffChange}
                onClick={() => onContextHandoffChange?.(!contextHandoff.enabled)}
              >
                <svg className="chat-cmp-eco-glyph" viewBox="0 0 24 24" aria-hidden>
                  <path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.5 19 2c1 2 2 4.2 2 8 0 5.5-4.8 10-10 10Z" />
                  <path d="M2 21c0-3 1.9-5.4 5.1-6C9.5 14.5 12 13 13 12" />
                </svg>
                <span className="chat-cmp-eco-name">ECO</span>
                <span className="chat-cmp-eco-meaning">
                  {/* Two verbs, two numbers — the lamp has to carry the ESCALATION, not
                      just a threshold. The old wording ("hands off at 200k") stated as
                      fact something the agent may decline, so the owner read a promise
                      and watched it never happen. */}
                  {contextHandoff.enabled
                    ? `asks at ${fmtTokens(contextHandoff.nudgeAt)} · insists at ${fmtTokens(contextHandoff.hardAt)}`
                    : 'off'}
                </span>
              </button>
            )}
          </div>
        );
      })()}

      {/* Everything below the headline scrolls. Without this the panel simply grew past the
          window and the overflow was CLIPPED — no scrollbar, no affordance, the footer cut
          through the middle of a sentence. It grows upward out of the composer, so the part
          that leaves the screen is the top: the context reading itself. */}
      <div className="chat-cmp-scroll">
        {windows.length > 0 && (
          <div className="chat-cmp-usageblock">
            <span className="chat-cmp-grouplabel">
              Rate limits
              {staleAsOf != null && <span className="chat-cmp-groupnote"> · as of {fmtClock(staleAsOf)}</span>}
            </span>
            {windows.map((l) => {
              // One meaning of "running out" for the whole product: the same threshold the
              // composer's ring and the /compact offer already use. A 22% window and a 95%
              // window were drawing the identical bar in the identical colour — the reading
              // you actually need to act on looked exactly like the one you don't.
              const tight = l.percent >= CONTEXT_TIGHT_PCT;
              return (
                // Two lines, not four: the window's name and when it rolls over are the
                // SAME fact ("this cap, this long"), so they share a line and the bar
                // carries the rest.
                <div key={l.key} className="chat-cmp-windowrow">
                  <div className="chat-cmp-usagerow">
                    <span className="chat-cmp-windowrow-title">
                      <span className="chat-cmp-windowrow-lead">{l.title}</span>
                      {l.resetsAt != null && (
                        <>{' '}<span className="chat-cmp-windowrow-reset">· resets {fmtResetIn(l.resetsAt, now)}</span></>
                      )}
                    </span>
                    <span className="chat-cmp-usagerow-value is-sm" data-tight={tight ? '' : undefined}>
                      {Math.round(l.percent)}%
                    </span>
                  </div>
                  <div className="chat-cmp-usagebar">
                    <span
                      className="chat-cmp-usagebar-fill"
                      data-tight={tight ? '' : undefined}
                      style={{ width: `${Math.min(100, l.percent)}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {accounts.length > 1 && (() => {
          const active = accounts.find((a) => a.id === activeAccountId) ?? accounts[0];
          const row = (a: AccountOption, isActive: boolean) => {
            const broken = a.state === 'needs-relogin';
            const tight = a.sessionPercent !== null && a.sessionPercent >= CONTEXT_TIGHT_PCT;
            return (
              <span className="chat-cmp-acct-line">
                <span className="chat-cmp-acct-name">{a.email || a.id}</span>
                <span className="chat-cmp-acct-meta" data-warn={broken ? '' : undefined} data-tight={tight ? '' : undefined}>
                  {broken ? 'sign in again' : a.sessionPercent === null ? '—' : `${Math.round(a.sessionPercent)}%`}
                </span>
                {isActive && <span className="chat-cmp-acct-caret" aria-hidden>▾</span>}
              </span>
            );
          };
          return (
            // Closed by default: four addresses stacked open were the tallest thing in a
            // panel that exists to show three numbers, and only one of them is the answer to
            // "which account am I on". The others are a click away, which is the right price
            // for something you change rarely.
            <div className="chat-cmp-acctwrap">
              <button
                type="button"
                className="chat-cmp-acct is-head"
                aria-expanded={acctOpen}
                aria-haspopup="true"
                disabled={!onAccountChange}
                title={active.organizationName || active.email || active.id}
                onClick={() => setAcctOpen((v) => !v)}
              >
                {row(active, true)}
              </button>
              {acctOpen && (
                <div className="chat-cmp-acctlist" role="group" aria-label="Switch account">
                  {/* The consequence is stated where the choice is made, not above a list you
                      may never open. */}
                  <span className="chat-cmp-acct-note">Restarts this chat</span>
                  {accounts.filter((a) => a.id !== active.id).map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={false}
                      className="chat-cmp-acct"
                      disabled={!onAccountChange || a.state === 'needs-relogin'}
                      title={a.state === 'needs-relogin'
                        ? `${a.email || a.id} — signed out, sign in again from Settings`
                        : `${a.organizationName || a.email || a.id}${a.preferred ? ' · preferred account' : ''}`}
                      onClick={() => { setAcctOpen(false); onAccountChange?.(a.id); }}
                    >
                      {row(a, false)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })()}

        {costUsd != null && (
          <div className="chat-cmp-usageblock chat-cmp-usagefoot">
            <div className="chat-cmp-usagerow" title="Estimated cost at public API rates. A Max/Pro plan is flat-rate, so this is a what-if.">
              <span className="chat-cmp-windowrow-title">
                <span className="chat-cmp-windowrow-lead">Est. cost</span>
                {' '}<span className="chat-cmp-windowrow-reset">· API rates</span>
              </span>
              <span className="chat-cmp-usagerow-value is-sm">{fmtCost(costUsd)}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
