/**
 * The composer's model picker, as the owner approved it in prototype r29 (Track T W4): a rail of
 * tools, a search across every tool, one-line models with ⌘1-9, a Legacy group for models a
 * newer version has replaced, and an effort chip and an account chip under the list. A tool that cannot run says so
 * and offers "Sign in". Picking a model of ANOTHER tool opens a new chat there with a summary of
 * this one, after one confirm (the parent's `onCrossTool`).
 *
 * It replaces `ModelMenu` for every chat. A chat that cannot change tool (the Super Agent, an
 * agent's chat) passes `lock`: other tools stay on view but cannot be picked, and the line under
 * them offers a new chat there. The AI Team's temporary picker keeps `ModelMenu` (it passes a
 * head/foot of its own).
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useI18n } from '../../../../context/I18nContext';
import { effortLabel } from '../../../../lib/agentComposer';
import type { AccountOption } from '../ComposerMenus';
import {
  activeRow, blockerFix, effortsFor, searchModels, shortcutFor,
  type PickerModel, type PickerTool, type PickerToolState,
} from './pickerModel';
import { CodexFix } from './CodexFix';
import './model-picker.css';

export type SettingsTarget = 'models' | 'accounts' | 'accounts-codex';

/**
 * Settings mode (the Settings window's model chip): the pick is a saved default, not this chat's
 * model. No "opens a new chat" note (a tool switch is just written), a locked tool's rail is
 * passive and says why, the effort list may be the job's own, and there is no account chip and
 * no "Models ›" (it is already Models).
 */
export interface PickerTarget {
  /** Tools this job cannot run on, with the one-line reason shown in their place. */
  lockedTools?: Partial<Record<PickerTool, string>>;
  /** The job's own effort levels (Sleep takes low, medium, high). */
  efforts?: string[];
}

export interface ModelPickerProps {
  /** Rail order: Claude, then Codex (a tool the server does not offer is absent). */
  tools: PickerToolState[];
  currentTool: PickerTool;
  model: string;
  effort: string;
  onModelChange: (id: string) => void;
  onEffortChange: (level: string) => void;
  /** A model of another tool: the parent confirms, then opens the new chat there. */
  onCrossTool: (picked: PickerModel) => void;
  /** This chat stays on its tool: why, and the way to a new chat on another one. */
  lock?: { note: string; openLabel: string; onOpen?: (tool: PickerTool) => void };
  /** This chat's tool's accounts; fewer than one draws no account chip. */
  accounts: AccountOption[];
  activeAccountId: string;
  onAccountChange?: (id: string) => void;
  autoSwitch?: { enabled: boolean; onToggle: () => void };
  /** "New chats: Opus · High": what a new chat starts with. */
  newChatsLine?: string;
  onSetDefault?: () => void;
  savedDefault?: boolean;
  onOpenSettings: (target: SettingsTarget) => void;
  close: () => void;
  target?: PickerTarget;
}

/** Each tool's mark in the rail, drawn here: the app ships no vendor artwork of its own. */
export function ToolMark({ tool }: { tool: PickerTool }) {
  if (tool === 'claude') {
    return (
      <svg className="mp-mark mp-mark--claude" viewBox="0 0 24 24" aria-hidden>
        {[0, 30, 60, 90, 120, 150].map((a) => <line key={a} x1="12" y1="2.5" x2="12" y2="21.5" transform={`rotate(${a} 12 12)`} />)}
      </svg>
    );
  }
  return (
    <svg className="mp-mark" viewBox="0 0 24 24" aria-hidden>
      {[0, 60, 120].map((a) => <ellipse key={a} cx="12" cy="12" rx="4.6" ry="9.5" transform={`rotate(${a} 12 12)`} />)}
    </svg>
  );
}

/** The rail's word for a tool that cannot run: what to do, in place of an unlabelled dot. */
function blockerWord(t: PickerToolState): string {
  if (t.blocker === 'not-installed') return 'chat.modelPicker.state.install';
  if (t.blocker === 'needs-node') return 'chat.modelPicker.state.update';
  return 'chat.modelPicker.state.signIn';
}

