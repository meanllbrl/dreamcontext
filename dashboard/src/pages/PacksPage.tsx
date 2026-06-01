import { useI18n } from '../context/I18nContext';
import { usePacks } from '../hooks/usePacks';
import { tagHue } from '../lib/tagColor';
import './PacksPage.css';

export function PacksPage() {
  const { t } = useI18n();
  const { data: packsData, isLoading, isError, error } = usePacks();

  if (isLoading) return <div className="loading">{t('common.loading')}</div>;
  if (isError) return <div className="error-state">{t('common.error')} {error?.message}</div>;

  const packs = packsData?.packs ?? [];
  const standalone = packsData?.standalone ?? [];

  return (
    <div className="packs-page">
      <h1 className="page-title">{t('packs.title')}</h1>

      {packs.length === 0 && standalone.length === 0 && (
        <div className="packs-empty">{t('common.empty')}</div>
      )}

      {packs.length > 0 && (
        <section className="packs-section">
          <h2 className="packs-section-title">{t('packs.section.packs')}</h2>
          <div className="packs-grid">
            {packs.map((pack) => (
              <div key={pack.name} className="packs-card">
                <div className="packs-card-header">
                  <span className="packs-card-name">{pack.name}</span>
                  {pack.installed && (
                    <span className="packs-installed-pill">{t('settings.packs.installed')}</span>
                  )}
                </div>
                {pack.description && (
                  <p className="packs-card-desc">{pack.description}</p>
                )}
                {pack.tags.length > 0 && (
                  <div className="packs-card-tags">
                    {pack.tags.map((tag) => (
                      <span key={tag} className="task-tag" data-hue={tagHue(tag)}>{tag}</span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {standalone.length > 0 && (
        <section className="packs-section">
          <h2 className="packs-section-title">{t('packs.section.standalone')}</h2>
          <div className="packs-grid">
            {standalone.map((skill) => (
              <div key={skill.name} className="packs-card">
                <div className="packs-card-header">
                  <span className="packs-card-name">{skill.name}</span>
                  {skill.installed && (
                    <span className="packs-installed-pill">{t('settings.packs.installed')}</span>
                  )}
                </div>
                {skill.description && (
                  <p className="packs-card-desc">{skill.description}</p>
                )}
                {skill.tags.length > 0 && (
                  <div className="packs-card-tags">
                    {skill.tags.map((tag) => (
                      <span key={tag} className="task-tag" data-hue={tagHue(tag)}>{tag}</span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
