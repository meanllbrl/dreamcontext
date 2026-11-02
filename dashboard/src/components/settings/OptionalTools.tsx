import { useQueryClient } from '@tanstack/react-query';
import { useI18n } from '../../context/I18nContext';
import { useAgentTools, useToolAccounts } from '../../hooks/useAgentCapabilities';
import { useFixRuns } from '../../hooks/useOnboarding';
import { accountSummary, optionalToolModel, primaryAccount, type OptionalRowModel, type OptionalTool } from '../../lib/optionalTools';
import './SystemDependencies.css';

/**
 * Settings → System, under "Required software": Codex and Antigravity, which nothing needs.
 * Their state is read from `GET /api/agent/tools` (the same read the Models tabs use) and the
 * account line from `GET /api/agent/accounts/<tool>`. Every fix is the onboarding fix of the
 * same name (`/api/onboarding/fix`), so a click here and a click in the setup checklist are the
 * same run. Gray and neutral throughout: see `lib/optionalTools.ts`.
 */
export function OptionalTools() {
  const { data: tools } = useAgentTools();
  // An older server has no tool list: say nothing rather than call every tool missing.
  if (!tools || tools.length === 0) return null;
  return (
    <div className="sysdep sysdep-optional" data-testid="optional-tools">
      {(['codex', 'antigravity'] as const).map((tool) => (
        <OptionalToolItem key={tool} tool={tool} info={tools.find((x) => x.tool === tool)} />
      ))}
    </div>
  );
}

function OptionalToolItem({ tool, info }: { tool: OptionalTool; info: Parameters<typeof optionalToolModel>[1] }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const fixRuns = useFixRuns();
  const model = optionalToolModel(tool, info);
  const accounts = useToolAccounts(tool, !!model.account && model.account.tone === 'ok').data?.accounts;
  const busy = Object.values(fixRuns.runs).some((r) => r && (r.phase === 'starting' || r.phase === 'running'));

  const run = async (row: OptionalRowModel) => {
    if (!row.action || busy) return;
    await fixRuns.start(row.action.fix);
    void queryClient.invalidateQueries({ queryKey: ['agent-tools'] });
    void queryClient.invalidateQueries({ queryKey: [`agent-${tool}-accounts`] });
  };

  const button = (row: OptionalRowModel) => {
    if (!row.action) return null;
    const r = fixRuns.runs[row.action.fix];
    const working = !!r && (r.phase === 'starting' || r.phase === 'running');
    return (
      <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={() => void run(row)}
        data-testid={`optional-${row.action.fix}`}>
        {working ? t('settings.optional.working') : t(row.action.labelKey)}
      </button>
    );
  };
  const failed = Object.values(fixRuns.runs).find((r) => r?.phase === 'error');

  return (
    <div className="sysdep-item" data-testid={`optional-${tool}`}>
      <div className="sysdep-row">
        <span className={`sysdep-dot ${model.install.tone === 'ok' ? 'sysdep-dot--ok' : 'sysdep-dot--muted'}`} aria-hidden="true" />
        <span className="sysdep-name">{model.name}</span>
        <span className="sysdep-optional-desc">{t(model.descKey)}</span>
        <span className="sysdep-status sysdep-status--quiet">{t(model.install.statusKey)}</span>
        {button(model.install)}
      </div>
      {model.account && (
        <div className="sysdep-row sysdep-optional-account">
          <span className={`sysdep-dot ${model.account.tone === 'ok' ? 'sysdep-dot--ok' : 'sysdep-dot--muted'}`} aria-hidden="true" />
          <span className="sysdep-name">{t('settings.optional.account')}</span>
          {model.account.tone === 'ok' && (
            <span className="sysdep-optional-desc">{accountSummary(tool, primaryAccount(accounts), t)}</span>
          )}
          <span className="sysdep-status sysdep-status--quiet">{t(model.account.statusKey)}</span>
          {button(model.account)}
        </div>
      )}
      {failed && <p className="sysdep-note">{t('settings.optional.failed')}</p>}
    </div>
  );
}