function blockerLine(t: PickerToolState): string {
  if (t.blocker === 'not-installed') return `${t.label} is not installed`;
  if (t.blocker === 'wont-start') return `${t.label} is installed but does not start`;
  if (t.blocker === 'outdated') return `${t.label} needs an update`;
  if (t.blocker === 'needs-node') return `${t.label} needs Node 22.16 or newer`;
  return `${t.label} is not signed in`;
}

export function ModelPicker(p: ModelPickerProps) {
  const { t: tx } = useI18n();
  const [rail, setRail] = useState<PickerTool>(p.currentTool);
  const [query, setQuery] = useState('');
  const own = p.tools.find((t) => t.tool === p.currentTool) ?? null;
  const running = own ? activeRow(own, p.model) : null;
  // A chat on an older version opens with its row on view.
  const [legacyOpen, setLegacyOpen] = useState(() => !!running && !!own?.legacy.includes(running));
  const [panel, setPanel] = useState<'' | 'effort' | 'account'>('');
  const tool = p.tools.find((t) => t.tool === rail) ?? null;
  // The running row is on view when the list opens, however far down Legacy it sits.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => { listRef.current?.querySelector('.mp-row.is-active')?.scrollIntoView({ block: 'nearest' }); }, []);
  // Settings mode: a tool this job cannot run on says why; the job may carry its own effort levels.
  const toolLockedWhy = (t: PickerTool): string | undefined => p.target?.lockedTools?.[t];
  const ownEfforts = p.target?.efforts ?? (own ? effortsFor(own, p.model) : []);

  const rows = useMemo<PickerModel[]>(() => {
    if (query.trim()) return searchModels(p.tools, query);
    if (!tool) return [];
    return legacyOpen ? [...tool.current, ...tool.legacy] : tool.current;
  }, [query, tool, legacyOpen, p.tools]);

  const locked = (m: PickerModel): boolean => !!p.lock && m.tool !== p.currentTool;
  const usable = (m: PickerModel): boolean => !locked(m) && !toolLockedWhy(m.tool) && (p.tools.find((t) => t.tool === m.tool)?.ready ?? false);
  const pick = (m: PickerModel): void => {
    if (!usable(m)) return;
    if (m.tool === p.currentTool) p.onModelChange(m.id);
    else p.onCrossTool(m);
    p.close();
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (!(e.metaKey || e.ctrlKey) || !/^[1-9]$/.test(e.key)) return;
    const m = rows[Number(e.key) - 1];
    if (m) { e.preventDefault(); pick(m); }
  };

  const active = p.accounts.find((a) => a.id === p.activeAccountId) ?? null;
  const pct = (n: number | null): string => (n == null ? '—' : `${n}%`);
  const searching = !!query.trim();
  // "New chats: Opus · High": the value is what the eye looks for (r29).
  const at = p.newChatsLine?.indexOf(': ') ?? -1;
  const newChats = at > 0 ? [p.newChatsLine!.slice(0, at), p.newChatsLine!.slice(at + 2)] as const : null;
  // The tool the lock's line is about: the rail's, or in a search the first locked row's.
  const lockedTool = !p.lock ? null : searching
    ? p.tools.find((t) => rows.some((m) => m.tool === t.tool && locked(m))) ?? null
    : tool && tool.tool !== p.currentTool ? tool : null;
  const showLegacyRow = !searching && !!tool && tool.legacy.length > 0;

  const row = (m: PickerModel, i: number) => {
    const isActive = m === running;
    const short = shortcutFor(i);
    return (
      <div key={`${m.tool}:${m.id}`} className={`mp-row${isActive ? ' is-active' : ''}${usable(m) ? '' : ' is-off'}`}>
        <button
          type="button"
          role="menuitemradio"
          aria-checked={isActive}
          className="mp-row-pick"
          disabled={!usable(m)}
          onClick={() => pick(m)}
        >
          {searching && <span className="mp-row-icon"><ToolMark tool={m.tool} /></span>}
          <span className="mp-row-name">{m.label}</span>
        </button>
        {short && <kbd className="mp-kbd" title={tx('chat.modelPicker.shortcut').replace('{key}', short)}>{short}</kbd>}
        {isActive && <span className="mp-check" aria-hidden>✓</span>}
      </div>
    );
  };

  return (
    <div className="chat-cmp-modelmenu mp" role="menu" aria-label="Model and reasoning effort" onKeyDown={onKey} data-testid="model-picker">
      <div className="mp-body">
        <nav className="mp-rail" aria-label="Tools">
          {p.tools.map((t) => (
            <button
              key={t.tool}
              type="button"
              className={`mp-tool${rail === t.tool ? ' is-on' : ''}${t.tool === p.currentTool ? ' is-current' : ''}`}
              aria-label={toolLockedWhy(t.tool) ? `${t.label} (${toolLockedWhy(t.tool)})` : t.ready ? t.label : `${t.label} (${blockerLine(t)})`}
              aria-disabled={toolLockedWhy(t.tool) ? true : undefined}
              title={toolLockedWhy(t.tool) ?? (t.ready ? t.label : blockerLine(t))}
              aria-pressed={rail === t.tool}
              data-tool={t.tool}
              onClick={() => { setRail(t.tool); setQuery(''); setLegacyOpen(false); setPanel(''); }}
            >
              <ToolMark tool={t.tool} />
              <span className="mp-tool-name">{t.label}</span>
              {!t.ready && !toolLockedWhy(t.tool) && <span className="mp-tool-state">{tx(blockerWord(t))}</span>}
            </button>
          ))}
        </nav>
        <div className="mp-main">
          <label className="mp-search">
            <svg className="mp-search-icon" viewBox="0 0 16 16" aria-hidden><circle cx="7" cy="7" r="4.5" /><line x1="10.4" y1="10.4" x2="14" y2="14" /></svg>
            <input
              type="text"
              placeholder="Search models..."
              value={query}
              aria-label="Search models"
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
          </label>
          <div className="mp-list" ref={listRef}>
            {!searching && tool && toolLockedWhy(tool.tool) && (
              <p className="mp-note mp-note--warn" data-testid="model-picker-locked">{toolLockedWhy(tool.tool)}</p>
            )}
            {!searching && tool && !tool.ready && !toolLockedWhy(tool.tool) && (
              <p className="mp-note mp-note--warn" data-testid="model-picker-signin">
                {blockerLine(tool)}
                {tool.tool === 'codex' && blockerFix(tool.blocker) && <CodexFix fix={blockerFix(tool.blocker)!} />}
                {tool.tool !== 'codex' && tool.blocker === 'signed-out' && (
                  <> · <button type="button" className="mp-link" onClick={() => { p.onOpenSettings('accounts'); p.close(); }}>Sign in</button></>
                )}
              </p>
            )}
            {!p.target && !searching && tool && tool.ready && tool.tool !== p.currentTool && !p.lock && (
              <p className="mp-note">Opens a new {tool.label} chat with a summary of this one</p>
            )}
            {lockedTool && (
              <p className="mp-note" data-testid="model-picker-lock">
                {p.lock!.note}
                {lockedTool.ready && p.lock!.onOpen && (
                  <> <button type="button" className="mp-link" onClick={() => { p.lock!.onOpen!(lockedTool.tool); p.close(); }}>{p.lock!.openLabel.replace('{tool}', lockedTool.label)}</button></>
                )}
              </p>
            )}
            {searching && rows.length === 0 && <p className="mp-note">No model matches “{query.trim()}”.</p>}
            {rows.filter((m) => searching || !(tool && tool.legacy.includes(m))).map((m) => row(m, rows.indexOf(m)))}
            {showLegacyRow && (
              <button type="button" className="mp-legacy" aria-expanded={legacyOpen} onClick={() => setLegacyOpen((v) => !v)}>
                <span className="mp-legacy-text">
                  <span>Legacy models</span>
                  <span className="mp-legacy-count">{tool!.legacy.length} {tool!.legacy.length === 1 ? 'model' : 'models'}</span>
                </span>
                <span className="mp-chevron" aria-hidden>{legacyOpen ? '⌄' : '›'}</span>
              </button>
            )}
            {showLegacyRow && legacyOpen && tool!.legacy.map((m) => row(m, rows.indexOf(m)))}
          </div>

          {panel === 'effort' && ownEfforts.length > 0 && (
            <div className="mp-efforts" role="radiogroup" aria-label="Reasoning effort">
              {ownEfforts.map((lvl) => (
                <button key={lvl} type="button" role="radio" aria-checked={lvl === p.effort} className={`mp-effort${lvl === p.effort ? ' is-on' : ''}`} onClick={() => p.onEffortChange(lvl)}>
                  {effortLabel(lvl)}
                </button>
              ))}
            </div>
          )}
          {panel === 'account' && (
            <div className="mp-accounts" data-testid="model-picker-accounts">
              {p.accounts.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className={`mp-acct${a.id === p.activeAccountId ? ' is-on' : ''}`}
                  disabled={!p.onAccountChange || a.id === p.activeAccountId}
                  onClick={() => { p.onAccountChange?.(a.id); p.close(); }}
                >
                  <span className="mp-acct-email">{a.email}</span>
                  <span className={`mp-acct-pct${(a.sessionPercent ?? 0) >= 80 ? ' is-warn' : ''}`}>{a.state === 'needs-relogin' ? 'Sign in' : pct(a.sessionPercent)}</span>
                  {a.id === p.activeAccountId && <span className="mp-check" aria-hidden>✓</span>}
                </button>
              ))}
              <div className="mp-acct-foot">
                {p.autoSwitch && (
                  <label className="mp-switch">
                    <input type="checkbox" checked={p.autoSwitch.enabled} onChange={p.autoSwitch.onToggle} />
                    <span>Auto-switch near a limit</span>
                  </label>
                )}
                <button type="button" className="mp-link mp-link--quiet" onClick={() => { p.onOpenSettings(p.currentTool === 'codex' ? 'accounts-codex' : 'accounts'); p.close(); }}>Add ›</button>
              </div>
            </div>
          )}

          <div className="mp-chips">
            {ownEfforts.length > 0 ? (
              <button type="button" className={`mp-chip${panel === 'effort' ? ' is-on' : ''}`} aria-expanded={panel === 'effort'} onClick={() => setPanel((x) => (x === 'effort' ? '' : 'effort'))}>
                <span className="mp-chip-label">Effort</span> {effortLabel(p.effort)}
              </button>
            ) : <span />}
            {active && !p.target && (
              <button type="button" className={`mp-chip${panel === 'account' ? ' is-on' : ''}`} aria-expanded={panel === 'account'} onClick={() => setPanel((x) => (x === 'account' ? '' : 'account'))} data-testid="model-picker-account-chip">
                <span className={`mp-dot${active.state === 'ok' ? '' : ' is-warn'}`} title={tx(active.state === 'ok' ? 'chat.modelPicker.signedIn' : 'chat.modelPicker.needsSignIn')} />
                <span className="mp-chip-email">{active.email}</span>
                <span className="mp-chip-pct" title={tx('chat.modelPicker.sessionUsed')}>{pct(active.sessionPercent)}</span>
              </button>
            )}
          </div>
        </div>
      </div>
      {!p.target && (
        <div className="mp-foot">
          <span className="mp-foot-line">
            {newChats && <span>{newChats[0]}: <strong>{newChats[1]}</strong></span>}
            {p.onSetDefault && (
              <button type="button" className="mp-link mp-link--quiet" onClick={p.onSetDefault}>{p.savedDefault ? 'Saved as default' : 'Set as default'}</button>
            )}
          </span>
          <button type="button" className="mp-link mp-link--quiet" onClick={() => { p.onOpenSettings('models'); p.close(); }}>Models ›</button>
        </div>
      )}
    </div>
  );
}
