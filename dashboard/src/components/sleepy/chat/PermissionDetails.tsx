import { useId, useState, type ReactNode } from 'react';
import { DiffStat } from './atoms';
import { TerminalBlock, DiffView } from './molecules';
import { useI18n } from '../../../context/I18nContext';
import type { parseEditDiff } from './chatEntities';

/**
 * What a permission would run, folded by default (owner 2026-11-05: "this card is a code dump").
 * The card's lead says what happens in words; the command, the diff or the raw input opens
 * from one small "Show command" toggle. Shared by the chat's PermissionCard and the hands-free
 * phone's card, so both read the same. `extra` rides at the foot of the open panel (the chat's
 * "Run here", which belongs next to the command it would run).
 */
export function PermissionDetails({ command, diff, input, extra }: {
  command: string | null;
  diff?: ReturnType<typeof parseEditDiff> | null;
  /** The raw input, drawn only when it is neither a command nor an edit. */
  input?: unknown;
  extra?: ReactNode;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const raw = !command && !diff && input !== undefined ? rawText(input) : '';
  if (!command && !diff && !raw) return null;
  const label = command ? (open ? t('perm.hideCommand') : t('perm.showCommand'))
    : diff ? (open ? t('perm.hideChanges') : t('perm.showChanges'))
      : (open ? t('perm.hideDetails') : t('perm.showDetails'));
  return (
    <div className="chat-permcard-details" data-open={open ? '' : undefined}>
      <button
        type="button"
        className="chat-permcard-toggle"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((o) => !o)}
        data-testid="permission-toggle"
      >
        <span className="chat-permcard-chevron" aria-hidden>›</span>
        {label}
        {diff && <span className="chat-permcard-toggle-stat"><DiffStat added={diff.addedN} removed={diff.removedN} /></span>}
      </button>
      {open && (
        <div id={panelId} className="chat-permcard-panel" data-testid="permission-panel">
          {command && <TerminalBlock command={command} />}
          {diff && <div className="chat-permcard-diff"><DiffView diff={diff} /></div>}
          {raw && <pre className="chat-permcard-raw">{raw}</pre>}
          {extra && <div className="chat-permcard-panel-foot">{extra}</div>}
        </div>
      )}
    </div>
  );
}

function rawText(input: unknown): string {
  if (typeof input === 'string') return input;
  try { return JSON.stringify(input, null, 2) ?? ''; } catch { return String(input); }
}
