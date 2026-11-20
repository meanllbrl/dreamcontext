import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useI18n } from '../../context/I18nContext';
import { api, RequestError } from '../../api/client';
import {
  cancelClone,
  getCloneStatus,
  probeFolder,
  useCloneGithubRepo,
  useGithubRepos,
  useInvalidateLauncher,
  type CloneResult,
  type CloneStatus,
  type GithubRepoSummary,
} from '../../hooks/useLauncher';
import { BRAIN_KEYS, useAuthStatus, useLogoutGitHub } from '../../hooks/useBrainStatus';
import { useFixRuns, useReadiness } from '../../hooks/useOnboarding';
import { openFolderPicker, pickerError } from '../../lib/desktop';
import { GitHubMark } from '../../components/brain/GitHubLogin';
import { WaitingCard } from './WaitingCard';
import { CloneProgress } from './CloneProgress';
import { homeShort, repoFromLink, sizeLabel } from './handoffPlan';

/** A bare folder the clone produced: it gets its brain next. */
export interface BareFolder {
  path: string;
  name: string;
  description: string;
  stack: string;
}

interface Props {
  defaultParent: string;
  home: string | undefined;
  /** Back to "Open a project". */
  onBack: () => void;
  /** The clone (or the copy already on this Mac) is a dreamcontext project: land in it. */
  onExistingProject: (vaultName: string) => void;
  /** The clone is a bare codebase: give it its brain, then land. */
  onBareFolder: (folder: BareFolder) => void;
}

const POLL_MS = 700;
/** How long a restart waits for the cancelled clone to end before it plans again. */
const SETTLE_MS = 15_000;



function since(iso: string | undefined, t: (k: string) => string): string {
  if (!iso) return '';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const h = ms / 3_600_000;
  if (h < 1) return t('clone.pushed.now');
  if (h < 24) return t('clone.pushed.hours').replace('{n}', String(Math.round(h)));
  const d = h / 24;
  if (d < 30) return t('clone.pushed.days').replace('{n}', String(Math.round(d)));
  return t('clone.pushed.long');
}

/**
 * Clone from GitHub (plan ilk-acilis v2-02g, C10, C11, C12): sign in once (one click with an
 * importable GitHub CLI login, else GitHub's code page), pick a repository, and it clones with a
 * real percent and lands. Git is installed only here, right after the sign-in; a clone queued
 * before Git is ready waits for it. Leaving cancels a running clone.
 */
