import { useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import { clock, fill, modelLabel, useFiles, type Frame, type RunTeam } from './data';
import { TeamMark } from './parts';
import { ScreenBody, WindowFrame, roleLabel } from './WindowFrame';

/**
 * The team room (approved mockup `hackathon-ekip-odasi.png`): the members and their jobs, the
 * team's computer screen in a window frame with a tab per member, the plan meeting (balloons only
 * for plan, objection and decision), and the team's files in a second frame: the files it changed
 * on its own branch (each opens a preview) and how many sources it read.
 */
export function TeamRoom({ run, teams, team, frame, round, rounds, onBack }: {
  run: string;
  teams: readonly RunTeam[];
  team: RunTeam;
  frame: Frame | undefined;
  round: number | null;
  rounds: number;
  onBack: () => void;
}) {
  const { t } = useI18n();
  const [preview, setPreview] = useState<string | null>(null);
  const { data: files, isError } = useFiles(run, team.id, preview);
  const screen = frame?.screen ?? null;
  const live = !!frame && !frame.ended && frame.members.some((m) => m.state !== 'idle');
  const members = frame?.members ?? [];
  const meeting = (files?.decisions ?? []).slice(-12);

  return (
    <div className="hk-room">
      <header className="hk-top hk-top--room">
        <button type="button" className="hk-back" onClick={onBack}>‹ {t('hk.room.back')}</button>
        <TeamMark teams={teams} team={team} />
        <h2 className="hk-title">{fill(t('hk.room.title'), { team: team.name })}</h2>
        {round != null && <span className="hk-chip">{fill(t('hk.round'), { n: round, of: rounds })}</span>}
        <span className="hk-quiet hk-top__end">{modelLabel(team.tool, team.model)}</span>
      </header>

      <div className="hk-room__grid">
        <aside className="hk-room__side">
          <div className="hk-box">
            <h3 className="hk-label">{t('hk.room.members')}</h3>
            <ul className="hk-room__members">
              {members.map((m) => (
                <li key={m.role} className="hk-member hk-member--row" data-role={m.role} data-state={m.state}>
                  <span className="hk-member__dot" aria-hidden="true" />
                  <span>
                    <strong>{roleLabel(t, m.role)}</strong>
                    <span className="hk-quiet"> · {t(`hk.role.${m.role}.job`)}</span>
                  </span>
                  <span className="hk-quiet hk-member__state">{frame?.ended ? t('hk.memberState.ended') : t(`hk.memberState.${m.state}`)}</span>
                </li>
              ))}
            </ul>
            {team.persona && <p className="hk-room__persona">{team.persona}</p>}
          </div>
        </aside>

        <div className="hk-room__main">
          <WindowFrame
            className="hk-win--tall"
            title={t('hk.room.computer')}
            live={live}
            tabs={(
              <span className="hk-win__tabs" role="list">
                {members.map((m) => (
                  <span key={m.role} role="listitem" className="hk-win__tab" data-on={screen?.role === m.role ? 'true' : undefined} data-state={m.state}>
                    {roleLabel(t, m.role)}
                  </span>
                ))}
              </span>
            )}
          >
            <ScreenBody run={run} team={team.id} screen={screen} big />
          </WindowFrame>

          <section className="hk-box hk-meeting" aria-label={t('hk.room.meeting')}>
            <h3 className="hk-label">{round != null ? fill(t('hk.room.meetingRound'), { n: round }) : t('hk.room.meeting')}</h3>
            {meeting.length ? (
              <ul className="hk-meeting__list">
                {meeting.map((d, i) => (
                  <li key={`${d.at}-${i}`} className="hk-balloon" data-kind={d.kind} data-role={d.role}>
                    <span className="hk-balloon__who">{roleLabel(t, d.role)} · {t(`hk.decision.${d.kind}`)}{d.at ? ` · ${clock(d.at)}` : ''}</span>
                    <span>{d.text}</span>
                    {d.borrowed && <span className="hk-chip">{t('hk.room.borrowed')}</span>}
                  </li>
                ))}
              </ul>
            ) : <p className="hk-quiet">{t('hk.room.noMeeting')}</p>}
          </section>
        </div>

        <section className="hk-box hk-room__files" aria-label={t('hk.room.files')}>
          {isError && <p className="hk-error">{t('hk.room.filesFailed')}</p>}
          <h3 className="hk-label">{fill(t('hk.room.changedN'), { n: files?.edited.length ?? 0 })}</h3>
          {files?.edited.length ? (
            <ul className="hk-files">
              {files.edited.map((p) => {
                const cut = p.lastIndexOf('/');
                return (
                  <li key={p}>
                    <button type="button" className="hk-file" aria-pressed={preview === p} onClick={() => setPreview(preview === p ? null : p)}>
                      <span className="hk-file__name">{cut < 0 ? p : p.slice(cut + 1)}</span>
                      {cut > 0 && <span className="hk-file__dir">{p.slice(0, cut)}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : <p className="hk-quiet">{t('hk.room.noChanges')}</p>}
          {!!files?.dropped.length && (
            <>
              <h3 className="hk-label">{t('hk.room.dropped')}</h3>
              <ul className="hk-dropped">{files.dropped.map((x, i) => <li key={i} className="hk-small">{x}</li>)}</ul>
            </>
          )}
          {files?.preview && (
            <div className="hk-preview">
              <div className="hk-screen__path hk-mono">{files.preview.path}</div>
              {'lines' in files.preview
                ? <pre className="hk-screen__code hk-mono">{files.preview.lines.join('\n')}{files.preview.truncated ? '\n…' : ''}</pre>
                : <p className="hk-quiet">{files.preview.reason}</p>}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
