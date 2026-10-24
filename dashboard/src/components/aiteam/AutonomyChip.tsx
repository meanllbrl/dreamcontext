import { useI18n } from '../../context/I18nContext';
import type { AgentAutonomy } from '../../hooks/useAgents';

/** The level's word ("Balanced"), from the i18n table. */
export function autonomyWord(level: AgentAutonomy, t: (k: string) => string): string {
  return t(`aiteam.autonomy.${level}`);
}

/**
 * The stage header's autonomy chip: how much this agent decides alone. A click opens its Edit
 * dialog, where the level is set (the server decides the permission mode from it).
 */
export function AutonomyChip({ level, onEdit }: { level: AgentAutonomy; onEdit?: () => void }) {
  const { t } = useI18n();
  const label = t('aiteam.autonomy.label').replace('{level}', autonomyWord(level, t));
  return onEdit ? (
    <button type="button" className={`aiteam-autonomy aiteam-autonomy--${level}`} onClick={onEdit} title={t(`aiteam.autonomy.${level}.desc`)}>
      {label}
    </button>
  ) : (
    <span className={`aiteam-autonomy aiteam-autonomy--${level}`} title={t(`aiteam.autonomy.${level}.desc`)}>{label}</span>
  );
}
