import { useEffect, useMemo, useRef, useState } from 'react';
import {
  probeFolder,
  useLauncherDefaults,
  useLauncherCatalog,
  useScaffoldProject,
  useRegisterVault,
  useGithubRepos,
  useCloneGithubRepo,
  useInvalidateLauncher,
  getCloneStatus,
  cancelClone,
  type CliInstallResult,
  type CloneResult,
  type FolderProbe,
  type ScaffoldPayload,
} from '../hooks/useLauncher';
import { useAuthStatus } from '../hooks/useBrainStatus';
import { GitHubLogin, GitHubMark } from '../components/brain/GitHubLogin';
import { openFolderPicker } from '../lib/desktop';
import './OnboardingWizard.css';

type Mode = 'new' | 'existing' | 'github';

interface Props {
  /** Close the wizard without opening anything. */
  onClose: () => void;
  /** Called with the vault name once a project is ready to open in its window. */
  onReady: (vaultName: string) => void;
}

/** The ordered question keys per mode. `path` only appears for existing folders. */
const STEPS_NEW = ['name', 'description', 'targetUser', 'stack', 'priority', 'platforms', 'packs', 'review'] as const;
const STEPS_EXISTING = ['path', 'description', 'targetUser', 'stack', 'priority', 'platforms', 'packs', 'review'] as const;
// An existing folder that is ALREADY a dreamcontext project skips the detail
// questions (name/desc/stack/… are already set) but still chooses platforms +
// skill packs, so connecting it can install/refresh integrations and packs.
const STEPS_EXISTING_HASCTX = ['path', 'platforms', 'packs', 'review'] as const;
// Clone-from-GitHub: pick a repo, pick where it lands, clone — then, when the
// clone is NOT already a dreamcontext project, fall through to the same detail
// questions as an existing folder (an already-ready clone skips them entirely:
// the server registers it and the wizard hands straight off).
const STEPS_GITHUB = ['repo', 'dest', 'description', 'targetUser', 'stack', 'priority', 'platforms', 'packs', 'review'] as const;

type StepKey =
  | (typeof STEPS_NEW)[number]
  | (typeof STEPS_EXISTING)[number]
  | (typeof STEPS_GITHUB)[number];

/** Steps that are not free-text questions (handled by their own render branch). */
type NonTextStep = 'review' | 'path' | 'platforms' | 'packs' | 'repo' | 'dest';

interface QuestionMeta {
  label: string;
  hint: string;
  optional?: boolean;
}

const QUESTIONS: Record<Exclude<StepKey, NonTextStep>, QuestionMeta> = {
  name: { label: 'What is this project called?', hint: 'Used as the folder name and the vault name.' },
  description: { label: 'One line — what is it?', hint: 'A short description. Optional.', optional: true },
  targetUser: { label: 'Who is it for?', hint: 'The target user. Optional.', optional: true },
  stack: { label: 'Tech stack?', hint: 'Comma-separated. Auto-detected for existing folders. Optional.', optional: true },
  priority: { label: 'Current focus?', hint: 'What you are working on right now. Optional.', optional: true },
};

/**
 * Quiz-style onboarding: create a brand-new project or initialize an existing
 * folder, register it as a vault, and hand off to Claude for rich enrichment.
 * Deterministic and LLM-free — the server runs `init` + `setup` from the answers.
 */
