import { useState, type ReactNode } from 'react';
import { useI18n } from '../../context/I18nContext';
import { useAgentGate, useFixRuns, type GateAgent } from '../../hooks/useOnboarding';
import type { ReadinessReport } from '../../lib/onboardingTypes';
import { ToolMark } from '../../components/sleepy/chat/model-picker/ModelPicker';
import { GemConverge } from './GemConverge';

const AGENT_NAME: Record<GateAgent, string> = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' };

function RowIcon({ kind }: { kind: 'book' | 'eye' | 'grid' }) {
  const common = { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  if (kind === 'book') return <svg {...common}><path d="M2 4h7a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H2z" /><path d="M22 4h-7a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h8z" /></svg>;
  if (kind === 'eye') return <svg {...common}><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>;
  return <svg {...common}><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>;
}

/**
 * Screen 1 of the first open (plan ilk-acilis v2-01, C2, D4): what dreamcontext is, and ONE way
 * on, "Continue with Claude". The button gets Claude ready on this same screen (install, then
 * the browser sign-in, each only when needed) and writes the pick; a signed-in Mac moves on at
 * once. "Use Codex or Antigravity instead" swaps in that choice (01h). No checklist, ever.
 */
export function Welcome({ report, onReady }: { report: ReadinessReport | undefined; onReady: (agent: GateAgent) => void }) {
  const { t } = useI18n();
  const fixRuns = useFixRuns();
  const gate = useAgentGate(report, fixRuns);
  const [other, setOther] = useState(false);
  const [agent, setAgent] = useState<GateAgent>('claude');
  const [details, setDetails] = useState(false);
  const name = AGENT_NAME[agent];

  async function go(a: GateAgent) {
    setAgent(a);
    setDetails(false);
    if (await gate.run(a)) onReady(a);
  }

  function cancel() {
    const running = Object.values(fixRuns.runs).find((r) => r && (r.phase === 'running' || r.phase === 'starting'));
    if (running) void fixRuns.cancel(running.fix);
    gate.reset();
  }

  function stateCard() {
    const s = gate.state;
    if (s.kind === 'idle') return null;
    if (s.kind === 'preparing') {
      return (
        <div className="ob-gate" role="status" aria-live="polite" data-testid="ob-gate-preparing">
          <p className="ob-gate-title"><span className="ob-live-dot" aria-hidden="true" /> {t('onboarding.gate.preparing').replace('{agent}', name)}</p>
          <p className="ob-gate-body">{t('onboarding.gate.preparingHint')}</p>
          <button type="button" className="ob-link" onClick={cancel}>{t('onboarding.gate.cancel')}</button>
        </div>
      );
    }
    const card = (testid: string, title: string, body: string, actions: ReactNode) => (
      <div className="ob-gate" role="status" aria-live="polite" data-testid={testid}>
        <p className="ob-gate-title">{title}</p>
        <p className="ob-gate-body">{body}</p>
        <div className="ob-gate-actions">{actions}</div>
      </div>
    );
    if (s.kind === 'browser') {
      return card('ob-gate-browser', t('onboarding.gate.browserTitle').replace('{agent}', name), t('onboarding.gate.browserBody'), <>
        <button type="button" className="ob-btn ob-btn--secondary" onClick={() => { cancel(); void go(agent); }}>{t('onboarding.gate.openAgain')}</button>
        <button type="button" className="ob-link" onClick={cancel}>{t('onboarding.gate.cancel')}</button>
      </>);
    }
    const retry = <button type="button" className="ob-btn ob-btn--secondary" onClick={() => void go(agent)}>{t('onboarding.gate.tryAgain')}</button>;
    if (s.kind === 'offline') {
      return card('ob-gate-offline', t('onboarding.gate.offlineTitle'), t('onboarding.gate.offlineBody'), <>
        {retry}<button type="button" className="ob-link" onClick={gate.reset}>{t('onboarding.gate.cancel')}</button>
      </>);
    }
    if (s.kind === 'not-finished') {
      return card('ob-gate-not-finished', t('onboarding.gate.notFinishedTitle'), t('onboarding.gate.notFinishedBody'), retry);
    }
    if (s.kind === 'manual') {
      return card('ob-gate-manual', t('onboarding.gate.manualTitle').replace('{agent}', name), '', <code className="ob-path">{s.command}</code>);
    }
    return (
      <div className="ob-gate" role="status" data-testid="ob-gate-install-failed">
        <p className="ob-gate-title">{t('onboarding.gate.installFailedTitle').replace('{agent}', name)}</p>
        <p className="ob-gate-body">{t('onboarding.gate.installFailedBody')}</p>
        <div className="ob-gate-actions">
          {retry}
          {s.output && <button type="button" className="ob-link" onClick={() => setDetails((d) => !d)}>{t('onboarding.gate.details')}</button>}
        </div>
        {details && s.output && <pre className="ob-gate-details">{s.output}</pre>}
      </div>
    );
  }

  const busy = gate.state.kind === 'preparing' || gate.state.kind === 'browser';

  if (other) {
    return (
      <div className="ob-panel-body ob-welcome">
        <GemConverge />
        <span className="ob-welcome-word">dream<span>context</span></span>
        <h1 className="ob-welcome-title">{t('onboarding.welcome.otherTitle')}</h1>
        <p className="ob-welcome-body">{t('onboarding.welcome.otherBody')}</p>
        <div className="ob-welcome-cta">
          {stateCard() ?? (
            <>
              <button type="button" className="ob-btn ob-btn--secondary ob-btn--wide" onClick={() => void go('codex')}>{t('onboarding.welcome.codex')}</button>
              <button type="button" className="ob-btn ob-btn--secondary ob-btn--wide" onClick={() => void go('antigravity')}>{t('onboarding.welcome.antigravity')}</button>
            </>
          )}
          {!busy && (
            <button type="button" className="ob-link" onClick={() => { gate.reset(); setAgent('claude'); setOther(false); }}>
              {t('onboarding.welcome.backToClaude')}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="ob-panel-body ob-welcome">
      <GemConverge />
      <span className="ob-welcome-word">dream<span>context</span></span>
      <h1 className="ob-welcome-title">{t('onboarding.welcome.title')}</h1>
      <p className="ob-welcome-body">{t('onboarding.welcome.body')}</p>
      <ul className="ob-welcome-rows">
        {([
          ['book', 'remembers'],
          ['eye', 'picture'],
          ['grid', 'place'],
        ] as const).map(([icon, key]) => (
          <li key={key} className="ob-welcome-row">
            <span className="ob-welcome-row-icon"><RowIcon kind={icon} /></span>
            <span>
              <span className="ob-welcome-row-title">{t(`onboarding.welcome.row.${key}`)}</span>
              <span className="ob-welcome-row-body">{t(`onboarding.welcome.row.${key}Body`)}</span>
            </span>
          </li>
        ))}
      </ul>
      <div className="ob-welcome-cta">
        {stateCard() ?? (
          <>
            <button type="button" className="ob-btn ob-btn--primary ob-btn--wide" onClick={() => void go('claude')} autoFocus data-testid="ob-continue-claude">
              <span className="ob-btn-mark"><ToolMark tool="claude" /></span>
              {t('onboarding.welcome.start')}
            </button>
            <p className="ob-hint">{t('onboarding.welcome.next')}</p>
          </>
        )}
        {!busy && (
          <button type="button" className="ob-link" onClick={() => { gate.reset(); setOther(true); }}>
            {t('onboarding.welcome.other')}
          </button>
        )}
      </div>
    </div>
  );
}
