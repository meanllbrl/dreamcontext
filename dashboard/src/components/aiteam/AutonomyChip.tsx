import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../../context/I18nContext';
import { findAgent, useAgents, type AgentAutonomy } from '../../hooks/useAgents';
import { AgentIdentityDialog } from '../agents/AgentIdentityDialog';
import './AutonomyChip.css';

/** The level's word ("Balanced"), from the i18n table. */
export function autonomyWord(level: AgentAutonomy, t: (k: string) => string): string {
  return t(`aiteam.autonomy.${level}`);
}

/**
 * The autonomy label: how much this agent decides alone, as a quiet word ("Autonomy: Balanced").
 * DISPLAY ONLY: it never feeds a permission decision (the server decides the mode from the level).
 * A click opens its Edit dialog, where the level is set. `variant` only places it: on the stage's
 * head or in a member chat's composer.
 */
export function AutonomyChip({ level, onEdit, variant = 'head' }: { level: AgentAutonomy; onEdit?: () => void; variant?: 'head' | 'composer' }) {
  const { t } = useI18n();
  const word = autonomyWord(level, t);
  const label = t('aiteam.autonomy.label').replace('{level}', word);
  const cls = `aiteam-autonomy aiteam-autonomy--${level} aiteam-autonomy--${variant}`;
  return onEdit ? (
    <button type="button" className={cls} data-testid="autonomy-label" data-level={level} onClick={onEdit} title={t(`aiteam.autonomy.${level}.desc`)} aria-label={label}>
      {label}
    </button>
  ) : (
    <span className={cls} data-testid="autonomy-label" data-level={level} title={t(`aiteam.autonomy.${level}.desc`)} aria-label={label}>{label}</span>
  );
}

/**
 * A member's label, read from the MEMBER (the roster's own `autonomy`, never a chat's permission
 * state), and the Edit dialog it opens at the autonomy field. Nothing is drawn until the roster has
 * the member: a label that guessed a level could lie. The dialog is drawn at the window's level: a
 * floating card clips its own overflow, and a press inside it must not reach what it sits in.
 */
export function MemberAutonomy({ slug, variant }: { slug: string; variant: 'head' | 'composer' }) {
  const { data: agents } = useAgents();
  const agent = findAgent(agents, slug);
  const [editing, setEditing] = useState(false);
  if (!agent) return null;
  return (
    <>
      {/* A teammate's read-only member has no edit (its Save would be refused): a plain word. */}
      <AutonomyChip level={agent.autonomy ?? 'balanced'} variant={variant} onEdit={agent.readOnly ? undefined : () => setEditing(true)} />
      {editing && createPortal(
        <div data-member-card-layer onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
          <AgentIdentityDialog slug={slug} focusField="autonomy" onClose={() => setEditing(false)} onSaved={() => setEditing(false)} />
        </div>,
        document.body,
      )}
    </>
  );
}
