import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import {
  cancelClone,
  getCloneStatus,
  probeFolder,
  useCloneGithubRepo,
  useGithubRepos,
  useInvalidateLauncher,
  useRegisterVault,
  type CloneResult,
  type FolderProbe,
} from '../../hooks/useLauncher';
import { useAuthStatus } from '../../hooks/useBrainStatus';
import { GitHubLogin } from '../../components/brain/GitHubLogin';
import { openFolderPicker, pickerError } from '../../lib/desktop';

/** A bare folder the clone produced (or an existing one the person chose): set it up next. */
export interface BareFolder {
  path: string;
  name: string;
  description: string;
  stack: string;
}

interface Props {
  defaultParent: string;
  /** Leave the clone flow (back to the three cards). */
  onBack: () => void;
  /** The clone (or the folder already there) is a dreamcontext project: open it. */
  onExistingProject: (vaultName: string) => void;
  /** The clone is a bare codebase: continue to the project details. */
  onBareFolder: (folder: BareFolder) => void;
}

const POLL_MS = 700;

/**
 * Clone from GitHub: pick a repository, pick where it lands, clone it as a cancelable
 * background job with git's live progress. Behaviour moved unchanged from the old wizard:
 * the destination is probed first so an existing folder gets "open it" / "use it" /
 * "choose another" instead of a dead-end error, and leaving the flow mid-clone cancels it.
 */
