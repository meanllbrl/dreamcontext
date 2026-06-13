import { useEffect, useMemo, useRef, useState } from 'react';
import {
  probeFolder,
  useLauncherDefaults,
  useScaffoldProject,
  type CliInstallResult,
  type ScaffoldPayload,
} from '../hooks/useLauncher';
import { openFolderPicker } from '../lib/desktop';
import './OnboardingWizard.css';

type Mode = 'new' | 'existing';

interface Props {
  /** Close the wizard without opening anything. */
  onClose: () => void;
  /** Called with the vault name once a project is ready to open in its window. */
  onReady: (vaultName: string) => void;
}

/** The ordered question keys per mode. `path` only appears for existing folders. */
const STEPS_NEW = ['name', 'description', 'targetUser', 'stack', 'priority', 'review'] as const;
const STEPS_EXISTING = ['path', 'description', 'targetUser', 'stack', 'priority', 'review'] as const;

type StepKey = (typeof STEPS_NEW)[number] | (typeof STEPS_EXISTING)[number];

interface QuestionMeta {
  label: string;
  hint: string;
  optional?: boolean;
}

const QUESTIONS: Record<Exclude<StepKey, 'review' | 'path'>, QuestionMeta> = {
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
  const scaffold = useScaffoldProject();

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

  const inputRef = useRef<HTMLInputElement>(null);

  // Prefill the parent dir with the server-provided ~/projects once known.
  useEffect(() => {
    if (mode === 'new' && !parentDir && defaults.data?.defaultParent) {
      setParentDir(defaults.data.defaultParent);
    }
  }, [mode, parentDir, defaults.data]);

  const steps = mode === 'existing' ? STEPS_EXISTING : STEPS_NEW;
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

  async function browseFolder(target: 'parent' | 'project') {
    setError(null);
    const picked = await openFolderPicker();
    if (!picked) return;
    if (target === 'parent') {
      setParentDir(picked);
      return;
    }
    // Existing-folder pick: probe it. If it's already a vault, skip the quiz.
    setProjectPath(picked);
    try {
      const probe = await probeFolder(picked);
      if (!name) setName(probe.name);
      if (!stack && probe.stack) setStack(probe.stack);
      if (probe.hasContext) {
        // Already a dreamcontext project — scaffold is a no-op that just registers.
        const res = await scaffold.mutateAsync({ mode: 'existing', name: probe.name, projectPath: picked });
        onReady(res.vault.name);
        return;
      }
      setStepIndex(1); // advance to the first quiz question
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const canAdvance = useMemo(() => {
    if (step === 'name') return name.trim().length > 0 && parentDir.trim().length > 0;
    if (step === 'path') return projectPath.trim().length > 0;
    return true; // optional steps + review
  }, [step, name, parentDir, projectPath]);

  function next() {
    setError(null);
    if (stepIndex < steps.length - 1) setStepIndex((i) => i + 1);
  }
  function back() {
    setError(null);
    if (stepIndex > 0) setStepIndex((i) => i - 1);
    else setMode(null);
  }

  async function submit() {
    setError(null);
    const payload: ScaffoldPayload =
      mode === 'existing'
        ? { mode: 'existing', name: name.trim(), projectPath: projectPath.trim() }
        : { mode: 'new', name: name.trim(), parentDir: parentDir.trim() };
    payload.description = description.trim() || undefined;
    payload.targetUser = targetUser.trim() || undefined;
    payload.stack = stack.trim() || undefined;
    payload.priority = priority.trim() || undefined;
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
          </div>
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
          </dl>
        </div>
      );
    }

    // Generic optional question steps.
    const meta = QUESTIONS[step];
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
    <div className="wiz-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="wiz-modal" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="wiz-close" onClick={onClose} aria-label="Close">×</button>

        {body()}

        {error && <div className="wiz-error">{error}</div>}

        {showNav && (
          <div className="wiz-actions">
            <button type="button" className="wiz-btn" onClick={back}>Back</button>
            {isLastStep ? (
              <button
                type="button"
                className="wiz-btn wiz-btn-primary"
                onClick={submit}
                disabled={scaffold.isPending || !name.trim()}
              >
                {scaffold.isPending ? 'Setting up…' : 'Set up project'}
              </button>
            ) : (
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
