import { useI18n } from '../../context/I18nContext';
import { badge, type Frame, type RunTeam } from './data';
import { ScreenBody, WindowFrame, roleLabel } from './WindowFrame';

/**
 * One table on the Canlı screen (approved mockup `hackathon-canli.png`): the team's name, tool and
 * model, its screen in a window frame, and its members with their state. Clicking opens the room.
 */
export function TeamTable({ run, team, frame, control, onOpen }: {
  run: string;
  team: RunTeam;
  frame: Frame | undefined;
  control: boolean;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  const screen = frame?.screen ?? null;
  const live = !!frame && !frame.ended && frame.members.some((m) => m.state !== 'idle');
  const who = screen ? roleLabel(t, screen.role) : null;
  return (
    <button type="button" className="hk-table" onClick={onOpen} aria-label={`${team.name}: ${t('hk.table.open')}`}>
      <span className="hk-table__head">
        <span className="hk-badge" data-tool={team.tool}>{badge(team.name)}</span>
        <span className="hk-table__name">{team.name}</span>
        <span className="hk-muted">{team.tool === 'codex' ? 'Codex' : 'Claude'} · {team.model || t('hk.defaultModel')}{team.inner === 'solo' ? ` · ${t('hk.inner.solo')}` : ''}</span>
        {control && <span className="hk-chip">{t('hk.control')}</span>}
      </span>
      <WindowFrame
        title={<>{who && <span className="hk-win__who">{who}</span>}<span className="hk-mono">{screen?.path ?? screen?.command ?? ''}</span></>}
        live={live}
      >
        <ScreenBody run={run} team={team.id} screen={screen} />
      </WindowFrame>
      <span className="hk-table__foot">
        {(frame?.members ?? []).map((m) => (
          <span key={m.role} className="hk-member" data-state={m.state}>
            <span className="hk-member__dot" aria-hidden="true" />
            {roleLabel(t, m.role)}
          </span>
        ))}
        <span className="hk-table__edits hk-muted">
          {frame?.ended ? t('hk.table.ended') : frame ? `${frame.edited.length} ${t('hk.table.files')}` : t('hk.table.waiting')}
        </span>
      </span>
    </button>
  );
}
