import { useCallback, useMemo, useState } from 'react';
import { useAutomations } from '../../hooks/useAutomations';
import type { AutomationSummary } from '../../hooks/useAutomations';
import { usePersistedState } from '../../hooks/usePersistedState';
import { AutomationDetailPanel } from '../automations/AutomationDetailPanel';
import { AgentDialog } from './AgentDialog';
import { AgentMemberCard } from './AgentMemberCard';
import { AgentProfilePopover } from './AgentProfilePopover';
import './AgentsMembers.css';

/** Apply the board's persisted manual order — listed slugs first in saved
 *  order, anything new after, in API order. Reuses the SAME storage key the
 *  old grid used, so an owner who had arranged their automations keeps that
 *  arrangement across this change. */
function applyOrder<T extends { slug: string }>(items: T[], order: string[]): T[] {
  if (order.length === 0) return items;
  const pos = new Map(order.map((slug, i) => [slug, i]));
  return items
    .map((item, apiIdx) => ({ item, key: pos.get(item.slug) ?? order.length + apiIdx }))
    .sort((a, b) => a.key - b.key)
    .map((e) => e.item);
}

/** Which agent's profile popover is open, and where it is anchored. */
interface ProfileAnchor {
  slug: string;
  rect: DOMRect;
}

/** Which dialog this view owns. CREATE is NOT here: the page owns it, and the
 *  header's New agent button is the one way in (a second, dashed "New agent"
 *  tile in the grid was the same action twice on one screen). */
type DialogState = { kind: 'closed' } | { kind: 'edit'; slug: string };

/**
 * The Agents tab — the member list.
 *
 * One card per agent, and nothing else in the grid: New agent is the header's
 * button, once per screen (C13). What this deliberately is
 * NOT: a replacement for `AutomationDetailPanel`. Run history, the approval
 * review, pending questions and "Open chat" all still live there and every
 * card carries a button to it — a member list that swallowed those would be a
 * prettier surface with less in it.
 *
 * The dispatcher bar stays above the grid: "who these agents are" and "would
 * any of them fire at all" are two different questions, and an owner looking
 * at a healthy-looking roster with the scheduler off must be able to see that.
 */
export function AgentsMembers({
  onToast,
}: {
  onToast: (msg: string) => void;
}) {
  const { data: automations, isLoading, isError, error } = useAutomations();
  const [order] = usePersistedState<string[]>('automations:order:v1', []);
  const [dialog, setDialog] = useState<DialogState>({ kind: 'closed' });
  const [profile, setProfile] = useState<ProfileAnchor | null>(null);
  const [detailSlug, setDetailSlug] = useState<string | null>(null);

  const ordered = useMemo(() => applyOrder(automations ?? [], order), [automations, order]);

  /** Always re-derived from the live list, never captured in state: an agent
   *  edited, paused or deleted while a popover or panel is open must not leave
   *  that surface rendering a stale snapshot of it. */
  const bySlug = useCallback(
    (slug: string | null): AutomationSummary | null => (slug ? ordered.find((a) => a.slug === slug) ?? null : null),
    [ordered],
  );

  const openProfile = useCallback((slug: string, rect: DOMRect) => setProfile({ slug, rect }), []);
  const openEdit = useCallback((slug: string) => { setProfile(null); setDialog({ kind: 'edit', slug }); }, []);

  const editing = dialog.kind === 'edit' ? bySlug(dialog.slug) : null;
  const profileAgent = bySlug(profile?.slug ?? null);
  const detailAgent = bySlug(detailSlug);

  if (isLoading) return <div className="agents-members-note">Loading agents…</div>;
  if (isError) {
    // A fetch failure is an outage, not onboarding — never show the "no agents
    // yet" explainer over an error.
    return <div className="agents-members-note agents-members-note--error">Failed to load agents. {(error as Error)?.message}</div>;
  }

  return (
    <div className="agents-members">
      <div className="agents-members-grid">
        {ordered.map((summary) => (
          <AgentMemberCard
            key={summary.slug}
            summary={summary}
            onOpenProfile={openProfile}
            onEdit={openEdit}
            onOpenDetail={setDetailSlug}
            onToast={onToast}
          />
        ))}
      </div>

      {profile && profileAgent && (
        <AgentProfilePopover
          summary={profileAgent}
          anchor={profile.rect}
          onClose={() => setProfile(null)}
          onEdit={openEdit}
          onToast={onToast}
        />
      )}

      {editing && (
        <AgentDialog
          /* Keyed by slug so the form state can never carry over from one
             agent to another. */
          key={editing.slug}
          agent={editing}
          onClose={() => setDialog({ kind: 'closed' })}
          onToast={onToast}
        />
      )}

      {detailAgent && (
        <AutomationDetailPanel
          key={detailAgent.slug}
          summary={detailAgent}
          onClose={() => setDetailSlug(null)}
          onToast={onToast}
          /* Edit, straight from the details screen — the owner asked for it,
             and the alternative was closing this to hunt for the card again.
             Closes the panel first so the dialog is not opened behind it. */
          onEdit={(slug) => { setDetailSlug(null); openEdit(slug); }}
        />
      )}
    </div>
  );
}
