import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '../context/I18nContext';
import { useAgents } from '../hooks/useAgents';
import { AgentRosterCard, AgentTeamSeat } from '../components/agents/AgentRosterCard';
import { AgentProfilePanel } from '../components/agents/AgentProfilePanel';
import { AgentIdentityDialog } from '../components/agents/AgentIdentityDialog';
import type { AgentsFocus } from '../lib/openAgents';
import './AgentsPage.css';
import { fill } from '../lib/fill';

/** What a focus asks the page to do: open one agent's profile, open the create dialog (with a
 *  home board preset when a board asked), or both. */
export function focusIntent(
  focus: AgentsFocus | null,
): { select: string | null; create: boolean; whiteboard: string | null } | null {
  if (!focus) return null;
  const create = focus.create === true;
  return { select: focus.slug ?? null, create, whiteboard: create ? focus.whiteboard ?? null : null };
}

/** The roster's count line key: none, one, many. */
export function rosterCountKey(n: number): 'agents.page.empty' | 'agents.roster.count.one' | 'agents.roster.count.many' {
  if (n === 0) return 'agents.page.empty';
  return n === 1 ? 'agents.roster.count.one' : 'agents.roster.count.many';
}

/** How long a toast stays up. */
const TOAST_MS = 4200;

/** `whiteboard` presets a new agent's home board (create only). */
type DialogState = { slug: string | null; whiteboard?: string } | null;

/**
 * The Agents page: the team (every agent in this project as a portrait card, then an "Add to
 * team" seat), one agent's profile docked beside it, and the identity dialog for creating and
 * editing. An agent is WHO does the work; automations,
 * Chat, boards and tasks all pick from this one roster.
 *
 * `focus` is what a caller asked for (`requestOpenAgents`, the `page/agents/<slug>` link, the
 * command palette): one agent's profile, or the create flow. The page takes it once and calls
 * `onFocusDone`, so a later visit opens on the plain roster.
 *
 * Approval happens HERE (the profile's in-place review), because a Claude session can no longer
 * approve anything. No Run now and no Telegram on this page.
 */
export function AgentsPage({ focus, onFocusDone }: { focus: AgentsFocus | null; onFocusDone: () => void }) {
  const { t } = useI18n();
  const { data: agents, isLoading, error } = useAgents();
  const [selected, setSelected] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    const intent = focusIntent(focus);
    if (!intent) return;
    if (intent.select) setSelected(intent.select);
    if (intent.create) setDialog(intent.whiteboard ? { slug: null, whiteboard: intent.whiteboard } : { slug: null });
    onFocusDone();
  }, [focus, onFocusDone]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  const closeDialog = useCallback(() => setDialog(null), []);
  const onSaved = useCallback((slug: string, message: string) => {
    setDialog(null);
    setSelected(slug);
    setToast(message);
  }, []);

  const count = agents?.length ?? 0;

  return (
    <div className="arp">
      <section className="arp-roster" aria-label={t('agents.roster.aria')}>
        <div className="arp-head">
          <div className="arp-head-text">
            <div className="arp-titleline">
              <h1 className="page-title arp-title">{t('agents.team.title')}</h1>
              {agents && count > 0 && (
                <span className="arp-count">{fill(t(rosterCountKey(count)), { n: String(count) })}</span>
              )}
            </div>
            <p className="arp-lead">{t('agents.page.lead')}</p>
          </div>
          {/* Neutral, never filled: the seat at the end of the team is the main way in, and the
              one filled button belongs to the open profile (Talk to it). */}
          <button type="button" className="arp-new" onClick={() => setDialog({ slug: null })}>
            {t('agents.page.new')}
          </button>
        </div>

        {isLoading && <p className="arp-note">{t('agents.page.loading')}</p>}
        {error && <p className="arp-note arp-note--error" role="alert">{t('agents.page.loadFailed')}</p>}
        {agents && count === 0 && <p className="arp-note">{t('agents.page.empty')}</p>}

        {agents && (
          <ul className="arp-grid">
            {agents.map((a) => (
              <li key={a.slug}>
                <AgentRosterCard agent={a} selected={selected === a.slug} onOpen={setSelected} />
              </li>
            ))}
            {/* The empty seat, always LAST, also when the team is empty. */}
            <li>
              <AgentTeamSeat onAdd={() => setDialog({ slug: null })} />
            </li>
          </ul>
        )}
      </section>

      {selected && (
        <AgentProfilePanel
          slug={selected}
          onClose={() => setSelected(null)}
          onEdit={(slug) => setDialog({ slug })}
          onDeleted={() => setSelected(null)}
          onToast={setToast}
        />
      )}

      {dialog && (
        <AgentIdentityDialog slug={dialog.slug} whiteboard={dialog.whiteboard} onClose={closeDialog} onSaved={onSaved} />
      )}

      {toast && <div className="arp-toast" role="status">{toast}</div>}
    </div>
  );
}