export function CloneFlow({ defaultParent, home, onBack, onExistingProject, onBareFolder }: Props) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { data: authStatus, isLoading: authLoading } = useAuthStatus();
  const logout = useLogoutGitHub();
  const { report } = useReadiness('machine');
  const fixRuns = useFixRuns();
  const cloneRepo = useCloneGithubRepo();
  const invalidateLauncher = useInvalidateLauncher();

  const [probe, setProbe] = useState<{ login: string | null; scopes: string[] } | null>(null);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<GithubRepoSummary | null>(null);
  const [parent, setParent] = useState(defaultParent);
  const [taken, setTaken] = useState<string | null>(null);
  const [run, setRun] = useState<{ id: string; repo: string; status: CloneStatus | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stoppedRef = useRef(false);
  const runIdRef = useRef<string | null>(null);
  // The owner's latest clone action. Every start, restart, Cancel and Back takes a new one; work
  // begun for an older action never POSTs a clone (review r2: a pending restart started a clone
  // after Cancel or Back, and a second click started two).
  const actionRef = useRef(0);
  const restartingRef = useRef(false);
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    stoppedRef.current = false;
    return () => {
      stoppedRef.current = true;
      if (runIdRef.current) void cancelClone(runIdRef.current).catch(() => undefined);
    };
  }, []);
  useEffect(() => { if (!parent && defaultParent) setParent(defaultParent); }, [defaultParent, parent]);
  useEffect(() => {
    const id = setTimeout(() => setSearch(query.trim()), 350);
    return () => clearTimeout(id);
  }, [query]);

  const connected = authStatus?.connected === true && !authStatus?.needsReconnect;
  useEffect(() => {
    if (connected || probe) return;
    void api.get<{ login: string | null; scopes: string[] }>('/onboarding/github-probe')
      .then((p) => { if (!stoppedRef.current) setProbe(p); })
      .catch(() => { if (!stoppedRef.current) setProbe({ login: null, scopes: ['repo', 'read:org', 'gist'] }); });
  }, [connected, probe]);

  // C11: Git comes with the first clone. Right after the GitHub sign-in, Apple's installer
  // starts (its window); the list stays usable and a clone waits for it.
  const gitOk = report?.checks.find((c) => c.id === 'git')?.status === 'ok';
  const gitRun = fixRuns.runs['git-install'];
  const gitStarted = useRef(false);
  useEffect(() => {
    if (!connected || !report || gitOk || gitStarted.current) return;
    if (report.platform !== 'darwin') return;
    gitStarted.current = true;
    if (!report.activeFixes.includes('git-install')) void fixRuns.start('git-install', { settleOnBackgroundWait: true });
  }, [connected, report, gitOk, fixRuns]);
  const gitInstalling = !gitOk && (gitRun?.phase === 'running' || gitRun?.phase === 'starting' || !!report?.activeFixes.includes('git-install'));

  const pasted = repoFromLink(query);
  const repos = useGithubRepos(pasted ? '' : search, connected && !run);
  const list = useMemo(() => repos.data?.repos ?? [], [repos.data]);

  const folderName = selected ? selected.fullName.split('/').pop() ?? '' : '';
  const parentClean = parent.trim().replace(/\/+$/, '');
  // A taken folder name gets `-2` (the server picks it the same way and never writes into it).
  useEffect(() => {
    setTaken(null);
    if (!selected || selected.onThisMac || !parentClean) return;
    let live = true;
    void probeFolder(`${parentClean}/${folderName}`).then(() => { if (live) setTaken(`${folderName}-2`); }).catch(() => undefined);
    return () => { live = false; };
  }, [selected, parentClean, folderName]);

  const signin = fixRuns.runs['github-signin'];
  const signinRunning = signin?.phase === 'running' || signin?.phase === 'starting';
  useEffect(() => {
    if (signin?.phase === 'done') void queryClient.invalidateQueries({ queryKey: BRAIN_KEYS.authStatus });
  }, [signin?.phase, queryClient]);

  async function handleResult(result: CloneResult) {
    runIdRef.current = null;
    if (result.hasContext) {
      invalidateLauncher();
      onExistingProject(result.vaultName ?? result.name);
      return;
    }
    onBareFolder({ path: result.path, name: result.name, description: selected?.description ?? '', stack: '' });
  }

  async function startClone(repo: string, shallow = false, action = ++actionRef.current) {
    const current = () => action === actionRef.current && !stoppedRef.current;
    if (!current()) return;
    setError(null);
    try {
      const { cloneId } = await cloneRepo.mutateAsync({ repo, parent: parentClean, shallow });
      if (!current()) { void cancelClone(cloneId).catch(() => undefined); return; }
      runIdRef.current = cloneId;
      setRun({ id: cloneId, repo, status: null });
      for (;;) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        if (stoppedRef.current || runIdRef.current !== cloneId) return;
        const status = await getCloneStatus(cloneId);
        if (stoppedRef.current || runIdRef.current !== cloneId) return;
        setRun({ id: cloneId, repo, status });
        if (status.state === 'done' && status.result) { await handleResult(status.result); return; }
        if (status.state !== 'running') { runIdRef.current = null; return; }
      }
    } catch (err) {
      // Nobody follows the run any more: stop it on the server too, or it clones on unseen and
      // the next try lands in "<name>-2" (review r1).
      const orphan = runIdRef.current;
      runIdRef.current = null;
      if (orphan) void cancelClone(orphan).catch(() => undefined);
      setRun(null);
      setError(err instanceof RequestError ? err.message : err instanceof Error ? err.message : String(err));
    }
  }

  function stop() {
    actionRef.current += 1;
    const id = runIdRef.current;
    runIdRef.current = null;
    if (id) void cancelClone(id).catch(() => undefined);
    setRun(null);
  }

  /** One restart at a time; Cancel or Back while it waits means no clone starts. */
  async function restart(repo: string, shallow: boolean) {
    if (restartingRef.current) return;
    const action = ++actionRef.current;
    restartingRef.current = true;
    setRestarting(true);
    try {
      await cancelAndSettle();
    } finally {
      restartingRef.current = false;
      setRestarting(false);
    }
    void startClone(repo, shallow, action);
  }

  /**
   * Cancel the run in flight and wait until the server has ended it (its half folder is gone by
   * then), so a restart plans the SAME folder instead of "<name>-2" (review r1).
   */
  async function cancelAndSettle(): Promise<void> {
    const id = runIdRef.current;
    runIdRef.current = null;
    if (!id) return;
    await cancelClone(id).catch(() => undefined);
    const until = Date.now() + SETTLE_MS;
    while (Date.now() < until) {
      const status = await getCloneStatus(id).catch(() => null);
      if (!status || status.state !== 'running') return;
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }

  const back = (
    <button type="button" className="ob-link ob-back" onClick={() => { stop(); onBack(); }}>‹ {t('onboarding.open.title')}</button>
  );

  // ─── A clone running or ended ────────────────────────────────────────────────
  if (run) {
    const name = run.repo.split('/').pop() ?? run.repo;
    return (
      <div className="ob-panel-body ob-open">
        {back}
        <CloneProgress
          name={name}
          into={homeShort(`${parentClean}/${taken && !run.status?.result ? taken : name}`, home)}
          status={run.status}
          gitInstalling={gitInstalling}
          gitMissing={gitRun?.status?.gitMissing}
          onCancel={stop}
          restarting={restarting}
          onRetry={(shallow) => {
            if (run.status?.reason === 'git-missing') void fixRuns.start('git-install', { settleOnBackgroundWait: true });
            // A restart while the clone still runs ("Get the latest version only"): end it first.
            void restart(run.repo, shallow);
          }}
          onInstallGit={() => { void fixRuns.start('git-install', { settleOnBackgroundWait: true }); void startClone(run.repo); }}
          onPickAnother={() => setRun(null)}
        />
      </div>
    );
  }

  // ─── Sign in ─────────────────────────────────────────────────────────────────
  if (!connected) {
    const scopes = probe?.scopes ?? [];
    const permission = scopes.includes('read:org')
      ? t('clone.signin.permissionFull')
      : t('clone.signin.permission');
    const outcome = signin?.phase === 'error' ? signin.status?.outcome : undefined;
    return (
      <div className="ob-panel-body ob-open">
        {back}
        <h2 className="ob-title"><GitHubMark size={18} /> {t('onboarding.open.cloneTitle')}</h2>
        <p className="ob-subtitle">{t('clone.signin.subtitle')}</p>
        <div className="ob-card ob-card--center" data-testid="clone-signin">
          {signinRunning && signin?.status?.deviceCode ? (
            <WaitingCard variant={{ kind: 'device-code', code: signin.status.deviceCode }} onCancel={() => void fixRuns.cancel('github-signin')} />
          ) : outcome === 'timeout' ? (
            <>
              <p className="ob-gate-title">{t('clone.signin.expired')}</p>
              <p className="ob-gate-body">{t('clone.signin.expiredBody')}</p>
              <button type="button" className="ob-btn ob-btn--primary" onClick={() => void fixRuns.start('github-signin')}>{t('onboarding.gate.tryAgain')}</button>
            </>
          ) : outcome === 'refused' || outcome === 'canceled' ? (
            <>
              <p className="ob-gate-title">{t('clone.signin.denied')}</p>
              <p className="ob-gate-body">{t('clone.signin.deniedBody')}</p>
              <button type="button" className="ob-btn ob-btn--primary" onClick={() => void fixRuns.start('github-signin')}>{t('onboarding.gate.tryAgain')}</button>
            </>
          ) : (
            <>
              <button type="button" className="ob-btn ob-btn--primary ob-btn--wide" disabled={authLoading || !probe || signinRunning}
                onClick={() => void fixRuns.start('github-signin')} data-testid="clone-signin-btn">
                <GitHubMark size={16} /> {probe?.login ? t('clone.signin.continueAs').replace('{login}', probe.login) : t('clone.signin.button')}
              </button>
              <p className="ob-hint">{probe?.login ? t('clone.signin.ghHint').replace('{login}', probe.login) : t('clone.signin.hint')}</p>
              <p className="ob-hint">{permission}</p>
              {signin?.phase === 'error' && outcome !== undefined && <p className="ob-error" role="alert">{signin.status?.output || t('onboarding.gate.notFinishedTitle')}</p>}
            </>
          )}
        </div>
      </div>
    );
  }

  // ─── Pick a repository ───────────────────────────────────────────────────────
  const login = authStatus?.login ?? '';
  const offline = repos.isError && !(repos.error instanceof RequestError && repos.error.status < 500);
  const target = selected ? homeShort(`${parentClean}/${folderName}`, home) : '';
  // Where the copy on this Mac really is (the server read it from the registry), never a path
  // built from the repo name.
  const onThisMacAt = selected?.onThisMac ? homeShort(selected.onThisMac.path, home) : null;
  return (
    <div className="ob-panel-body ob-open">
      {back}
      <h2 className="ob-title">{t('clone.pick.title')}</h2>
      <p className="ob-subtitle">
        {t('clone.pick.signedAs').replace('{login}', login)}{' '}
        <button type="button" className="ob-link" onClick={() => logout.mutate()}>{t('clone.pick.notYou').replace('{login}', login)}</button>
        {' '}{t('clone.pick.order')}
      </p>
      {gitInstalling && (
        <p className="ob-gitline" role="status"><span className="ob-live-dot" aria-hidden="true" /> {t('clone.git.installingList')}</p>
      )}
      <div className="ob-card ob-repos">
        <input className="ob-input ob-repos-search" type="text" value={query} autoFocus
          placeholder={t('clone.pick.search')} aria-label={t('clone.pick.search')}
          onChange={(e) => { setQuery(e.target.value); setSelected(null); }}
          onKeyDown={(e) => { if (e.key === 'Enter' && pasted) void startClone(pasted); }}
          data-testid="clone-search" />
        {offline ? (
          <div className="ob-repos-empty"><p className="ob-gate-title">{t('clone.pick.offline')}</p><p className="ob-gate-body">{t('clone.pick.offlineBody')}</p></div>
        ) : pasted ? (
          <div className="ob-repo ob-repo--selected"><span className="ob-repo-name">{pasted}</span>
            <button type="button" className="ob-btn ob-btn--primary ob-btn--sm" onClick={() => void startClone(pasted)}>{t('clone.pick.clone')}</button></div>
        ) : list.length === 0 && !repos.isLoading ? (
          <div className="ob-repos-empty">
            {search
              ? <><p className="ob-gate-title">{t('clone.pick.noMatch').replace('{q}', search)}</p><p className="ob-gate-body">{t('clone.pick.noMatchBody')}</p></>
              : <><p className="ob-gate-title">{t('clone.pick.none').replace('{login}', login)}</p><p className="ob-gate-body">{t('clone.pick.noneBody')}</p></>}
          </div>
        ) : (
          <ul className="ob-repo-list" data-testid="clone-repos">
            {list.map((r) => {
              const [owner, name] = r.fullName.split('/');
              const on = selected?.fullName === r.fullName;
              const big = (r.sizeKb ?? 0) * 1024 > 1e9;
              return (
                <li key={r.fullName} className={`ob-repo${on ? ' ob-repo--selected' : ''}`}>
                  {/* The row's select is a real button: Tab reaches it, Enter or Space picks it. */}
                  <button type="button" className="ob-repo-pick" aria-pressed={on} onClick={() => setSelected(r)}>
                    <span className="ob-repo-avatar" aria-hidden="true">{(owner ?? '?').slice(0, 1).toUpperCase()}</span>
                    <span className="ob-repo-text">
                      <span className="ob-repo-name"><span className="ob-repo-owner">{owner} /</span> {name}
                        {r.private && <span className="ob-badge">{t('clone.pick.private')}</span>}
                        {r.onThisMac && <span className="ob-badge ob-badge--ok">{t('clone.pick.onThisMac')}</span>}
                      </span>
                      <span className="ob-repo-desc">{[r.description, since(r.pushedAt, t), big ? sizeLabel((r.sizeKb ?? 0) * 1024) : ''].filter(Boolean).join(' · ')}</span>
                    </span>
                  </button>
                  {on && (r.onThisMac
                    ? <button type="button" className="ob-btn ob-btn--secondary ob-btn--sm" onClick={() => onExistingProject(r.onThisMac!.vault)} data-testid="clone-open">{t('clone.pick.open')}</button>
                    : <button type="button" className="ob-btn ob-btn--primary ob-btn--sm" onClick={() => void startClone(r.fullName)} data-testid="clone-go">{t('clone.pick.clone')}</button>)}
                </li>
              );
            })}
          </ul>
        )}
        {selected && (
          <div className="ob-repos-foot">
            {onThisMacAt ? (
              <span>{t('clone.pick.alreadyAt').replace('{path}', onThisMacAt)}</span>
            ) : taken ? (
              <span>{t('clone.pick.taken').replace('{name}', folderName).replace('{alt}', taken)}</span>
            ) : (
              <span>{t('clone.pick.into').replace('{path}', target)}</span>
            )}
            {!onThisMacAt && (
              <button type="button" className="ob-link" onClick={async () => {
                const picked = await openFolderPicker();
                if (picked) setParent(picked.normalize('NFC'));
                else if (pickerError()) setError(pickerError());
              }}>{t('onboarding.open.change')}</button>
            )}
          </div>
        )}
        <a className="ob-link ob-orglink" href="https://github.com/settings/applications" target="_blank" rel="noreferrer">{t('clone.pick.orgs')}</a>
      </div>
      {error && <p className="ob-error" role="alert">{error}</p>}
    </div>
  );
}
