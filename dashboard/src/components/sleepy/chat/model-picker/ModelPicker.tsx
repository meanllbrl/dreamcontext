/**
 * The composer's model picker, as the owner approved it in prototype r29 (Track T W4): a rail of
 * tools (favourites first), a search across every tool, one-line models with ⌘1-9, a Legacy
 * group, and an effort chip and an account chip under the list. A tool that cannot run says so
 * and offers "Sign in". Picking a model of ANOTHER tool opens a new chat there with a summary of
 * this one, after one confirm (the parent's `onCrossTool`).
 *
 * It replaces `ModelMenu` for an ordinary chat; the AI Team's temporary picker and the Super
 * Agent keep `ModelMenu` (they pass a head/foot of their own).
 */
import { useMemo, useState, type KeyboardEvent } from 'react';
import { effortLabel } from '../../../../lib/agentComposer';
import type { AccountOption } from '../ComposerMenus';
import {
  favouriteKey, favouriteModels, searchModels, shortcutFor, toggleFavourite,
  type PickerModel, type PickerTool, type PickerToolState,
  blockerFix,
} from './pickerModel';
import { CodexFix } from './CodexFix';
import './model-picker.css';

export type SettingsTarget = 'models' | 'accounts' | 'accounts-codex';

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
  /** This chat's tool's accounts; fewer than one draws no account chip. */
  accounts: AccountOption[];
  activeAccountId: string;
  onAccountChange?: (id: string) => void;
  autoSwitch?: { enabled: boolean; onToggle: () => void };
  favourites: string[];
  onFavouritesChange: (keys: string[]) => void;
  /** "New chats: Opus · High": what a new chat starts with. */
  newChatsLine?: string;
  onSetDefault?: () => void;
  savedDefault?: boolean;
  onOpenSettings: (target: SettingsTarget) => void;
  close: () => void;
}

