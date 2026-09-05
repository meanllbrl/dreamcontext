import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useI18n } from '../../context/I18nContext';
import { useApi, useVault } from '../../context/VaultContext';
import { useAgentCapabilities } from '../../hooks/useAgentCapabilities';
import { claudeAuthRow, requestClaudeSignIn } from '../../lib/claudeAuth';
import type { Capabilities } from '../sleepy/agentSession';
import './SystemDependencies.css';

/**
 * The dependency doctor (Settings → This machine). One row per piece of external
 * software this project shells out to, with a live installed/missing check
 * (`GET /api/agent/capabilities`, polled every 30s) and a fix: one-click install
 * where the environment allows it (desktop + a viable installer), a copyable
 * command otherwise.
 *
 * It is keyed on the DEPENDENCY, not the feature. Listing it by feature made this
 * panel a fourth copy of the settings menu — the same four names the nav, the
 * section titles and the sidebar were already showing — while the actual question
 * ("is git here?") was answered three times over. Each row now says which features
 * need it, and the features themselves carry a `FeatureDepsNotice` where the user
 * actually meets them.
 */

type DepKey = 'git' | 'claude' | 'pty';
/**
 * What the server's installer can be asked to do. `claude-path` is not a package —
 * it writes the `export PATH="$HOME/.local/bin:$PATH"` line the CLI's own install
 * ends with, which is what makes a shell (and the user's own terminal) able to find
 * an already-installed `claude`.
 */
type InstallTarget = DepKey | 'claude-path';

interface DepMeta {
  key: DepKey;
  nameKey: string;
  present: (c: Capabilities) => boolean;
  /** Copyable fallback command for this machine. */
  manual: (c: Capabilities) => string;
  /** One-click installable in THIS environment (desktop + viable installer)? */
  installable: (c: Capabilities) => boolean;
}

const DEPS: Record<DepKey, DepMeta> = {
  git: {
    key: 'git',
    nameKey: 'system.dep.git',
    present: (c) => c.git,
    manual: (c) => (c.platform === 'darwin' ? 'xcode-select --install' : 'sudo apt install git'),
    installable: (c) => c.desktop && c.platform === 'darwin',
  },
  claude: {
    key: 'claude',
    nameKey: 'system.dep.claude',
    present: (c) => c.claudeCli,
    manual: () => 'npm install -g @anthropic-ai/claude-code',
    installable: (c) => c.desktop && c.npm,
  },
  pty: {
    key: 'pty',
    nameKey: 'system.dep.pty',
    present: (c) => c.nodePty,
    manual: () => 'npm install node-pty',
    installable: (c) => c.desktop && c.npm,
  },
};

interface FeatureMeta {
  key: string;
  titleKey: string;
  descKey: string;
  deps: DepKey[];
  desktopOnly?: boolean;
}

