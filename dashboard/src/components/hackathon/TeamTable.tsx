import { useI18n } from '../../context/I18nContext';
import { useVaultId } from '../../context/VaultContext';
import { clock, fill, mediaUrl, useFiles, type Frame, type RunTeam, type Screen } from './data';
import { Browser, TeamMark, people } from './parts';
import { ScreenBody, roleLabel } from './WindowFrame';

/**
 * One team on the live board (design B, `canli-1440`): its colour and letter, its members as a
 * verb ("Kaptan yazıyor…"), one line of what it is doing now, the team's screen and its last
 * decision as a quote. The whole card is one button that opens the team room.
 */
export function TeamTable({ run, teams, team, frame, control, onOpen }: {
  run: string;
  teams: readonly RunTeam[];
  team: RunTeam;
  frame: Frame | undefined;
  control: boolean;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  const { vault } = useVaultId();
  const { data: files } = useFiles(run, team.id, null);
  const screen = frame?.screen ?? null;
  const live = !!frame && !frame.ended && frame.members.some((m) => m.state !== 'idle');
  const last = [...(files?.decisions ?? [])].reverse().find((d) => d.kind === 'decision' || d.kind === 'plan');
  const edited = frame?.edited.length ?? 0;
  return (
    <button type="button" className="hk-desk" onClick={onOpen} aria-label={fill(t('hk.live.open'), { team: team.name })}>
      <span className="hk-desk__head">
        <TeamMark teams={teams} team={team} />
        <span className="hk-desk__name">{team.name}</span>
        <span className="hk-quiet">{people(t, team.inner)}</span>
        {control && <span className="hk-chip">{t('hk.control')}</span>}
      </span>
      <span className="hk-members">
        {(frame?.members ?? []).map((m) => {
          const doing = live && screen?.role === m.role && m.state === 'working';
          return (
            <span key={m.role} className="hk-member" data-role={m.role} data-on={doing ? 'true' : undefined}>
              <span className="hk-member__dot" aria-hidden="true" />
              {roleLabel(t, m.role)} {doing && screen ? t(`hk.verb.${screen.kind}`) : frame?.ended ? t('hk.memberState.ended') : t(`hk.memberState.${m.state}`)}
            </span>
          );
        })}
      </span>
      <span className="hk-desk__now">
        <b>{t('hk.live.now')}</b> {nowLine(t, frame, screen, edited)}
      </span>
      <Browser className="hk-desk__screen" caption={frame?.updatedAt ? fill(t('hk.live.screenAt'), { at: clock(frame.updatedAt) }) : t('hk.live.screen')}>
        {screen?.screenshot
          ? <img alt={t('hk.screen.shotAlt')} src={mediaUrl(vault, run, team.id, screen.screenshot)} />
          : <ScreenBody run={run} team={team.id} screen={screen} />}
      </Browser>
      {last && (
        <span className="hk-quote">
          {last.text}
          <small>{fill(t('hk.live.lastDecision'), { who: roleLabel(t, last.role), at: clock(last.at) })}</small>
        </span>
      )}
    </button>
  );
}

function base(path: string | undefined): string {
  return path ? path.split('/').pop() ?? path : '';
}

/** "index.html dosyasını düzenliyor · 3 dosya değişti". */
function nowLine(t: (k: string) => string, frame: Frame | undefined, screen: Screen | null, edited: number): string {
  if (!frame || !frame.updatedAt) return t('hk.live.nowWaiting');
  if (frame.ended) return edited ? `${t('hk.live.nowEnded')} · ${count(t, edited)}` : t('hk.live.nowEnded');
  const doing = !screen ? '' : screen.path ? fill(t(`hk.doing.${screen.kind}`), { file: base(screen.path) }) : t(`hk.doingBare.${screen.kind}`);
  return [doing, edited ? count(t, edited) : ''].filter(Boolean).join(' · ') || t('hk.live.nowWaiting');
}

function count(t: (k: string) => string, n: number): string {
  return n === 1 ? t('hk.table.files.one') : fill(t('hk.table.filesN'), { n });
}