export function CloneFlow({ defaultParent, onBack, onExistingProject, onBareFolder }: Props) {
  const { t } = useI18n();
  const { data: authStatus, isLoading: authLoading } = useAuthStatus();
  const cloneRepo = useCloneGithubRepo();
  const register = useRegisterVault();
  const invalidateLauncher = useInvalidateLauncher();

  const [step, setStep] = useState<'repo' | 'dest'>('repo');
  const [repoQuery, setRepoQuery] = useState('');
  const [repoSearch, setRepoSearch] = useState('');
  const [selectedRepo, setSelectedRepo] = useState('');
  const [selectedRepoDesc, setSelectedRepoDesc] = useState('');
  const [cloneParent, setCloneParent] = useState(defaultParent);
  const [cloneRun, setCloneRun] = useState<{ id: string; progress: string } | null>(null);
  const [destConflict, setDestConflict] = useState<(FolderProbe & { path: string }) | null>(null);
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Flipped on unmount so a late poll never touches dead state. */
  const stoppedRef = useRef(false);
  /** Synchronous double-click latch: the probe runs before the clone mutation is pending. */
  const busyRef = useRef(false);
  const runIdRef = useRef<string | null>(null);

  useEffect(() => {
    stoppedRef.current = false;
    return () => {
      stoppedRef.current = true;
      // Leaving the flow means "stop": a clone that later materialises a project is worse.
      if (runIdRef.current) void cancelClone(runIdRef.current).catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    if (!cloneParent && defaultParent) setCloneParent(defaultParent);
  }, [defaultParent, cloneParent]);

  useEffect(() => {
    const id = setTimeout(() => setRepoSearch(repoQuery.trim()), 350);
    return () => clearTimeout(id);
  }, [repoQuery]);

  const connected = authStatus?.connected === true && !authStatus?.needsReconnect;
  const repos = useGithubRepos(repoSearch, connected && step === 'repo');
  const repoFolder = selectedRepo.split('/').pop() ?? '';
  const parent = cloneParent.trim().replace(/\/+$/, '');

  async function handleResult(result: CloneResult) {
    runIdRef.current = null;
    if (result.hasContext) {
      invalidateLauncher();
      onExistingProject(result.vaultName ?? result.name);
      return;
    }
    let stack = '';
    try {
      stack = (await probeFolder(result.path)).stack ?? '';
    } catch {
      /* stack prefill is best-effort */
    }
    if (stoppedRef.current) return;
    setCloneRun(null);
    onBareFolder({ path: result.path, name: result.name, description: selectedRepoDesc, stack });
  }

  async function poll(id: string) {
    if (stoppedRef.current) return;
    try {
      const status = await getCloneStatus(id);
      if (stoppedRef.current) return;
      if (status.state === 'running') {
        setCloneRun({ id, progress: status.progress });
        setTimeout(() => void poll(id), POLL_MS);
        return;
      }
      if (status.state === 'done' && status.result) {
        await handleResult(status.result);
        return;
      }
      runIdRef.current = null;
      setCloneRun(null);
      if (status.error && !/canceled/i.test(status.error)) setError(status.error);
      else if (!status.error) setError(t('onboarding.clone.expired'));
    } catch (err) {
      runIdRef.current = null;
      setCloneRun(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function startClone() {
    if (busyRef.current || cloneRepo.isPending) return;
    busyRef.current = true;
    setProbing(true);
    setError(null);
    setDestConflict(null);
    try {
      if (parent && repoFolder) {
        try {
          const probe = await probeFolder(`${parent}/${repoFolder}`);
          setDestConflict({ ...probe, path: `${parent}/${repoFolder}` });
          return;
        } catch (probeErr) {
          // Only "does not exist" means the destination is free; any other failure aborts.
          const msg = probeErr instanceof Error ? probeErr.message : String(probeErr);
          if (!/does not exist/i.test(msg)) {
            setError(msg);
            return;
          }
        }
      }
      const res = await cloneRepo.mutateAsync({ url: selectedRepo, parentDir: cloneParent.trim() });
      runIdRef.current = res.cloneId;
      setCloneRun({ id: res.cloneId, progress: '' });
      void poll(res.cloneId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      busyRef.current = false;
      setProbing(false);
    }
  }

  async function stopClone() {
    if (!cloneRun) return;
    try {
      await cancelClone(cloneRun.id);
    } catch {
      /* idempotent server-side; the poll settles either way */
    }
  }

  async function useExisting() {
    if (!destConflict || register.isPending) return;
    setError(null);
    if (destConflict.hasContext) {
      try {
        await register.mutateAsync({ name: destConflict.name, path: destConflict.path });
      } catch (regErr) {
        const msg = regErr instanceof Error ? regErr.message : String(regErr);
        if (!/already registered/i.test(msg)) {
          setError(msg);
          return;
        }
      }
      onExistingProject(destConflict.name);
      return;
    }
    onBareFolder({
      path: destConflict.path,
      name: destConflict.name,
      description: selectedRepoDesc,
      stack: destConflict.stack ?? '',
    });
  }

  async function browseParent() {
    setError(null);
    const picked = await openFolderPicker();
    if (picked) setCloneParent(picked);
    else {
      const failure = pickerError();
      if (failure) setError(failure);
    }
  }

  function body() {
    if (step === 'repo') {
      return (
        <>
          <h2 className="ob-title ob-title--sm">{t('onboarding.clone.repoTitle')}</h2>
          {authLoading ? (
            <p className="ob-hint">{t('onboarding.clone.checkingSignIn')}</p>
          ) : !connected ? (
            <>
              <p className="ob-hint">{t('onboarding.clone.signInHint')}</p>
              <GitHubLogin />
            </>
          ) : (
            <>
              <p className="ob-hint">{t('onboarding.clone.searchHint')}</p>
              <input
                type="search"
                className="ob-input"
                placeholder={t('onboarding.clone.searchPlaceholder')}
                value={repoQuery}
                onChange={(e) => setRepoQuery(e.target.value)}
                aria-label={t('onboarding.clone.searchLabel')}
                autoFocus
              />
              <div className="ob-repo-list" role="listbox" aria-label={t('onboarding.clone.listLabel')}>
                {repos.isLoading && <p className="ob-hint">{t('onboarding.clone.loading')}</p>}
                {repos.isError && <p className="ob-hint">{t('onboarding.clone.loadFailed')}</p>}
                {!repos.isLoading && !repos.isError && (repos.data?.repos.length ?? 0) === 0 && (
                  <p className="ob-hint">{t('onboarding.clone.none')}</p>
                )}
                {(repos.data?.repos ?? []).map((r) => {
                  const on = selectedRepo === r.fullName;
                  return (
                    <button
                      key={r.fullName}
                      type="button"
                      role="option"
                      aria-selected={on}
                      className={`ob-repo${on ? ' ob-repo--on' : ''}`}
                      onClick={() => {
                        setSelectedRepo(on ? '' : r.fullName);
                        setSelectedRepoDesc(on ? '' : (r.description ?? ''));
                      }}
                    >
                      <span className="ob-repo-name">
                        {r.fullName}
                        {r.private && <span className="ob-badge">{t('onboarding.clone.private')}</span>}
                      </span>
                      {r.description && <span className="ob-hint">{r.description}</span>}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </>
      );
    }

    if (cloneRun) {
      const tail = cloneRun.progress.split('\n').filter((l) => l.trim()).slice(-6).join('\n');
      return (
        <>
          <h2 className="ob-title ob-title--sm">{t('onboarding.clone.cloningTitle').replace('{repo}', selectedRepo)}</h2>
          <p className="ob-hint">
            <span className="ob-live-dot" aria-hidden="true" />
            {t('onboarding.clone.cloningHint').replace('{path}', `${parent}/${repoFolder}`)}
          </p>
          <pre className="ob-progress-log" aria-live="polite">{tail || t('onboarding.clone.contacting')}</pre>
        </>
      );
    }

    if (destConflict) {
      return (
        <>
          <h2 className="ob-title ob-title--sm">{t('onboarding.clone.existsTitle')}</h2>
          <p className="ob-hint ob-path">{destConflict.path}</p>
          <p className="ob-hint">
            {destConflict.hasContext ? t('onboarding.clone.existsProject') : t('onboarding.clone.existsFolder')}
          </p>
          <div className="ob-choices">
            <button type="button" className="ob-choice" onClick={() => void useExisting()} disabled={register.isPending}>
              <span className="ob-choice-title">
                {destConflict.hasContext ? t('onboarding.clone.openExisting') : t('onboarding.clone.useExisting')}
              </span>
            </button>
            <button type="button" className="ob-choice" onClick={() => setDestConflict(null)}>
              <span className="ob-choice-title">{t('onboarding.clone.chooseAnother')}</span>
            </button>
          </div>
        </>
      );
    }

    return (
      <>
        <h2 className="ob-title ob-title--sm">{t('onboarding.clone.destTitle')}</h2>
        <p className="ob-hint">{t('onboarding.clone.destHint')}</p>
        <div className="ob-inline">
          <input
            className="ob-input"
            type="text"
            value={cloneParent}
            placeholder={defaultParent}
            onChange={(e) => setCloneParent(e.target.value)}
            aria-label={t('onboarding.project.location')}
          />
          <button type="button" className="ob-btn ob-btn--secondary" onClick={() => void browseParent()}>
            {t('onboarding.project.browse')}
          </button>
        </div>
        {parent && repoFolder && (
          <p className="ob-hint ob-path">{t('onboarding.clone.destPreview').replace('{path}', `${parent}/${repoFolder}`)}</p>
        )}
      </>
    );
  }

  return (
    <div className="ob-panel-body">
      {body()}
      {error && <p className="ob-error" role="alert">{error}</p>}
      <div className="ob-actions">
        <button
          type="button"
          className="ob-btn ob-btn--secondary"
          onClick={() => {
            setError(null);
            setDestConflict(null);
            if (step === 'dest') setStep('repo');
            else onBack();
          }}
          disabled={cloneRepo.isPending || !!cloneRun}
        >
          {t('onboarding.back')}
        </button>
        {step === 'repo' ? (
          <button
            type="button"
            className="ob-btn ob-btn--primary"
            onClick={() => setStep('dest')}
            disabled={!connected || !selectedRepo}
          >
            {t('onboarding.continue')}
          </button>
        ) : cloneRun ? (
          <button type="button" className="ob-btn ob-btn--secondary" onClick={() => void stopClone()}>
            {t('onboarding.clone.cancel')}
          </button>
        ) : destConflict ? null : (
          <button
            type="button"
            className="ob-btn ob-btn--primary"
            onClick={() => void startClone()}
            disabled={probing || cloneRepo.isPending || !parent || !selectedRepo}
          >
            {probing || cloneRepo.isPending ? t('onboarding.clone.starting') : t('onboarding.clone.clone')}
          </button>
        )}
      </div>
    </div>
  );
}