const FEATURES: FeatureMeta[] = [
  { key: 'cloudSync', titleKey: 'system.feature.cloudSync', descKey: 'system.feature.cloudSync.desc', deps: ['git'] },
  { key: 'cloudTasks', titleKey: 'system.feature.cloudTasks', descKey: 'system.feature.cloudTasks.desc', deps: [] },
  { key: 'sleepAgent', titleKey: 'system.feature.sleepAgent', descKey: 'system.feature.sleepAgent.desc', deps: ['claude'], desktopOnly: true },
  { key: 'agentTerminal', titleKey: 'system.feature.agentTerminal', descKey: 'system.feature.agentTerminal.desc', deps: ['claude', 'pty'], desktopOnly: true },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One-click install of a system dependency via the server's background installer
 * (`POST /api/agent/install` + status poll — the same machinery the agent Setup
 * panel uses). On completion the capabilities query is invalidated so every
 * gated surface (this doctor, OriginSetup, the sleep tracker) unlocks together.
 */
export function useSystemInstall() {
  const queryClient = useQueryClient();
  const api = useApi();
  const [running, setRunning] = useState<InstallTarget | null>(null);
  const [error, setError] = useState<string | null>(null);

  const install = async (target: InstallTarget) => {
    if (running) return;
    setRunning(target);
    setError(null);
    try {
      const { runId } = await api.post<{ ok: boolean; runId: string }>('/agent/install', { target });
      for (;;) {
        await sleep(2000);
        const s = await api.get<{ state: string; output: string }>(`/agent/install/status?id=${encodeURIComponent(runId)}`);
        if (s.state === 'done') break;
        if (s.state === 'error') { setError(s.output.split('\n').slice(-4).join('\n')); break; }
        if (s.state === 'unknown') { setError('The install run expired before it finished.'); break; }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start the install.');
    } finally {
      setRunning(null);
      queryClient.invalidateQueries({ queryKey: ['agent-capabilities'] });
    }
  };

  return { install, running, error };
}

function DepRow({ dep, caps }: { dep: DepMeta; caps: Capabilities }) {
  const { t } = useI18n();
  const { install, running, error } = useSystemInstall();
  const present = dep.present(caps);
  // `claude` on disk but invisible to the shell: the install's `export PATH` line
  // never reached the user's rc. In-app surfaces still work (every spawn injects the
  // real directory), but the user's own terminal can't run `claude` — so this is a
  // warning with a one-click fix, not a blocker and not a clean "Installed".
  const pathBroken = dep.key === 'claude' && present && caps.claudePathBroken === true;

  return (
    <div className="sysdep-row">
      <span className={`sysdep-dot${pathBroken ? ' sysdep-dot--warn' : present ? ' sysdep-dot--ok' : ''}`} aria-hidden="true" />
      <span className="sysdep-name">{t(dep.nameKey)}</span>
      <span className={`sysdep-status${present && !pathBroken ? ' sysdep-status--ok' : ' sysdep-status--missing'}`}>
        {pathBroken ? t('system.dep.notOnPath') : present ? t('system.dep.installed') : t('system.dep.missing')}
      </span>
      {pathBroken && (
        <button
          className="btn btn--primary btn--sm"
          onClick={() => install('claude-path')}
          disabled={running !== null}
        >
          {running === 'claude-path' ? t('system.dep.fixingPath') : t('system.dep.fixPath')}
        </button>
      )}
      {!present && (
        dep.installable(caps) ? (
          <button
            className="btn btn--primary btn--sm"
            onClick={() => install(dep.key)}
            disabled={running !== null}
          >
            {running === dep.key ? t('system.dep.installing') : t('system.dep.install')}
          </button>
        ) : (
          <span className="sysdep-manual">
            {t('system.dep.manualHint')} <code>{dep.manual(caps)}</code>
          </span>
        )
      )}
      {pathBroken && <p className="sysdep-note">{t('system.dep.notOnPath.desc')}</p>}
      {error && running === null && <p className="sysdep-error">{t('system.dep.installFailed')}: {error}</p>}
    </div>
  );
}

/**
 * Claude Code's SIGN-IN state — the half of "is this CLI usable?" that a presence check
 * can't see. `claude` on disk with no credentials answers every headless turn with
 * `authentication_failed`, so the agent, Chat and sleep runs all die at their first turn
 * while this panel reported a clean green "Installed".
 *
 * It is reported next to the features rather than folded into their ready/blocked badge:
 * the badge means "the software is here", and an exotic-but-working auth setup (Bedrock,
 * `apiKeyHelper`) probes as `null` — flipping those machines to "Blocked" would be a false
 * alarm about something that works. See `claudeAuthRow` for that asymmetry.
 */
function ClaudeAccountRow({ caps }: { caps: Capabilities }) {
  const { t } = useI18n();
  const { bus } = useVault();
  const row = claudeAuthRow(caps.claudeAuth);
  if (!row) return null;
  // The in-app sign-in opens a terminal pane, which needs the embedded terminal. Without
  // it the honest offer is the command to paste, not a button that opens nothing.
  const canSignInInApp = row.offerSignIn && caps.embeddedTerminal;

  return (
    <div className="sysdep-row">
      <span
        className={`sysdep-dot${row.tone === 'ok' ? ' sysdep-dot--ok' : row.tone === 'warn' ? ' sysdep-dot--warn' : ''}`}
        aria-hidden="true"
      />
      <span className="sysdep-name">{t('system.auth.title')}</span>
      <span className={`sysdep-status${row.tone === 'ok' ? ' sysdep-status--ok' : row.tone === 'warn' ? ' sysdep-status--missing' : ''}`}>
        {t(row.statusKey)}
      </span>
      {row.identity && <span className="sysdep-manual">{row.identity}</span>}
      {canSignInInApp && (
        <button className="btn btn--primary btn--sm" onClick={() => requestClaudeSignIn(bus)}>
          {t('system.auth.signIn')}
        </button>
      )}
      {row.offerSignIn && !canSignInInApp && (
        <span className="sysdep-manual">
          {t('system.dep.manualHint')} <code>{caps.claudeAuth?.loginCommand}</code>
        </span>
      )}
      {row.offerSignIn && <p className="sysdep-note">{t('system.auth.signedOut.desc')}</p>}
    </div>
  );
}

/** Which features need this dependency (desktop-only ones only count on desktop). */
function featuresNeeding(dep: DepKey, caps: Capabilities): FeatureMeta[] {
  return FEATURES.filter((f) => f.deps.includes(dep) && (!f.desktopOnly || caps.desktop));
}

/**
 * The missing-prerequisite banner, rendered INSIDE the section whose feature is
 * blocked — "Cloud sync needs git, which isn't installed" sitting above the cloud
 * sync controls, rather than in a separate list the user has to think to visit.
 * Renders nothing when the feature is ready, so a healthy machine sees no noise.
 */
export function FeatureDepsNotice({ feature, onOpenMachine }: { feature: string; onOpenMachine?: () => void }) {
  const { t } = useI18n();
  const { data: caps } = useAgentCapabilities();
  const meta = FEATURES.find((f) => f.key === feature);
  if (!caps || !meta) return null;
  if (meta.desktopOnly && !caps.desktop) return null;
  const missing = meta.deps.filter((d) => !DEPS[d].present(caps));
  if (missing.length === 0) return null;

  return (
    <p className="sysdep-notice">
      {t('system.notice.blocked')
        .replace('{feature}', t(meta.titleKey))
        .replace('{deps}', missing.map((d) => t(DEPS[d].nameKey)).join(', '))}
      {onOpenMachine && (
        <button type="button" className="sysdep-notice-link" onClick={onOpenMachine}>
          {t('system.notice.open')}
        </button>
      )}
    </p>
  );
}

export function SystemDependencies() {
  const { t } = useI18n();
  const { data: caps } = useAgentCapabilities();

  if (!caps) return null;

  // claude/pty one-click installs run through npm — surface the blocker once.
  const npmNeeded = caps.desktop && !caps.npm && (!caps.claudeCli || !caps.nodePty);
  // Only list software something on this machine can actually use.
  const depKeys = (Object.keys(DEPS) as DepKey[]).filter((d) => featuresNeeding(d, caps).length > 0);

  return (
    <div className="sysdep">
      {npmNeeded && <p className="sysdep-npm-warn">{t('system.dep.npmMissing')}</p>}
      <ClaudeAccountRow caps={caps} />
      {depKeys.map((d) => (
        <div key={d} className="sysdep-item">
          <DepRow dep={DEPS[d]} caps={caps} />
          <p className="sysdep-neededby">
            {t('system.dep.neededBy').replace(
              '{features}',
              featuresNeeding(d, caps).map((f) => t(f.titleKey)).join(' · '),
            )}
          </p>
        </div>
      ))}
    </div>
  );
}
