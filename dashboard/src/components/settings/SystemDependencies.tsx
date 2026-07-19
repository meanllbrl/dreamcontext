import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useI18n } from '../../context/I18nContext';
import { api } from '../../api/client';
import { useAgentCapabilities } from '../../hooks/useAgentCapabilities';
import type { Capabilities } from '../sleepy/agentSession';
import './SystemDependencies.css';

/**
 * The per-feature dependency doctor (Settings → System). Every feature that
 * shells out to external software is listed with what it actually needs on THIS
 * machine, a live installed/missing check (`GET /api/agent/capabilities`, polled
 * every 30s), and a fix: one-click install where the environment allows it
 * (desktop + a viable installer), a copyable command otherwise. This is the
 * answer to "the feature just spins forever" — a missing prerequisite is named
 * and fixable BEFORE the feature is attempted.
 */

type DepKey = 'git' | 'claude' | 'pty';

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
  const [running, setRunning] = useState<DepKey | null>(null);
  const [error, setError] = useState<string | null>(null);

  const install = async (dep: DepKey) => {
    if (running) return;
    setRunning(dep);
    setError(null);
    const target = dep === 'claude' ? 'claude' : dep === 'pty' ? 'pty' : 'git';
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

  return (
    <div className="sysdep-row">
      <span className={`sysdep-dot${present ? ' sysdep-dot--ok' : ''}`} aria-hidden="true" />
      <span className="sysdep-name">{t(dep.nameKey)}</span>
      <span className={`sysdep-status${present ? ' sysdep-status--ok' : ' sysdep-status--missing'}`}>
        {present ? t('system.dep.installed') : t('system.dep.missing')}
      </span>
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
      {error && running === null && <p className="sysdep-error">{t('system.dep.installFailed')}: {error}</p>}
    </div>
  );
}

export function SystemDependencies() {
  const { t } = useI18n();
  const { data: caps } = useAgentCapabilities();

  if (!caps) return null;

  // claude/pty one-click installs run through npm — surface the blocker once.
  const npmNeeded = caps.desktop && !caps.npm && (!caps.claudeCli || !caps.nodePty);

  return (
    <div className="sysdep">
      {npmNeeded && <p className="sysdep-npm-warn">{t('system.dep.npmMissing')}</p>}
      {FEATURES.map((f) => {
        const missing = f.deps.filter((d) => !DEPS[d].present(caps));
        const ready = missing.length === 0;
        return (
          <div key={f.key} className="sysdep-feature">
            <div className="sysdep-feature-head">
              <span className="sysdep-feature-title">{t(f.titleKey)}</span>
              {f.desktopOnly && !caps.desktop ? (
                <span className="sysdep-badge">{t('system.feature.desktopOnly')}</span>
              ) : (
                <span className={`sysdep-badge${ready ? ' sysdep-badge--ok' : ' sysdep-badge--warn'}`}>
                  {ready ? t('system.feature.ready') : t('system.feature.blocked')}
                </span>
              )}
            </div>
            <p className="settings-field-hint">{t(f.descKey)}</p>
            {f.deps.length === 0
              ? <p className="sysdep-nodeps">{t('system.feature.noDeps')}</p>
              : f.deps.map((d) => <DepRow key={d} dep={DEPS[d]} caps={caps} />)}
          </div>
        );
      })}
    </div>
  );
}
