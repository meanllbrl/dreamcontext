import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useI18n } from '../../../context/I18nContext';
import { emitInstance, useApi, useVault } from '../../../context/VaultContext';
import type { AgentToolInfo, ClaudeAccountsResponse } from '../../../hooks/useAgentCapabilities';
import { fetchReadiness, READINESS_QUERY_KEY, useFixRuns } from '../../../hooks/useOnboarding';
import { useShellProjects } from '../../../hooks/useShellProjects';
import { chipSummary, setupProblems, type SetupProblem } from '../../../lib/setupStatus';
import { pollMs } from '../../../lib/windowActivity';
import './SetupStatusChip.css';

/** How old a read may be before a window focus (or a project switch) reads again. */
const FOCUS_STALE_MS = 5 * 60_000;
/** Only while the report says offline: a light re-read so "No internet" clears by itself. */
const OFFLINE_REREAD_MS = 15_000;

/**
 * The setup status chip, left of the sleep score (owner 2026-11-03). Draws NOTHING unless a big
 * problem stops the app (see `lib/setupStatus.ts` for the rule): then a red chip names the first
 * one and how many more, and a click lists them with their one-click fixes.
 *
 * Reads: the machine report (`GET /api/onboarding/readiness`, the server's memo, never a forced
 * probe), the tool list (`GET /api/agent/tools`) and the app's Claude accounts
 * (`GET /api/agent/accounts`), each once when the chip mounts and again when the window comes back
 * into focus and the last read is older than 5 minutes. No interval, except a light re-read every
 * 15 s while the report says offline, so a false "No internet" cannot outlive the outage. The
 * keys are shared with the checklist, the composer and Settings, so a fix run anywhere (or their
 * own polls) updates this chip too. A failed re-read keeps the last answer; no answer at all
 * means "cannot tell", which never alarms.
 */
export function SetupStatusChip() {
  const { t } = useI18n();
  const api = useApi();
  const { vault, bus } = useVault();
  const queryClient = useQueryClient();
  const report = useQuery({
    queryKey: READINESS_QUERY_KEY,
    queryFn: () => fetchReadiness(false),
    staleTime: FOCUS_STALE_MS,
    refetchOnWindowFocus: true,
    refetchOnReconnect: 'always',
    refetchInterval: (q) => (q.state.data && !q.state.data.online ? pollMs(OFFLINE_REREAD_MS) : false),
    retry: false,
  });
  const tools = useQuery({
    queryKey: ['agent-tools'],
    queryFn: () => api.get<{ tools: AgentToolInfo[] }>('/agent/tools').then((r) => r.tools),
    staleTime: FOCUS_STALE_MS,
    refetchOnWindowFocus: true,
    refetchInterval: false,
    retry: false,
  });
  const accounts = useQuery({
    queryKey: ['agent-claude-accounts'],
    queryFn: () => api.get<ClaudeAccountsResponse>('/agent/accounts'),
    staleTime: FOCUS_STALE_MS,
    refetchOnWindowFocus: true,
    refetchInterval: false,
    retry: false,
  });
  const projects = useShellProjects(true).data?.vaults;
  const projectMissing = !!vault && projects?.find((p) => p.name === vault)?.exists === false;
  // The last good answer wins over a failed re-read; never an answer = cannot tell (null).
  const toolList = Array.isArray(tools.data) ? tools.data : null;
  const claudeAccounts = Array.isArray(accounts.data?.accounts) ? accounts.data.accounts : null;
  // "No internet" only once two different reads agree: one slow 3 s ping (a proxy, a wake from
  // sleep) must not paint the chip red.
  const offlineReads = useRef<Set<number>>(new Set());
  if (report.data && report.data.online) offlineReads.current.clear();
  else if (report.data && !report.data.online) offlineReads.current.add(report.data.generatedAt);
  const offlineConfirmed = offlineReads.current.size >= 2;
  const problems = setupProblems({ report: report.data, tools: toolList, claudeAccounts, projectMissing, offlineConfirmed });
  const summary = chipSummary(problems);

  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const fixRuns = useFixRuns();
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!wrapRef.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);
  useEffect(() => { if (!summary) setOpen(false); }, [summary]);

  if (!summary) return null;
  const busy = Object.values(fixRuns.runs).some((r) => r && (r.phase === 'starting' || r.phase === 'running'));
  const runFix = async (p: SetupProblem) => {
    if (!p.fix || busy) return;
    await fixRuns.start(p.fix);
    void queryClient.invalidateQueries({ queryKey: ['agent-tools'] });
  };
  const label = t(summary.first.labelKey) + (summary.more > 0 ? ` · +${summary.more}` : '');
  const bad = problems.filter((p) => p.tone === 'bad').length;

  return (
    <div className="ns-setup-wrap" ref={wrapRef}>
      <button type="button" data-no-drag className={`ns-setup-chip ns-setup-chip--${summary.tone}`} aria-expanded={open} aria-haspopup="dialog"
        data-testid="setup-status-chip" data-tone={summary.tone} onClick={() => setOpen((v) => !v)}>
        <span className="ns-setup-dot" aria-hidden="true" />
        {label}
      </button>
      {open && (
        <div className="ns-setup-pop" role="dialog" aria-label={label} data-testid="setup-status-pop">
          <div className="ns-setup-pop-head">
            {bad > 0 ? t('setupStatus.head').replace('{n}', String(bad)) : t('setupStatus.headQuiet')}
          </div>
          {problems.map((p) => {
            const r = p.fix ? fixRuns.runs[p.fix] : undefined;
            const working = !!r && (r.phase === 'starting' || r.phase === 'running');
            return (
              <div key={p.id} className={`ns-setup-row ns-setup-row--${p.tone}`} data-testid={`setup-status-row-${p.id}`}>
                <span className="ns-setup-dot" aria-hidden="true" />
                <span className="ns-setup-text">
                  <span className="ns-setup-title">{t(p.labelKey)}</span>
                  <span className="ns-setup-detail">{t(p.detailKey)}</span>
                  {r?.phase === 'error' && <span className="ns-setup-detail">{t('setupStatus.fixFailed')}</span>}
                </span>
                {p.fix && (
                  <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={() => void runFix(p)}>
                    {working ? t('setupStatus.working') : t('setupStatus.fix')}
                  </button>
                )}
              </div>
            );
          })}
          <button type="button" className="ns-setup-foot"
            onClick={() => { setOpen(false); emitInstance(bus, 'dreamcontext-agent-open-page', { page: 'settings', id: 'system' }); }}>
            {t('setupStatus.allTools')}
          </button>
        </div>
      )}
    </div>
  );
}
