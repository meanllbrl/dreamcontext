import { useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import { badge, clock, fill, useFiles, type Frame, type RunTeam } from './data';
import { ScreenBody, WindowFrame, roleLabel } from './WindowFrame';

/**
 * The team room (approved mockup `hackathon-ekip-odasi.png`): the members and their jobs, the
 * team's computer screen in a window frame with a tab per member, the plan meeting (balloons only
 * for plan, objection and decision), and the team's files in a second frame: the files it changed
 * on its own branch (each opens a preview) and how many sources it read.
 */
export function TeamRoom({ run, team, frame, round, rounds, onBack }: {
  run: string;
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
      <header className="hk-head">
        <button type="button" className="hk-back" onClick={onBack}>‹ {t('hk.room.back')}</button>
        <span className="hk-badge" data-tool={team.tool}>{badge(team.name)}</span>
        <h2 className="hk-head__title">{fill(t('hk.room.title'), { team: team.name })}</h2>
        {round != null && <span className="hk-chip">{fill(t('hk.round'), { n: round, of: rounds })}</span>}
        <span className="hk-muted hk-head__sub">{team.tool === 'codex' ? 'Codex' : 'Claude'} · {team.model || t('hk.defaultModel')}</span>
      </header>

      <div className="hk-room__grid">
        <aside className="hk-room__side">
          <div className="hk-panel">
            <h3 className="hk-section">{t('hk.room.members')}</h3>
            <ul className="hk-room__members">
              {members.map((m) => (
                <li key={m.role} className="hk-member hk-member--row" data-state={m.state}>
                  <span className="hk-member__dot" aria-hidden="true" />
                  <span>
                    <strong>{roleLabel(t, m.role)}</strong>
                    <span className="hk-muted"> · {t(`hk.role.${m.role}.job`)}</span>
                  </span>
                  <span className="hk-muted hk-member__state">{t(`hk.memberState.${m.state}`)}</span>
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

          <section className="hk-panel hk-meeting" aria-label={t('hk.room.meeting')}>
            <h3 className="hk-section">{round != null ? fill(t('hk.room.meetingRound'), { n: round }) : t('hk.room.meeting')}</h3>
            {meeting.length ? (
              <ul className="hk-meeting__list">
                {meeting.map((d, i) => (
                  <li key={`${d.at}-${i}`} className="hk-balloon" data-kind={d.kind}>
                    <span className="hk-balloon__who">{roleLabel(t, d.role)} · {t(`hk.decision.${d.kind}`)}{d.at ? ` · ${clock(d.at)}` : ''}</span>
                    <span>{d.text}</span>
                    {d.borrowed && <span className="hk-chip">{t('hk.room.borrowed')}</span>}
                  </li>
                ))}
              </ul>
            ) : <p className="hk-muted">{t('hk.room.noMeeting')}</p>}
          </section>
        </div>

        <WindowFrame className="hk-win--tall hk-room__files" title={t('hk.room.files')}>
          {isError && <p className="hk-error">{t('hk.room.filesFailed')}</p>}
          <h4 className="hk-section">{t('hk.room.changed')}</h4>
          {files?.edited.length ? (
            <ul className="hk-files">
              {files.edited.map((p) => (
                <li key={p}>
                  <button type="button" className="hk-file" data-on={preview === p ? 'true' : undefined} onClick={() => setPreview(preview === p ? null : p)}>
                    <span className="hk-mono">{p}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : <p className="hk-muted">{t('hk.room.noChanges')}</p>}
          <h4 className="hk-section">{t('hk.room.sources')}</h4>
          <p className="hk-muted">{fill(t('hk.room.reads'), { n: files?.reads ?? 0 })}</p>
          {!!files?.dropped.length && (
            <>
              <h4 className="hk-section">{t('hk.room.dropped')}</h4>
              <ul className="hk-dropped">{files.dropped.map((x, i) => <li key={i} className="hk-muted">{x}</li>)}</ul>
            </>
          )}
          {files?.preview && (
            <div className="hk-preview">
              <div className="hk-screen__path hk-mono">{files.preview.path}</div>
              {'lines' in files.preview
                ? <pre className="hk-screen__code hk-mono">{files.preview.lines.join('\n')}{files.preview.truncated ? '\n…' : ''}</pre>
                : <p className="hk-muted">{files.preview.reason}</p>}
            </div>
          )}
        </WindowFrame>
      </div>
    </div>
  );
}
