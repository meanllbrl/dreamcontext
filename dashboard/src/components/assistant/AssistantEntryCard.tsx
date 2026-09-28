import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useI18n } from '../../context/I18nContext';
import { MaturityTag } from '../common/MaturityTag';
import { Toggle } from '../settings/SettingRow';
import { AssistantApiError, getAssistantStatus, saveProfile, setAssistantEnabled } from '../../lib/assistantProfile';
import { fillCopy } from './assistantWizardLogic';
import { AssistantWizard } from './AssistantWizard';
import './AssistantWizard.css';

const STATUS_KEY = ['assistant-status'] as const;

/**
 * The Launcher's entry to the dreamcontext Assistant, in BOTH views.
 *
 * It sits apart from the project list on purpose: the assistant is not a project (its vault
 * is hidden and never registered), so it must never read as one more card among them. Not
 * created → "Create dreamcontext Assistant"; created → its face, its name and "Assistant
 * settings". Both open the same wizard. Once created it also carries the off switch: off
 * hides the notch, releases the hotkey and drops the Login Item, and keeps everything else.
 *
 * `space` floats over the sky (so it carries `surface-night`, like the sky itself); `list`
 * is a plain band above the project grid.
 */
export function AssistantEntryCard({ variant }: { variant: 'space' | 'list' }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [switchFailure, setSwitchFailure] = useState<string | null>(null);
  const status = useQuery({
    queryKey: STATUS_KEY,
    queryFn: getAssistantStatus,
    retry: false,
    staleTime: 30_000,
  });

  if (status.isLoading) return null;

  const localOnly = status.error instanceof AssistantApiError && status.error.code === 'assistant_local_only';
  const exists = !!status.data?.exists;
  const name = status.data?.config?.name ?? '';
  const avatar = status.data?.avatar ? `${status.data.avatar}?v=${status.dataUpdatedAt}` : null;
  const enabled = status.data?.config?.enabled !== false;
  const refresh = () => { void queryClient.invalidateQueries({ queryKey: STATUS_KEY }); };

  // Config first, then the shell: the shell re-reads config.json to decide what to register.
  async function toggleEnabled(on: boolean) {
    setSwitchFailure(null);
    setSwitching(true);
    try {
      await saveProfile({ enabled: on });
      const r = await setAssistantEnabled(on);
      if (!r.ok && !r.desktopOnly) setSwitchFailure(r.error ?? '');
    } catch (err) {
      setSwitchFailure(err instanceof Error ? err.message : String(err));
    } finally {
      setSwitching(false);
      refresh();
    }
  }

  let hint: string;
  if (localOnly) hint = t('assistant.card.desktopOnly');
  else if (status.error) hint = fillCopy(t('assistant.card.loadFailed'), { error: status.error instanceof Error ? status.error.message : String(status.error) });
  else if (switchFailure !== null) hint = fillCopy(t('assistant.card.switchFailed'), { error: switchFailure });
  else if (exists && !enabled) hint = t('assistant.card.offHint');
  else hint = exists ? t('assistant.card.createdHint') : t('assistant.card.createHint');

  return (
    <>
      <section
        className={`aw-entry aw-entry--${variant}${variant === 'space' ? ' surface-night' : ''}`}
        aria-label={t('assistant.card.name')}
        data-no-drag
        onPointerDown={(e) => e.stopPropagation()}
      >
        <span className="aw-avatar" aria-hidden="true">
          {exists && avatar ? <img src={avatar} alt="" /> : <span className="aw-avatar-initial">{exists ? name.slice(0, 1).toUpperCase() : '+'}</span>}
        </span>
        <span className="aw-entry-text">
          <span className="aw-entry-title">
            <span className="aw-entry-name">{exists ? name : t('assistant.card.name')}</span>
            <MaturityTag level="alpha" />
          </span>
          <span className="aw-entry-hint">{hint}</span>
        </span>
        {exists && !localOnly && !status.error && (
          <Toggle label={t('assistant.card.onOff')} checked={enabled} disabled={switching} onChange={(on) => void toggleEnabled(on)} />
        )}
        <button
          type="button"
          className="aw-btn aw-btn--small"
          disabled={localOnly || !!status.error}
          onClick={() => setOpen(true)}
        >
          {exists ? t('assistant.card.settings') : t('assistant.card.create')}
        </button>
      </section>
      {open && (
        <AssistantWizard
          exists={exists}
          onClose={() => { setOpen(false); refresh(); }}
          onChanged={refresh}
        />
      )}
    </>
  );
}