/** Each tool's mark in the rail, drawn here: the app ships no vendor artwork of its own. */
function ToolMark({ tool }: { tool: PickerTool }) {
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

function blockerLine(t: PickerToolState): string {
  if (t.blocker === 'not-installed') return `${t.label} is not installed`;
  if (t.blocker === 'wont-start') return `${t.label} is installed but does not start`;
  if (t.blocker === 'outdated') return `${t.label} needs an update`;
  if (t.blocker === 'needs-node') return `${t.label} needs Node 22.16 or newer`;
  return `${t.label} is not signed in`;
}

export function ModelPicker(p: ModelPickerProps) {
  const [rail, setRail] = useState<PickerTool | 'fav'>(p.currentTool);
  const [query, setQuery] = useState('');
  const [legacyOpen, setLegacyOpen] = useState(false);
  const [panel, setPanel] = useState<'' | 'effort' | 'account'>('');
  const tool = rail === 'fav' ? null : p.tools.find((t) => t.tool === rail) ?? null;
  const own = p.tools.find((t) => t.tool === p.currentTool) ?? null;

  const rows = useMemo<PickerModel[]>(() => {
    if (query.trim()) return searchModels(p.tools, query);
    if (rail === 'fav') return favouriteModels(p.tools, p.favourites);
    if (!tool) return [];
    return legacyOpen ? [...tool.current, ...tool.legacy] : tool.current;
  }, [query, rail, tool, legacyOpen, p.tools, p.favourites]);

  const usable = (m: PickerModel): boolean => p.tools.find((t) => t.tool === m.tool)?.ready ?? false;
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
  const showLegacyRow = !searching && rail !== 'fav' && !!tool && tool.legacy.length > 0;

  const row = (m: PickerModel, i: number) => {
    const isActive = m.tool === p.currentTool && m.id === p.model;
    const starred = p.favourites.includes(favouriteKey(m));
    const short = shortcutFor(i);
    return (
      <div key={favouriteKey(m)} className={`mp-row${isActive ? ' is-active' : ''}${usable(m) ? '' : ' is-off'}`}>
        <button
          type="button"
          role="menuitemradio"
          aria-checked={isActive}
          className="mp-row-pick"
          disabled={!usable(m)}
          onClick={() => pick(m)}
        >
          {(searching || rail === 'fav') && <span className="mp-row-icon"><ToolMark tool={m.tool} /></span>}
          <span className="mp-row-name">{m.label}</span>
        </button>
        <button
          type="button"
          className={`mp-star${starred ? ' is-on' : ''}`}
          aria-label={starred ? `Remove ${m.label} from favourites` : `Add ${m.label} to favourites`}
          aria-pressed={starred}
          onClick={() => p.onFavouritesChange(toggleFavourite(p.favourites, m))}
        >{starred ? '★' : '☆'}</button>
        {short && <kbd className="mp-kbd">{short}</kbd>}
        {isActive && <span className="mp-check" aria-hidden>✓</span>}
      </div>
    );
  };

  return (
    <div className="chat-cmp-modelmenu mp" role="menu" aria-label="Model and reasoning effort" onKeyDown={onKey} data-testid="model-picker">
      <div className="mp-body">
        <nav className="mp-rail" aria-label="Tools">
          <button type="button" className={`mp-tool${rail === 'fav' ? ' is-on' : ''}`} aria-label="Favourites" aria-pressed={rail === 'fav'} onClick={() => { setRail('fav'); setQuery(''); }}>★</button>
          <span className="mp-rail-div" aria-hidden />
          {p.tools.map((t) => (
            <button
              key={t.tool}
              type="button"
              className={`mp-tool${rail === t.tool ? ' is-on' : ''}${t.tool === p.currentTool ? ' is-current' : ''}`}
              aria-label={t.ready ? t.label : `${t.label} (${blockerLine(t)})`}
              aria-pressed={rail === t.tool}
              data-tool={t.tool}
              onClick={() => { setRail(t.tool); setQuery(''); setLegacyOpen(false); setPanel(''); }}
            >
              <ToolMark tool={t.tool} />
              {!t.ready && <span className="mp-tool-dot" aria-hidden />}
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
          <div className="mp-list">
            {!searching && tool && !tool.ready && (
              <p className="mp-note mp-note--warn" data-testid="model-picker-signin">
                {blockerLine(tool)}
                {tool.tool === 'codex' && blockerFix(tool.blocker) && <CodexFix fix={blockerFix(tool.blocker)!} />}
                {tool.tool !== 'codex' && tool.blocker === 'signed-out' && (
                  <> · <button type="button" className="mp-link" onClick={() => { p.onOpenSettings('accounts'); p.close(); }}>Sign in</button></>
                )}
              </p>
            )}
            {!searching && tool && tool.ready && tool.tool !== p.currentTool && (
              <p className="mp-note">Opens a new {tool.label} chat with a summary of this one</p>
            )}
            {!searching && rail === 'fav' && rows.length === 0 && (
              <p className="mp-note">No favourites yet. Star a model to keep it here.</p>
            )}
            {searching && rows.length === 0 && <p className="mp-note">No model matches “{query.trim()}”.</p>}
            {rows.filter((m) => !(tool && tool.legacy.includes(m))).map((m) => row(m, rows.indexOf(m)))}
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

          {panel === 'effort' && own && own.efforts.length > 0 && (
            <div className="mp-efforts" role="radiogroup" aria-label="Reasoning effort">
              {own.efforts.map((lvl) => (
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
            {own && own.efforts.length > 0 ? (
              <button type="button" className={`mp-chip${panel === 'effort' ? ' is-on' : ''}`} aria-expanded={panel === 'effort'} onClick={() => setPanel((x) => (x === 'effort' ? '' : 'effort'))}>
                <span className="mp-chip-label">Effort</span> {effortLabel(p.effort)}
              </button>
            ) : <span />}
            {active && (
              <button type="button" className={`mp-chip${panel === 'account' ? ' is-on' : ''}`} aria-expanded={panel === 'account'} onClick={() => setPanel((x) => (x === 'account' ? '' : 'account'))} data-testid="model-picker-account-chip">
                <span className={`mp-dot${active.state === 'ok' ? '' : ' is-warn'}`} aria-hidden />
                <span className="mp-chip-email">{active.email}</span>
                <span className="mp-chip-pct">{pct(active.sessionPercent)}</span>
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="mp-foot">
        <span className="mp-foot-line">
          {newChats && <span>{newChats[0]}: <strong>{newChats[1]}</strong></span>}
          {p.onSetDefault && (
            <button type="button" className="mp-link mp-link--quiet" onClick={p.onSetDefault}>{p.savedDefault ? 'Saved as default' : 'Set as default'}</button>
          )}
        </span>
        <button type="button" className="mp-link mp-link--quiet" onClick={() => { p.onOpenSettings('models'); p.close(); }}>Models ›</button>
      </div>
    </div>
  );
}
