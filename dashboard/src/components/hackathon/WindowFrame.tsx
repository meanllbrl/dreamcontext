import type { ReactNode } from 'react';
import { useI18n } from '../../context/I18nContext';
import { useVaultId } from '../../context/VaultContext';
import { mediaUrl, type MemberRole, type Screen } from './data';

/**
 * A window frame (three dots, a title row, a body): the approved Canlı and Ekip odası mockups put
 * each team's screen and files in one. `live` marks a frame whose team is mid-turn.
 */
export function WindowFrame({ title, live, tabs, children, className }: {
  title: ReactNode;
  live?: boolean;
  tabs?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const { t } = useI18n();
  return (
    <div className={`hk-win${className ? ` ${className}` : ''}`}>
      <div className="hk-win__bar">
        <span className="hk-win__dots" aria-hidden="true"><i /><i /><i /></span>
        <span className="hk-win__title">{title}</span>
        {tabs}
        {live && <span className="hk-win__live">{t('hk.live')}</span>}
      </div>
      <div className="hk-win__body">{children}</div>
    </div>
  );
}

/** A team's last tool event drawn as its "computer screen": an edit, a read, a command, a shot. */
export function ScreenBody({ run, team, screen, big }: { run: string; team: string; screen: Screen | null; big?: boolean }) {
  const { t } = useI18n();
  const { vault } = useVaultId();
  if (!screen) return <p className="hk-screen__empty">{t('hk.screen.none')}</p>;
  return (
    <div className={`hk-screen${big ? ' hk-screen--big' : ''}`}>
      {screen.path && <div className="hk-screen__path hk-mono">{screen.path}</div>}
      {screen.screenshot ? (
        <img className="hk-screen__shot" alt={t('hk.screen.shotAlt')} src={mediaUrl(vault, run, team, screen.screenshot)} />
      ) : screen.lines && screen.lines.length ? (
        <pre className={`hk-screen__code hk-mono hk-screen__code--${screen.kind}`}>{screen.lines.join('\n')}</pre>
      ) : (
        <p className="hk-screen__empty">{t(`hk.screen.kind.${screen.kind}`)}</p>
      )}
      {screen.command && (
        <div className="hk-screen__term hk-mono">
          <span>$ {screen.command}</span>
          {screen.resultLine && <span className="hk-screen__result"> → {screen.resultLine}</span>}
        </div>
      )}
    </div>
  );
}

/** The role's display name (Kaptan, Yapıcı, Eleştirmen). */
export function roleLabel(t: (k: string) => string, role: MemberRole): string {
  return t(`hk.role.${role}`);
}
