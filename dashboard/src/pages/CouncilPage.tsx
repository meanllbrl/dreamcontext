import { useState } from 'react';
import { useCouncilList, useCouncilDebate } from '../hooks/useCouncil';
import { useI18n } from '../context/I18nContext';
import { CouncilHall } from '../components/council/CouncilHall';
import { CouncilDetail } from '../components/council/CouncilDetail';
import './CouncilPage.css';

export function CouncilPage() {
  const { t } = useI18n();
  const { data: debates, isLoading, isError, error } = useCouncilList();
  const [openId, setOpenId] = useState<string | null>(null);
  const { data: debate, isLoading: loadingDetail } = useCouncilDebate(openId);

  if (isLoading) return <div className="loading">{t('common.loading')}</div>;
  if (isError) return <div className="error-state">Failed to load council sessions. {error?.message}</div>;

  if (openId) {
    return (
      <div className="council-page council-page--detail">
        {loadingDetail && <div className="loading">Loading session…</div>}
        {debate && <CouncilDetail debate={debate} onBack={() => setOpenId(null)} />}
      </div>
    );
  }

  return (
    <div className="council-page">
      <h1 className="page-title">{t('council.title')}</h1>
      <CouncilHall debates={debates ?? []} onOpen={setOpenId} />
    </div>
  );
}
