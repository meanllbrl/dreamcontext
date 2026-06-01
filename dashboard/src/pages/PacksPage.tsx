import { useState, useEffect, useCallback } from 'react';
import { useI18n } from '../context/I18nContext';
import { usePacks, type CatalogPack, type CatalogStandalone } from '../hooks/usePacks';
import { tagHue } from '../lib/tagColor';
import './PacksPage.css';

type DetailItem = CatalogPack | CatalogStandalone;

function isPack(item: DetailItem): item is CatalogPack {
  return 'base' in item;
}

interface PackDetailModalProps {
  item: DetailItem;
  onClose: () => void;
}

function PackDetailModal({ item, onClose }: PackDetailModalProps) {
  const { t } = useI18n();

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="packs-modal-overlay"
      onClick={handleOverlayClick}
      aria-modal="true"
      role="dialog"
      aria-label={item.name}
    >
      <div className="packs-modal-panel">
        <div className="packs-modal-header">
          <div className="packs-modal-title-row">
            <h2 className="packs-modal-name">{item.name}</h2>
            {item.installed && (
              <span className="packs-installed-pill">{t('settings.packs.installed')}</span>
            )}
          </div>
          <button
            className="packs-modal-close btn btn--ghost"
            type="button"
            onClick={onClose}
            aria-label={t('packs.detail.close')}
          >
            {t('packs.detail.close')}
          </button>
        </div>

        {item.description && (
          <p className="packs-modal-desc">{item.description}</p>
        )}

        {item.tags.length > 0 && (
          <div className="packs-modal-tags">
            {item.tags.map((tag) => (
              <span key={tag} className="task-tag" data-hue={tagHue(tag)}>{tag}</span>
            ))}
          </div>
        )}

        {isPack(item) && (
          <>
            {item.base && (
              <div className="packs-modal-section">
                <h3 className="packs-modal-section-title">{t('packs.detail.base')}</h3>
                <p className="packs-modal-mono">{item.base}</p>
              </div>
            )}

            {item.subSkills.length > 0 && (
              <div className="packs-modal-section">
                <h3 className="packs-modal-section-title">{t('packs.detail.subskills')}</h3>
                <ul className="packs-modal-subskills">
                  {item.subSkills.map((sub) => (
                    <li key={sub.name} className="packs-modal-subskill">
                      <span className="packs-modal-subskill-name">{sub.name}</span>
                      {sub.description && (
                        <span className="packs-modal-subskill-desc">{sub.description}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {item.relatedAgents && item.relatedAgents.length > 0 && (
              <div className="packs-modal-section">
                <h3 className="packs-modal-section-title">{t('packs.detail.agents')}</h3>
                <ul className="packs-modal-agents">
                  {item.relatedAgents.map((agent) => (
                    <li key={agent} className="packs-modal-agent">{agent}</li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

interface PackCardProps {
  item: DetailItem;
  onClick: (item: DetailItem) => void;
}

function PackCard({ item, onClick }: PackCardProps) {
  const { t } = useI18n();

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick(item);
    }
  };

  return (
    <div
      className="packs-card packs-card--clickable"
      role="button"
      tabIndex={0}
      onClick={() => onClick(item)}
      onKeyDown={handleKeyDown}
      aria-label={item.name}
    >
      <div className="packs-card-header">
        <span className="packs-card-name">{item.name}</span>
        {item.installed && (
          <span className="packs-installed-pill">{t('settings.packs.installed')}</span>
        )}
      </div>
      {item.description && (
        <p className="packs-card-desc">{item.description}</p>
      )}
      {item.tags.length > 0 && (
        <div className="packs-card-tags">
          {item.tags.map((tag) => (
            <span key={tag} className="task-tag" data-hue={tagHue(tag)}>{tag}</span>
          ))}
        </div>
      )}
    </div>
  );
}

export function PacksPage() {
  const { t } = useI18n();
  const { data: packsData, isLoading, isError, error } = usePacks();
  const [selectedItem, setSelectedItem] = useState<DetailItem | null>(null);

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
              <PackCard key={pack.name} item={pack} onClick={setSelectedItem} />
            ))}
          </div>
        </section>
      )}

      {standalone.length > 0 && (
        <section className="packs-section">
          <h2 className="packs-section-title">{t('packs.section.standalone')}</h2>
          <div className="packs-grid">
            {standalone.map((skill) => (
              <PackCard key={skill.name} item={skill} onClick={setSelectedItem} />
            ))}
          </div>
        </section>
      )}

      {selectedItem !== null && (
        <PackDetailModal item={selectedItem} onClose={() => setSelectedItem(null)} />
      )}
    </div>
  );
}