export function OnboardingWizard({ onClose, onReady }: Props) {
  const defaults = useLauncherDefaults();
  const catalog = useLauncherCatalog();
  const scaffold = useScaffoldProject();
  const register = useRegisterVault();
  const cloneRepo = useCloneGithubRepo();
  const { data: authStatus, isLoading: authLoading } = useAuthStatus();

  const [mode, setMode] = useState<Mode | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [readyVault, setReadyVault] = useState<{ name: string; path: string } | null>(null);
  const [cliResult, setCliResult] = useState<CliInstallResult | null>(null);
  const [copied, setCopied] = useState(false);

  // Answers
  const [name, setName] = useState('');
  const [parentDir, setParentDir] = useState('');
  const [projectPath, setProjectPath] = useState('');
  const [description, setDescription] = useState('');
  const [targetUser, setTargetUser] = useState('');
  const [stack, setStack] = useState('');
  const [priority, setPriority] = useState('');
  const [platforms, setPlatforms] = useState<string[]>(['claude']);
  const [packs, setPacks] = useState<string[]>([]);
  const [hasContext, setHasContext] = useState(false);

  // Clone-from-GitHub answers.
  const [repoQuery, setRepoQuery] = useState('');
  const [repoSearch, setRepoSearch] = useState(''); // debounced copy that drives the fetch
  const [selectedRepo, setSelectedRepo] = useState('');
  const [selectedRepoDesc, setSelectedRepoDesc] = useState('');
  const [cloneParent, setCloneParent] = useState('');
  /** A background clone in flight: the job id + git's live progress tail. */
  const [cloneRun, setCloneRun] = useState<{ id: string; progress: string } | null>(null);
  /** The clone destination already exists — offer to open it instead. */
  const [destConflict, setDestConflict] = useState<(FolderProbe & { path: string }) | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const invalidateLauncher = useInvalidateLauncher();
  /** Flipped on unmount (and cancel) so a late poll never touches dead state. */
  const pollStopRef = useRef(false);
  useEffect(() => () => { pollStopRef.current = true; }, []);
  /**
   * Synchronous re-entrancy latch for the clone flow. `doClone` first `await`s a
   * folder probe BEFORE the `cloneRepo` mutation starts, so `cloneRepo.isPending`
   * stays false across that window — a rapid double-click would otherwise start
   * two background clones into the same destination. A ref flips immediately
   * (unlike state) so the second invocation bails on the same tick; `probing`
   * mirrors it for the button's disabled/label.
   */
  const cloneBusyRef = useRef(false);
  const [probing, setProbing] = useState(false);

  // Debounce the repo search so each keystroke doesn't fire a GitHub round-trip.
  useEffect(() => {
    const id = setTimeout(() => setRepoSearch(repoQuery.trim()), 350);
    return () => clearTimeout(id);
  }, [repoQuery]);

  const githubConnected = authStatus?.connected === true && !authStatus?.needsReconnect;
  const repos = useGithubRepos(repoSearch, mode === 'github' && githubConnected);

  function toggleIn(list: string[], setList: (v: string[]) => void, value: string) {
    setList(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  }

  // Prefill the parent dir with the server-provided ~/projects once known.
  useEffect(() => {
    if (mode === 'new' && !parentDir && defaults.data?.defaultParent) {
      setParentDir(defaults.data.defaultParent);
    }
    if (mode === 'github' && !cloneParent && defaults.data?.defaultParent) {
      setCloneParent(defaults.data.defaultParent);
    }
  }, [mode, parentDir, cloneParent, defaults.data]);

  const steps: readonly StepKey[] =
    mode === 'github'
      ? STEPS_GITHUB
      : mode === 'existing'
        ? (hasContext ? STEPS_EXISTING_HASCTX : STEPS_EXISTING)
        : STEPS_NEW;
  const step: StepKey = steps[stepIndex];

  // Focus the field when a text-input step appears.
  useEffect(() => {
    inputRef.current?.focus();
  }, [step, mode]);

  function pickMode(m: Mode) {
    setMode(m);
    setStepIndex(0);
    setError(null);
  }

  async function browseFolder(target: 'parent' | 'project' | 'cloneParent') {
    setError(null);
    const picked = await openFolderPicker();
    if (!picked) return;
    if (target === 'parent') {
      setParentDir(picked);
      return;
    }
    if (target === 'cloneParent') {
      setCloneParent(picked);
      return;
    }
    // Existing-folder pick: probe it. A folder that ALREADY has a _dream_context/
    // directory is a real project — there is nothing to set up, so we skip the
    // quiz/setup entirely: just register it as a vault and open it. Only a folder
    // WITHOUT _dream_context routes into the full setup flow.
    setProjectPath(picked);
    try {
      const probe = await probeFolder(picked);
      setName(probe.name);
      if (!stack && probe.stack) setStack(probe.stack);
      setHasContext(probe.hasContext);
      if (probe.hasContext) {
        // Register, then hand straight off to open the vault window. No init,
        // no setup, no quiz. addVault throws if this name/path is ALREADY
        // registered — that's not a failure here: the project simply already
        // exists in the launcher, so we still open it. Any other error
        // (e.g. path vanished) surfaces to the user.
        try {
          await register.mutateAsync({ name: probe.name, path: picked });
        } catch (regErr) {
          const msg = regErr instanceof Error ? regErr.message : String(regErr);
          if (!/already registered/i.test(msg)) throw regErr;
        }
        onReady(probe.name);
        return;
      }
      // No context → full quiz: step 1 is 'description'.
      setStepIndex(1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const canAdvance = useMemo(() => {
    if (step === 'name') return name.trim().length > 0 && parentDir.trim().length > 0;
    if (step === 'path') return projectPath.trim().length > 0;
    if (step === 'repo') return githubConnected && selectedRepo.length > 0;
    return true; // optional steps + review
  }, [step, name, parentDir, projectPath, githubConnected, selectedRepo]);

  function next() {
    setError(null);
    if (stepIndex < steps.length - 1) setStepIndex((i) => i + 1);
  }
  function back() {
    setError(null);
    // Leaving the dest step dismisses a pending "folder exists" offer — it is
    // re-derived on the next Clone click, so stale state never lingers.
    setDestConflict(null);
    if (stepIndex > 0) setStepIndex((i) => i - 1);
    else setMode(null);
  }

  /**
   * Closing the wizard mid-clone aborts the clone — closing means "stop", and a
   * background job that later materializes a project out of nowhere is worse UX
   * than an honest cancel. The overlay backdrop is inert while cloning so an
   * accidental click can't kill a multi-minute download; only the explicit ✕ does.
   */
  function handleClose() {
    if (cloneRun) void cancelCloneRun();
    onClose();
  }

  /**
   * A clone finished. An already-ready clone (has `_dream_context/`) was
   * registered server-side → refresh the launcher and hand straight off; a bare
   * codebase falls through to the detail questions (GitHub description + detected
   * stack prefilled), and the final scaffold submit initializes it in place like
   * any existing folder.
   */
  async function handleCloneResult(result: CloneResult) {
    if (result.hasContext) {
      invalidateLauncher();
      onReady(result.vaultName ?? result.name);
      return;
    }
    setProjectPath(result.path);
    setName(result.name);
    if (!description.trim() && selectedRepoDesc) setDescription(selectedRepoDesc);
    try {
      const probe = await probeFolder(result.path);
      if (probe.stack) setStack(probe.stack);
    } catch {
      /* stack prefill is best-effort */
    }
    setCloneRun(null);
    setStepIndex(steps.indexOf('description'));
  }

  /** Poll the background clone job until it settles; streams git progress into the UI. */
  async function pollClone(id: string) {
    if (pollStopRef.current) return;
    try {
      const status = await getCloneStatus(id);
      if (pollStopRef.current) return;
      if (status.state === 'running') {
        setCloneRun({ id, progress: status.progress });
        setTimeout(() => void pollClone(id), 700);
        return;
      }
      if (status.state === 'done' && status.result) {
        await handleCloneResult(status.result);
        return;
      }
      setCloneRun(null);
      // A user-initiated cancel is not an error worth shouting about.
      if (status.error && !/canceled/i.test(status.error)) setError(status.error);
      else if (!status.error) setError('The clone did not finish (the job expired). Try again.');
    } catch (err) {
      setCloneRun(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Clone the picked repo under the chosen parent — but FIRST probe the exact
   * destination: a folder that already exists there gets an "open it instead"
   * offer rather than a dead-end clone error.
   */
  async function doClone() {
    if (cloneBusyRef.current || cloneRepo.isPending) return; // guard double-submit
    cloneBusyRef.current = true;
    setProbing(true);
    setError(null);
    setDestConflict(null);
    try {
      const parent = cloneParent.trim().replace(/\/+$/, '');
      const folder = selectedRepo.split('/').pop() ?? '';
      if (parent && folder) {
        try {
          const probe = await probeFolder(`${parent}/${folder}`);
          setDestConflict({ ...probe, path: `${parent}/${folder}` });
          return;
        } catch (probeErr) {
          // detect() 400s with "Path does not exist" ONLY when the folder is
          // missing — that (and only that) means the destination is free, so
          // fall through to clone. Any OTHER failure (network drop, server
          // error) must NOT be misread as "free": surface it and abort rather
          // than kicking off a clone on the back of a failed probe.
          const msg = probeErr instanceof Error ? probeErr.message : String(probeErr);
          if (!/does not exist/i.test(msg)) {
            setError(msg);
            return;
          }
        }
      }
      const res = await cloneRepo.mutateAsync({ url: selectedRepo, parentDir: cloneParent.trim() });
      setCloneRun({ id: res.cloneId, progress: '' });
      void pollClone(res.cloneId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      cloneBusyRef.current = false;
      setProbing(false);
    }
  }

  /** Abort the running clone. The poll loop observes the terminal state and resets. */
  async function cancelCloneRun() {
    if (!cloneRun) return;
    try {
      await cancelClone(cloneRun.id);
    } catch {
      /* idempotent server-side; the poll settles either way */
    }
  }

  /**
   * The clone destination already exists — the user chose to use that folder
   * instead. Already a dreamcontext project → register + open (mirrors the
   * Browse probe path); a bare folder flows into the detail questions.
   */
  async function openExistingDest() {
    if (!destConflict || register.isPending) return; // guard double-submit while registering
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
      onReady(destConflict.name);
      return;
    }
    setProjectPath(destConflict.path);
    setName(destConflict.name);
    if (!stack.trim() && destConflict.stack) setStack(destConflict.stack);
    if (!description.trim() && selectedRepoDesc) setDescription(selectedRepoDesc);
    setDestConflict(null);
    setStepIndex(steps.indexOf('description'));
  }

  async function submit() {
    setError(null);
    const payload: ScaffoldPayload =
      mode === 'new'
        ? { mode: 'new', name: name.trim(), parentDir: parentDir.trim() }
        : { mode: 'existing', name: name.trim(), projectPath: projectPath.trim() };
    payload.description = description.trim() || undefined;
    payload.targetUser = targetUser.trim() || undefined;
    payload.stack = stack.trim() || undefined;
    payload.priority = priority.trim() || undefined;
    payload.platforms = platforms.length > 0 ? platforms : undefined;
    payload.packs = packs.length > 0 ? packs : undefined;
    try {
      const res = await scaffold.mutateAsync(payload);
      setReadyVault(res.vault);
      setCliResult(res.cli ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const handoffPrompt =
    'Enrich my dreamcontext: scan the codebase and fill soul, memory, and tech_stack with real ' +
    'detail, then propose initial feature PRDs and a first task. No placeholders.';

  async function copyHandoff() {
    try {
      await navigator.clipboard.writeText(handoffPrompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Could not copy to clipboard.');
    }
  }

  // ─── Render helpers ──────────────────────────────────────────────────────────

  function field(value: string, setValue: (v: string) => void, placeholder: string) {
    return (
      <input
        ref={inputRef}
        type="text"
        className="wiz-input"
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && canAdvance) next();
        }}
      />
    );
  }

  function body() {
    // Success screen — project is ready; offer to open + hand off to Claude.
    if (readyVault) {
      return (
        <div className="wiz-success">
          <div className="wiz-success-check" aria-hidden>✓</div>
          <h2 className="wiz-q">“{readyVault.name}” is ready</h2>
          <p className="wiz-hint">{readyVault.path}</p>
          {cliResult?.status === 'installed' && (
            <p className="wiz-hint">Installed the dreamcontext CLI from npm so your hooks work.</p>
          )}
          {cliResult?.status === 'failed' && (
            <div className="wiz-error">
              {cliResult.message ?? 'Run: npm install -g dreamcontext'}
            </div>
          )}
          <div className="wiz-handoff">
            <div className="wiz-handoff-title">Next: enrich it in Claude Code</div>
            <p className="wiz-hint">
              The skeleton is in place. Open this project in Claude Code and paste the prompt below
              so the agent can scan your code and fill in real context.
            </p>
            <pre className="wiz-handoff-prompt">{handoffPrompt}</pre>
            <button type="button" className="wiz-btn" onClick={copyHandoff}>
              {copied ? 'Copied ✓' : 'Copy prompt'}
            </button>
          </div>
          <div className="wiz-actions">
            <button type="button" className="wiz-btn" onClick={onClose}>Close</button>
            <button
              type="button"
              className="wiz-btn wiz-btn-primary"
              onClick={() => onReady(readyVault.name)}
            >
              Open project →
            </button>
          </div>
        </div>
      );
    }

    // Step 0: choose new vs existing.
    if (mode === null) {
      return (
        <div>
          <h2 className="wiz-q">Add a project</h2>
          <p className="wiz-hint">Create something new, or set up a folder you already have.</p>
          <div className="wiz-choices">
            <button type="button" className="wiz-choice" onClick={() => pickMode('new')}>
              <span className="wiz-choice-title">Create new</span>
              <span className="wiz-hint">Make a new folder and initialize dreamcontext in it.</span>
            </button>
            <button type="button" className="wiz-choice" onClick={() => pickMode('existing')}>
              <span className="wiz-choice-title">Open existing</span>
              <span className="wiz-hint">Pick a folder on your Mac and set up dreamcontext there.</span>
            </button>
            <button type="button" className="wiz-choice" onClick={() => pickMode('github')}>
              <span className="wiz-choice-title">
                <GitHubMark size={14} /> Clone from GitHub
              </span>
              <span className="wiz-hint">Sign in, pick a repository, and clone it to your Mac — dreamcontext included.</span>
            </button>
          </div>
        </div>
      );
    }

    // GitHub repo picker step (clone mode).
    if (step === 'repo') {
      return (
        <div>
          <h2 className="wiz-q">Which repository?</h2>
          {authLoading ? (
            <p className="wiz-hint">Checking GitHub sign-in…</p>
          ) : !githubConnected ? (
            <div>
              <p className="wiz-hint">Connect your GitHub account to browse your repositories.</p>
              <GitHubLogin />
            </div>
          ) : (
            <div>
              <p className="wiz-hint">
                Your repositories, most recently pushed first. Type to filter, or paste an
                owner/repo to find any repository you can access.
              </p>
              <input
                ref={inputRef}
                type="search"
                className="wiz-input"
                placeholder="Search repositories… (or owner/repo)"
                value={repoQuery}
                onChange={(e) => setRepoQuery(e.target.value)}
                aria-label="Search repositories"
              />
              <div className="wiz-repo-list" role="listbox" aria-label="Repositories">
                {repos.isLoading && <p className="wiz-hint">Loading repositories…</p>}
                {repos.isError && (
                  <p className="wiz-hint">
                    {repos.error instanceof Error ? repos.error.message : 'Could not load repositories.'}
                  </p>
                )}
                {!repos.isLoading && !repos.isError && (repos.data?.repos.length ?? 0) === 0 && (
                  <p className="wiz-hint">No repositories match.</p>
                )}
                {(repos.data?.repos ?? []).map((r) => {
                  const on = selectedRepo === r.fullName;
                  return (
                    <button
                      key={r.fullName}
                      type="button"
                      role="option"
                      aria-selected={on}
                      className={`wiz-choice wiz-select wiz-repo${on ? ' wiz-select-on' : ''}`}
                      onClick={() => {
                        setSelectedRepo(on ? '' : r.fullName);
                        setSelectedRepoDesc(on ? '' : (r.description ?? ''));
                      }}
                    >
                      <span className="wiz-choice-title">
                        {r.fullName}
                        {r.private && <span className="wiz-badge">Private</span>}
                      </span>
                      {r.description && <span className="wiz-hint">{r.description}</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      );
    }

    // Clone destination step (clone mode).
    if (step === 'dest') {
      const repoFolder = selectedRepo.split('/').pop() ?? '';

      // A clone is running → live git progress takes over the step.
      if (cloneRun) {
        const tail = cloneRun.progress.split('\n').filter((l) => l.trim()).slice(-6).join('\n');
        return (
          <div>
            <h2 className="wiz-q">Cloning {selectedRepo}…</h2>
            <p className="wiz-hint">
              <span className="wiz-spinner" aria-hidden />
              Downloading into {cloneParent.replace(/\/+$/, '')}/{repoFolder}. You can cancel at any time.
            </p>
            <pre className="wiz-clone-progress" aria-live="polite">{tail || 'Contacting GitHub…'}</pre>
          </div>
        );
      }

      // The destination already exists → offer to use it rather than dead-end.
      if (destConflict) {
        return (
          <div>
            <h2 className="wiz-q">That folder already exists</h2>
            <p className="wiz-hint">{destConflict.path}</p>
            <p className="wiz-hint">
              {destConflict.hasContext
                ? 'It is already a dreamcontext project — you can open it as-is.'
                : 'You can set up dreamcontext in the existing folder, or choose another location for the clone.'}
            </p>
            <div className="wiz-choices">
              <button type="button" className="wiz-choice" onClick={openExistingDest} disabled={register.isPending}>
                <span className="wiz-choice-title">
                  {destConflict.hasContext ? 'Open the existing project' : 'Use the existing folder'}
                </span>
                <span className="wiz-hint">
                  {destConflict.hasContext
                    ? 'Register it in the launcher and open it now.'
                    : 'Skip the clone and continue setup with what is already on disk.'}
                </span>
              </button>
              <button type="button" className="wiz-choice" onClick={() => setDestConflict(null)}>
                <span className="wiz-choice-title">Choose another location</span>
                <span className="wiz-hint">Pick a different parent folder for the clone.</span>
              </button>
            </div>
          </div>
        );
      }

      return (
        <div>
          <h2 className="wiz-q">Where should it live?</h2>
          <p className="wiz-hint">The repository is cloned into a new folder under this directory.</p>
          <div className="wiz-row">
            <input
              className="wiz-input"
              type="text"
              value={cloneParent}
              placeholder={defaults.data?.defaultParent ?? '~/projects'}
              onChange={(e) => setCloneParent(e.target.value)}
            />
            <button type="button" className="wiz-btn" onClick={() => browseFolder('cloneParent')}>Browse…</button>
          </div>
          {cloneParent.trim() && repoFolder && (
            <p className="wiz-hint wiz-preview">Clones {selectedRepo} into: {cloneParent.replace(/\/+$/, '')}/{repoFolder}</p>
          )}
        </div>
      );
    }

    // Existing-folder picker step.
    if (step === 'path') {
      return (
        <div>
          <h2 className="wiz-q">Which folder?</h2>
          <p className="wiz-hint">Choose the project folder. If it's already a dreamcontext project, it opens straight away.</p>
          <div className="wiz-row">
            <input className="wiz-input" type="text" value={projectPath} readOnly placeholder="No folder chosen" />
            <button type="button" className="wiz-btn" onClick={() => browseFolder('project')}>
              {scaffold.isPending ? 'Working…' : 'Browse…'}
            </button>
          </div>
        </div>
      );
    }

    // Name + parent (new only).
    if (step === 'name') {
      return (
        <div>
          <h2 className="wiz-q">{QUESTIONS.name.label}</h2>
          <p className="wiz-hint">{QUESTIONS.name.hint}</p>
          {field(name, setName, 'my-project')}
          <label className="wiz-sublabel">Where should it live?</label>
          <div className="wiz-row">
            <input
              className="wiz-input"
              type="text"
              value={parentDir}
              placeholder={defaults.data?.defaultParent ?? '~/projects'}
              onChange={(e) => setParentDir(e.target.value)}
            />
            <button type="button" className="wiz-btn" onClick={() => browseFolder('parent')}>Browse…</button>
          </div>
          {name.trim() && parentDir.trim() && (
            <p className="wiz-hint wiz-preview">Creates: {parentDir.replace(/\/+$/, '')}/{name.trim()}</p>
          )}
        </div>
      );
    }

    // Review step.
    if (step === 'review') {
      return (
        <div>
          <h2 className="wiz-q">Ready to set up</h2>
          <dl className="wiz-review">
            <dt>Name</dt><dd>{name.trim()}</dd>
            <dt>Location</dt>
            <dd>{mode === 'new' ? `${parentDir.replace(/\/+$/, '')}/${name.trim()}` : projectPath}</dd>
            {description.trim() && (<><dt>Description</dt><dd>{description.trim()}</dd></>)}
            {targetUser.trim() && (<><dt>For</dt><dd>{targetUser.trim()}</dd></>)}
            {stack.trim() && (<><dt>Stack</dt><dd>{stack.trim()}</dd></>)}
            {priority.trim() && (<><dt>Focus</dt><dd>{priority.trim()}</dd></>)}
            <dt>Platforms</dt>
            <dd>
              {(platforms.length > 0 ? platforms : ['claude'])
                .map((id) => catalog.data?.platforms.find((p) => p.id === id)?.label ?? id)
                .join(', ')}
            </dd>
            {packs.length > 0 && (<><dt>Skill packs</dt><dd>{packs.join(', ')}</dd></>)}
          </dl>
        </div>
      );
    }

    // Platform selection (multi-select; Claude recommended + pre-checked).
    if (step === 'platforms') {
      const options = catalog.data?.platforms ?? [];
      return (
        <div>
          <h2 className="wiz-q">Which agent platforms?</h2>
          <p className="wiz-hint">Where dreamcontext installs its skills, agents, and hooks. Pick one or more.</p>
          <div className="wiz-choices">
            {options.map((p) => {
              const on = platforms.includes(p.id);
              return (
                <button
                  key={p.id}
                  type="button"
                  className={`wiz-choice wiz-select${on ? ' wiz-select-on' : ''}`}
                  onClick={() => toggleIn(platforms, setPlatforms, p.id)}
                  aria-pressed={on}
                >
                  <span className="wiz-choice-title">
                    {p.label}
                    {p.recommended && <span className="wiz-badge">Recommended</span>}
                  </span>
                  <span className="wiz-hint">{p.description}</span>
                </button>
              );
            })}
          </div>
          {platforms.length === 0 && (
            <p className="wiz-hint wiz-preview">Nothing selected — defaults to Claude.</p>
          )}
        </div>
      );
    }

    // Optional skill-pack selection (opt-in; none selected by default).
    if (step === 'packs') {
      const options = catalog.data?.packs ?? [];
      return (
        <div>
          <h2 className="wiz-q">Add skill packs?</h2>
          <p className="wiz-hint">Optional curated skills for your agent. You can add more later. Skip if unsure.</p>
          {options.length === 0 ? (
            <p className="wiz-hint">No optional packs available.</p>
          ) : (
            <div className="wiz-choices">
              {options.map((p) => {
                const on = packs.includes(p.name);
                return (
                  <button
                    key={p.name}
                    type="button"
                    className={`wiz-choice wiz-select${on ? ' wiz-select-on' : ''}`}
                    onClick={() => toggleIn(packs, setPacks, p.name)}
                    aria-pressed={on}
                  >
                    <span className="wiz-choice-title">
                      <span className="wiz-check" aria-hidden>{on ? '☑' : '☐'}</span> {p.name}
                    </span>
                    <span className="wiz-hint">{p.description}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      );
    }

    // Generic optional question steps.
    const textStep = step as Exclude<StepKey, NonTextStep>;
    const meta = QUESTIONS[textStep];
    const setters: Record<string, [string, (v: string) => void, string]> = {
      description: [description, setDescription, 'A persistent brain for AI agents…'],
      targetUser: [targetUser, setTargetUser, 'Developers'],
      stack: [stack, setStack, 'TypeScript, React, Node…'],
      priority: [priority, setPriority, 'Initial setup'],
    };
    const [value, setValue, placeholder] = setters[step];
    return (
      <div>
        <h2 className="wiz-q">{meta.label}</h2>
        <p className="wiz-hint">{meta.hint}</p>
        {field(value, setValue, placeholder)}
      </div>
    );
  }

  const isLastStep = step === 'review';
  const showNav = mode !== null && step !== 'path' && !readyVault;

  return (
    <div
      className="wiz-overlay"
      role="dialog"
      aria-modal="true"
      // The Launcher page background is a window-drag handle; a modal (and its
      // click-to-dismiss scrim) must never start a window drag.
      data-no-drag
      onClick={cloneRun ? undefined : onClose}
    >
      <div className="wiz-modal" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="wiz-close" onClick={handleClose} aria-label="Close">×</button>

        <div className="wiz-body">{body()}</div>

        {error && <div className="wiz-error">{error}</div>}

        {showNav && (
          <div className="wiz-actions">
            <button
              type="button"
              className="wiz-btn"
              onClick={back}
              disabled={cloneRepo.isPending || !!cloneRun}
            >
              Back
            </button>
            {isLastStep ? (
              <button
                type="button"
                className="wiz-btn wiz-btn-primary"
                onClick={submit}
                disabled={scaffold.isPending || !name.trim()}
              >
                {scaffold.isPending ? 'Setting up…' : 'Set up project'}
              </button>
            ) : step === 'dest' && cloneRun ? (
              <button type="button" className="wiz-btn" onClick={cancelCloneRun}>
                Cancel clone
              </button>
            ) : step === 'dest' && !destConflict ? (
              <button
                type="button"
                className="wiz-btn wiz-btn-primary"
                onClick={doClone}
                disabled={probing || cloneRepo.isPending || !cloneParent.trim() || !selectedRepo}
              >
                {probing || cloneRepo.isPending ? 'Starting…' : 'Clone →'}
              </button>
            ) : step === 'dest' ? null : (
              <button
                type="button"
                className="wiz-btn wiz-btn-primary"
                onClick={next}
                disabled={!canAdvance}
              >
                Next
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
