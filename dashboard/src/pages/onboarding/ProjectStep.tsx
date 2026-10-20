import { useEffect, useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import { RequestError } from '../../api/client';
import {
  probeFolder,
  useLauncherDefaults,
  useRegisterVault,
  useScaffoldProject,
  type CliInstallResult,
  type FolderProbe,
  type ScaffoldPayload,
} from '../../hooks/useLauncher';
import { openFolderPicker, pickerError } from '../../lib/desktop';
import type { ReadinessReport } from '../../lib/onboardingTypes';
import { GitHubMark } from '../../components/brain/GitHubLogin';
import { CloneFlow, type BareFolder } from './CloneFlow';
import { gitTrackState, type GitTrackState } from './handoffPlan';

type Mode = 'new' | 'existing' | 'github';

export interface CreatedProject {
  name: string;
  path: string;
  cli?: CliInstallResult;
}

interface Props {
  report: ReadinessReport | undefined;
  /** A project was created or set up: go on to the hand-off. */
  onCreated: (project: CreatedProject) => void;
  /** The folder is already a dreamcontext project: open it, no questions. */
  onOpenExisting: (vaultName: string) => void;
}

/** The folder picked in "Open a folder" (or handed over by the clone), with what detect saw. */
interface PickedFolder {
  path: string;
  probe: FolderProbe | null;
}

/**
 * The Project step: three cards, then ONE details screen with name and location only. No quiz
 * and no skill-pack picker: the initializer chat "Start with Claude" opens asks what it cannot
 * detect and recommends the packs that fit. A GitHub description and a detected stack still
 * ride along silently, so the scaffold's `init` starts from them.
 */
export function ProjectStep({ report, onCreated, onOpenExisting }: Props) {
  const { t } = useI18n();
  const defaults = useLauncherDefaults();
  const scaffold = useScaffoldProject();
  const register = useRegisterVault();

  const [mode, setMode] = useState<Mode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [parentDir, setParentDir] = useState('');
  const [folder, setFolder] = useState<PickedFolder | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [trackGit, setTrackGit] = useState(true);
  /** Prefilled from a cloned repo's description or the detected stack; never asked for. */
  const [details, setDetails] = useState({ description: '', stack: '' });

  const defaultParent = defaults.data?.defaultParent ?? '';
  useEffect(() => {
    if (!parentDir && defaultParent) setParentDir(defaultParent);
  }, [defaultParent, parentDir]);

  const gitState: GitTrackState = gitTrackState(report, mode === 'new' ? false : folder?.probe?.isGitRepo);
  const gitOffered = gitState === 'available' || gitState === 'pending';

  function pickMode(m: Mode | null) {
    setMode(m);
    setError(null);
    setFolder(null);
  }

  async function chooseFolder() {
    setError(null);
    const picked = await openFolderPicker();
    if (!picked) {
      const failure = pickerError();
      if (failure) setError(failure);
      return;
    }
    await detect(picked.normalize('NFC'));
  }

  /** Probe a folder; one that already has a brain is registered and opened straight away. */
  async function detect(path: string, prefill?: Partial<BareFolder>) {
    setDetecting(true);
    try {
      const probe = await probeFolder(path);
      if (probe.hasContext) {
        try {
          await register.mutateAsync({ name: probe.name, path: probe.path ?? path });
        } catch (regErr) {
          const msg = regErr instanceof Error ? regErr.message : String(regErr);
          if (!/already registered/i.test(msg)) throw regErr;
        }
        onOpenExisting(probe.name);
        return;
      }
      setFolder({ path: probe.path ?? path, probe });
      setName(prefill?.name ?? probe.name);
      setDetails((d) => ({
        ...d,
        description: d.description || prefill?.description || '',
        stack: d.stack || prefill?.stack || probe.stack || '',
      }));
    } catch (err) {
      if (err instanceof RequestError && err.code === 'symlink_refused') setError(t('onboarding.project.symlinkRefused'));
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDetecting(false);
    }
  }

  function handleBareFolder(bare: BareFolder) {
    setMode('existing');
    void detect(bare.path, bare);
  }

  async function submit() {
    setError(null);
    const payload: ScaffoldPayload = mode === 'new'
      ? { mode: 'new', name: name.trim().normalize('NFC'), parentDir: parentDir.trim().normalize('NFC') }
      : { mode: 'existing', name: name.trim().normalize('NFC'), projectPath: folder?.path ?? '' };
    payload.description = details.description.trim() || undefined;
    payload.stack = details.stack.trim() || undefined;
    payload.gitInit = gitOffered && trackGit;
    try {
      const res = await scaffold.mutateAsync(payload);
      onCreated({ name: res.vault.name, path: res.vault.path, cli: res.cli });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // ─── Render pieces ──────────────────────────────────────────────────────────

  function gitRow() {
    if (gitState === 'already-repo') return <p className="ob-hint">{t('onboarding.project.git.alreadyRepo')}</p>;
    const disabled = gitState === 'need-install';
    return (
      <label className={`ob-check${disabled ? ' ob-check--disabled' : ''}`}>
        <input
          type="checkbox"
          checked={!disabled && trackGit}
          disabled={disabled}
          onChange={(e) => setTrackGit(e.target.checked)}
        />
        <span>
          <span className="ob-check-label">{t('onboarding.project.git.track')}</span>
          {gitState === 'pending' && <span className="ob-hint">{t('onboarding.project.git.pending')}</span>}
          {disabled && <span className="ob-hint">{t('onboarding.project.git.needInstall')}</span>}
        </span>
      </label>
    );
  }

  function choices() {
    const cards: { mode: Mode; title: string; desc: string }[] = [
      { mode: 'new', title: t('onboarding.project.create.title'), desc: t('onboarding.project.create.desc') },
      { mode: 'existing', title: t('onboarding.project.open.title'), desc: t('onboarding.project.open.desc') },
      { mode: 'github', title: t('onboarding.project.clone.title'), desc: t('onboarding.project.clone.desc') },
    ];
    return (
      <>
        <h2 className="ob-title">{t('onboarding.project.title')}</h2>
        <p className="ob-subtitle">{t('onboarding.project.subtitle')}</p>
        <div className="ob-choices">
          {cards.map((c) => (
            <button key={c.mode} type="button" className="ob-choice" onClick={() => pickMode(c.mode)}>
              <span className="ob-choice-title">
                {c.mode === 'github' && <GitHubMark size={16} />}
                {c.title}
              </span>
              <span className="ob-hint">{c.desc}</span>
            </button>
          ))}
        </div>
      </>
    );
  }

  function newProject() {
    const target = name.trim() && parentDir.trim() ? `${parentDir.trim().replace(/\/+$/, '')}/${name.trim()}` : '';
    const parentMissing = defaults.data?.defaultParentExists === false && parentDir.trim() === defaultParent;
    return (
      <>
        <h2 className="ob-title ob-title--sm">{t('onboarding.project.create.title')}</h2>
        <label className="ob-field">
          <span className="ob-field-label">{t('onboarding.project.name')}</span>
          <input
            className="ob-input"
            type="text"
            value={name}
            placeholder={t('onboarding.project.namePlaceholder')}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && name.trim() && parentDir.trim()) void submit(); }}
            autoFocus
          />
        </label>
        <div className="ob-field">
          <span className="ob-field-label">{t('onboarding.project.location')}</span>
          <div className="ob-inline">
            <input
              className="ob-input"
              type="text"
              value={parentDir}
              placeholder={defaultParent}
              onChange={(e) => setParentDir(e.target.value)}
              aria-label={t('onboarding.project.location')}
            />
            <button
              type="button"
              className="ob-btn ob-btn--secondary"
              onClick={async () => {
                const picked = await openFolderPicker();
                if (picked) setParentDir(picked.normalize('NFC'));
                else if (pickerError()) setError(pickerError());
              }}
            >
              {t('onboarding.project.browse')}
            </button>
          </div>
          {target && <span className="ob-hint ob-path">{t('onboarding.project.preview').replace('{path}', target)}</span>}
          {parentMissing && <span className="ob-hint">{t('onboarding.project.parentWillBeCreated')}</span>}
        </div>
        {gitRow()}
      </>
    );
  }

  function existingFolder() {
    if (!folder) {
      return (
        <>
          <h2 className="ob-title ob-title--sm">{t('onboarding.project.open.title')}</h2>
          <p className="ob-hint">{t('onboarding.project.open.desc')}</p>
          <div className="ob-inline">
            <input className="ob-input" type="text" readOnly value="" placeholder={t('onboarding.project.noFolder')} />
            <button type="button" className="ob-btn ob-btn--secondary" onClick={() => void chooseFolder()} disabled={detecting}>
              {t('onboarding.project.chooseFolder')}
            </button>
          </div>
        </>
      );
    }
    const docs = folder.probe?.docs?.count ?? 0;
    return (
      <>
        <h2 className="ob-title ob-title--sm">{folder.probe?.name ?? name}</h2>
        <p className="ob-hint ob-path">{folder.path}</p>
        {docs > 0 && (
          <p className="ob-found">
            {docs === 1
              ? t('onboarding.project.docsFoundOne')
              : t('onboarding.project.docsFound').replace('{n}', String(docs))}
          </p>
        )}
        <label className="ob-field">
          <span className="ob-field-label">{t('onboarding.project.name')}</span>
          <input className="ob-input" type="text" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        {gitRow()}
        <button type="button" className="ob-link" onClick={() => { setFolder(null); void chooseFolder(); }}>
          {t('onboarding.project.changeFolder')}
        </button>
      </>
    );
  }

  if (mode === 'github') {
    return (
      <CloneFlow
        defaultParent={defaultParent}
        onBack={() => setMode(null)}
        onExistingProject={onOpenExisting}
        onBareFolder={handleBareFolder}
      />
    );
  }

  const canSubmit = mode === 'new'
    ? !!name.trim() && !!parentDir.trim()
    : !!folder && !!name.trim();

  return (
    <div className="ob-panel-body">
      {mode === null ? choices() : mode === 'new' ? newProject() : existingFolder()}
      {error && <p className="ob-error" role="alert">{error}</p>}
      {mode !== null && (
        <div className="ob-actions">
          <button type="button" className="ob-btn ob-btn--secondary" onClick={() => pickMode(null)} disabled={scaffold.isPending}>
            {t('onboarding.back')}
          </button>
          {(mode === 'new' || folder) && (
            <button
              type="button"
              className="ob-btn ob-btn--primary"
              onClick={() => void submit()}
              disabled={!canSubmit || scaffold.isPending}
            >
              {scaffold.isPending
                ? t('onboarding.project.working')
                : mode === 'new' ? t('onboarding.project.create') : t('onboarding.project.setUp')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
