import { useMemo, useState, type ReactNode } from 'react';
import qrcode from 'qrcode-generator';
import { useI18n } from '../../context/I18nContext';
import { copyPreservingUnicode } from '../../lib/clipboard';
import type { HandsfreeJob, HandsfreeStatus, RunningWork } from './handsfreeTypes';
import './handsfree.css';

/** `t()` is a plain lookup; placeholders are filled here, at the call site. */
export function fill(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 1024) return `${Math.max(0, Math.round(n || 0))} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

/** Core-minutes as hours of THIS machine (the quota is counted per core). */
export function coreHours(coreMinutes: number, cores = 2): string {
  return (Math.max(0, coreMinutes) / cores / 60).toFixed(1);
}

// ---------------------------------------------------------------- stages (per-step progress)

export const GO_STAGES = ['check', 'wait', 'start', 'copy'] as const;
export const RETURN_STAGES = ['wake', 'wait', 'snapshot', 'download', 'apply', 'finalize'] as const;

/** Which stage a job's raw step belongs to (an unknown step stays on the last known stage). */
export function stageOf(kind: HandsfreeJob['kind'], step: string | null): string | null {
  if (!step) return null;
  if (step === 'waiting') return 'wait';
  if (kind === 'go') {
    if (step === 'preflight') return 'check';
    if (step.startsWith('go.')) return 'copy';
    return 'start';
  }
  if (['start', 'recreate', 'health', 'parity'].includes(step)) return 'wake';
  if (step === 'snapshot' || step === 'delta-return') return 'snapshot';
  if (step === 'download' || step === 'plan') return 'download';
  if (['wipe-secrets', 'seal', 'stop'].includes(step)) return 'finalize';
  return 'apply';
}

export function JobProgress({ job }: { job: HandsfreeJob }) {
  const { t } = useI18n();
  const stages: readonly string[] = job.kind === 'go' ? GO_STAGES : RETURN_STAGES;
  const current = stageOf(job.kind, job.step);
  const at = current ? stages.indexOf(current) : -1;
  return (
    <ol className="hf-steps" aria-label={t('handsfree.progress.aria')}>
      {stages.map((s, i) => {
        const state = job.status === 'success' || i < at ? 'done' : i === at ? (job.status === 'error' ? 'failed' : 'current') : 'pending';
        return (
          <li key={s} className="hf-step" data-state={state} aria-current={state === 'current' ? 'step' : undefined}>
            <span className="hf-step-mark" aria-hidden>{state === 'done' ? '✓' : state === 'failed' ? '!' : state === 'current' ? '•' : ''}</span>
            <span className="hf-step-label">{t(`handsfree.stage.${s}`)}</span>
            {state === 'current' && job.detail && <span className="hf-step-detail">{job.detail}</span>}
          </li>
        );
      })}
    </ol>
  );
}

export function RunningList({ running, detail }: { running: RunningWork[]; detail?: string | null }) {
  const { t } = useI18n();
  if (!running.length) return detail ? <p className="hf-quiet">{detail}</p> : null;
  return (
    <ul className="hf-running">
      {running.map((w) => (
        <li key={`${w.kind}:${w.id}`}>
          <span className="hf-chip">{t(`handsfree.work.${w.kind}`) === `handsfree.work.${w.kind}` ? w.kind : t(`handsfree.work.${w.kind}`)}</span>
          <code className="hf-mono">{w.command ?? w.id}</code>
          {w.cwd && <span className="hf-quiet hf-mono">{w.cwd}</span>}
        </li>
      ))}
    </ul>
  );
}

/**
 * A destructive or interrupting action, confirmed IN the page in two steps (never a browser
 * dialog: `window.confirm` is a silent no-op in the desktop app's WKWebView).
 */
export function InlineConfirm({ label, confirmLabel, body, onConfirm, busy, danger, testId }: {
  label: string;
  confirmLabel: string;
  body: ReactNode;
  onConfirm: () => void;
  busy?: boolean;
  danger?: boolean;
  testId?: string;
}) {
  const { t } = useI18n();
  const [armed, setArmed] = useState(false);
  if (!armed) {
    return (
      <button type="button" className={`hf-btn${danger ? ' hf-btn--danger-quiet' : ''}`} onClick={() => setArmed(true)} disabled={busy} data-testid={testId}>
        {label}
      </button>
    );
  }
  return (
    <div className="hf-confirm" role="group" aria-label={label}>
      <div className="hf-confirm-body">{body}</div>
      <div className="hf-actions">
        <button type="button" className={`hf-btn ${danger ? 'hf-btn--danger' : 'hf-btn--primary'}`} onClick={() => { setArmed(false); onConfirm(); }} disabled={busy} data-testid={testId ? `${testId}-confirm` : undefined}>
          {confirmLabel}
        </button>
        <button type="button" className="hf-btn" onClick={() => setArmed(false)}>{t('handsfree.cancel')}</button>
      </div>
    </div>
  );
}

/** A QR code of the URL, drawn as SVG cells from the module matrix (offline, no markup injected). */
export function HandsfreeQr({ value, label }: { value: string; label: string }) {
  const cells = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();
    const n = qr.getModuleCount();
    const dark: Array<[number, number]> = [];
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) dark.push([c, r]);
    return { n, dark };
  }, [value]);
  const quiet = 4;
  const size = cells.n + quiet * 2;
  return (
    <svg className="hf-qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={size} height={size} className="hf-qr-bg" />
      {cells.dark.map(([x, y]) => <rect key={`${x}-${y}`} x={x + quiet} y={y + quiet} width={1} height={1} className="hf-qr-cell" />)}
    </svg>
  );
}

export function CopyButton({ text, testId }: { text: string; testId?: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="hf-btn"
      data-testid={testId}
      onClick={() => {
        void copyPreservingUnicode(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? t('handsfree.copied') : t('handsfree.copy')}
    </button>
  );
}

/** The cloud URL with its QR and a copy button; the passphrase is NEVER shown or encoded here. */
export function CloudLink({ url }: { url: string }) {
  const { t } = useI18n();
  return (
    <div className="hf-link">
      <HandsfreeQr value={url} label={t('handsfree.link.qrAria')} />
      <div className="hf-link-side">
        <code className="hf-mono hf-url" data-testid="hf-url">{url}</code>
        <div className="hf-actions"><CopyButton text={url} testId="hf-copy-url" /></div>
        <p className="hf-quiet">{t('handsfree.link.passphrase')}</p>
      </div>
    </div>
  );
}

/**
 * A job's error: its own message, then the code-specific next step (AC23 quota reset +
 * Abandon, a private port's manual step, ownership / superseded explained).
 */
export function JobErrorBlock({ job, status, onAbandon, busy }: {
  job: HandsfreeJob;
  status: HandsfreeStatus | null;
  onAbandon?: () => void;
  busy?: boolean;
}) {
  const { t } = useI18n();
  const err = job.error;
  if (!err) return null;
  const d = err.detail ?? {};
  const resetsAt = typeof d.resetsAt === 'string' ? d.resetsAt : null;
  let action: ReactNode = null;
  switch (err.code) {
    case 'quota':
      action = (
        <>
          <p>{resetsAt ? fill(t('handsfree.error.quotaResets'), { date: new Date(resetsAt).toLocaleDateString() }) : t('handsfree.error.quotaUnknown')}</p>
          {d.canAbandon === true && onAbandon && (
            <AbandonConfirm onConfirm={onAbandon} busy={busy} />
          )}
        </>
      );
      break;
    case 'port_private':
      action = <p>{fill(t('handsfree.error.portPrivate'), { name: status?.codespace?.name ?? '' })}</p>;
      break;
    case 'ownership':
    case 'confirm_take_over':
      action = <p>{t('handsfree.error.ownership')}</p>;
      break;
    case 'superseded':
      action = <p>{t('handsfree.error.superseded')}</p>;
      break;
    case 'not_setup':
      action = <p>{t('handsfree.error.notSetup')}</p>;
      break;
    case 'turns_running':
      action = <p>{t('handsfree.error.turnsRunning')}</p>;
      break;
    case 'cloud_preflight':
      action = <p>{t('handsfree.error.cloudPreflight')}</p>;
      break;
    default:
      action = null;
  }
  return (
    <div className="hf-error" role="alert" data-testid="hf-job-error" data-code={err.code}>
      <p className="hf-error-msg">{err.message}</p>
      {action}
    </div>
  );
}

/** Abandon, double-confirmed in the page; the request carries `{confirm:'abandon'}` (D12). */
export function AbandonConfirm({ onConfirm, busy }: { onConfirm: () => void; busy?: boolean }) {
  const { t } = useI18n();
  return (
    <InlineConfirm
      label={t('handsfree.abandon')}
      confirmLabel={t('handsfree.abandon.confirm')}
      body={<p>{t('handsfree.abandon.body')}</p>}
      onConfirm={onConfirm}
      busy={busy}
      danger
      testId="hf-abandon"
    />
  );
}
