import { useEffect, useRef } from 'react';
import { useI18n } from '../../context/I18nContext';
import {
  useEmbeddingModelStatus,
  useDownloadEmbeddingModel,
  useEmbeddingIndexStatus,
  useBuildEmbeddingIndex,
} from '../../hooks/useEmbeddingModel';

/**
 * "Hybrid search readiness" card, shown under the Hybrid recall option whenever
 * Hybrid is the selected mode. Hybrid recall only engages once BOTH are true:
 *   1. the shared ~113 MB embedding model is downloaded (global), and
 *   2. this vault's embedding index is built (per-vault, one-time).
 * Until then search/recall transparently fall back to BM25. This card makes both
 * steps VISIBLE (progress, failures, ready) and auto-advances them, so enabling
 * Hybrid in the app actually turns it on — no CLI, no surprise work on a later prompt.
 */
function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

function ProgressBar({ pct, label }: { pct: number; label: string }) {
  return (
    <div className="embed-model-bar" role="progressbar" aria-label={label} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className="embed-model-bar-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function EmbeddingModelCard() {
  const { t } = useI18n();
  const { data: model, isLoading: modelLoading } = useEmbeddingModelStatus(true);
  const download = useDownloadEmbeddingModel();
  const modelReady = model?.state === 'ready';
  // The index status only matters once the model is present; poll it then.
  const { data: index, isLoading: indexLoading } = useEmbeddingIndexStatus(!!modelReady);
  const build = useBuildEmbeddingIndex();

  // Auto-advance step 1: download the model when it's absent (runtime present).
  const autoDl = useRef(false);
  useEffect(() => {
    if (autoDl.current) return;
    if (!model || model.state !== 'not_downloaded' || !model.packageInstalled) return;
    autoDl.current = true;
    download.mutate();
  }, [model, download]);

  // Auto-advance step 2: build this vault's index once the model is ready.
  const autoBuild = useRef(false);
  useEffect(() => {
    if (autoBuild.current) return;
    if (!modelReady || !index || index.state !== 'not_built') return;
    autoBuild.current = true;
    build.mutate();
  }, [modelReady, index, build]);

  if (modelLoading || !model) {
    return (
      <div className="embed-model-card">
        <span className="embed-model-status embed-model-status--muted">{t('settings.recall.embed.checking')}</span>
      </div>
    );
  }

  // Runtime missing — hybrid can't run here at all. Surface it plainly (no retry).
  if (!model.packageInstalled) {
    return (
      <div className="embed-model-card embed-model-card--error">
        <span className="embed-model-status embed-model-status--error">✗ {t('settings.recall.embed.no_runtime')}</span>
        <p className="settings-field-hint">{t('settings.recall.embed.no_runtime.hint')}</p>
      </div>
    );
  }

  // ── Step 1: model download ──────────────────────────────────────────────────
  if (model.state === 'error') {
    return (
      <div className="embed-model-card embed-model-card--error">
        <span className="embed-model-status embed-model-status--error">✗ {t('settings.recall.embed.failed')}</span>
        {model.error && <p className="embed-model-errdetail">{model.error}</p>}
        <button type="button" className="embed-model-btn" onClick={() => download.mutate()} disabled={download.isPending}>
          {download.isPending ? t('settings.recall.embed.starting') : t('settings.recall.embed.retry')}
        </button>
      </div>
    );
  }
  if (model.state === 'downloading') {
    const bytes = model.totalBytes > 0 ? `${formatMb(model.loadedBytes)} / ${formatMb(model.totalBytes)}` : null;
    return (
      <div className="embed-model-card">
        <div className="embed-model-row">
          <span className="embed-model-status">⏳ {t('settings.recall.embed.downloading')} {model.progress}%</span>
          {bytes && <span className="embed-model-meta">{bytes}</span>}
        </div>
        <ProgressBar pct={model.progress} label={t('settings.recall.embed.downloading')} />
        <p className="settings-field-hint">{t('settings.recall.embed.step1of2')} · {t('settings.recall.embed.downloading.hint')}</p>
      </div>
    );
  }
  if (model.state === 'not_downloaded') {
    return (
      <div className="embed-model-card">
        <p className="settings-field-hint">{t('settings.recall.embed.needed')}</p>
        <button type="button" className="embed-model-btn embed-model-btn--primary" onClick={() => download.mutate()} disabled={download.isPending}>
          {download.isPending ? t('settings.recall.embed.starting') : t('settings.recall.embed.download')}
        </button>
      </div>
    );
  }

  // ── Step 2: vault index build (model is ready here) ─────────────────────────
  if (indexLoading || !index) {
    return (
      <div className="embed-model-card">
        <span className="embed-model-status embed-model-status--muted">{t('settings.recall.embed.checking')}</span>
      </div>
    );
  }
  if (index.state === 'error') {
    return (
      <div className="embed-model-card embed-model-card--error">
        <span className="embed-model-status embed-model-status--error">✗ {t('settings.recall.embed.index_failed')}</span>
        {index.error && <p className="embed-model-errdetail">{index.error}</p>}
        <button type="button" className="embed-model-btn" onClick={() => build.mutate()} disabled={build.isPending}>
          {build.isPending ? t('settings.recall.embed.starting') : t('settings.recall.embed.retry')}
        </button>
      </div>
    );
  }
  if (index.state === 'building') {
    const counts = index.total > 0 ? `${index.done} / ${index.total}` : null;
    return (
      <div className="embed-model-card">
        <div className="embed-model-row">
          <span className="embed-model-status">⏳ {t('settings.recall.embed.indexing')} {index.progress}%</span>
          {counts && <span className="embed-model-meta">{counts}</span>}
        </div>
        <ProgressBar pct={index.progress} label={t('settings.recall.embed.indexing')} />
        <p className="settings-field-hint">{t('settings.recall.embed.step2of2')} · {t('settings.recall.embed.indexing.hint')}</p>
      </div>
    );
  }
  if (index.state === 'not_built') {
    return (
      <div className="embed-model-card">
        <p className="settings-field-hint">{t('settings.recall.embed.index_needed')}</p>
        <button type="button" className="embed-model-btn embed-model-btn--primary" onClick={() => build.mutate()} disabled={build.isPending}>
          {build.isPending ? t('settings.recall.embed.starting') : t('settings.recall.embed.build_index')}
        </button>
      </div>
    );
  }

  // Both ready → hybrid is live for this vault.
  const size = model.totalBytes > 0 ? formatMb(model.totalBytes) : '~113 MB';
  return (
    <div className="embed-model-card embed-model-card--ready">
      <span className="embed-model-status embed-model-status--ready">✓ {t('settings.recall.embed.ready')}</span>
      <span className="embed-model-meta">{size} · {index.chunks} {t('settings.recall.embed.chunks')} · {t('settings.recall.embed.local')}</span>
    </div>
  );
}
