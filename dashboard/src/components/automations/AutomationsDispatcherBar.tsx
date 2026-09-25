import { useAutomationDispatcher, useInstallDispatcher, useUninstallDispatcher } from '../../hooks/useAutomations';
import { confirmAction } from '../../lib/desktop';
import { useI18n } from '../../context/I18nContext';
import './AutomationsDispatcherBar.css';

/**
 * The scheduler switch — Automations' one machine-local gate, made visible and
 * flippable from the dashboard instead of only from `dreamcontext automations
 * install`.
 *
 * It answers one question at a glance ("will anything on this page actually
 * fire?") and, when the answer is no, offers the fix in place. The states it
 * distinguishes matter because each one fails differently:
 *
 *   off              — nothing fires, ever. The default the feature ships in.
 *   on               — the dispatcher wakes every 5 minutes and runs what's due.
 *   stale            — installed, but the baked wrapper points at a CLI that
 *                      has since moved; it wakes and fails. Reinstall fixes it.
 *   not registered   — installed and healthy, but this project was never added
 *                      to the machine-local registry, so the dispatcher never
 *                      looks here. The shape a brain-synced `automations/`
 *                      directory arrives in, and invisible without this line.
 *   unsupported      — non-macOS. Say so plainly; offer no button that lies.
 *
 * Turning the scheduler ON is not the same as letting anything run: every
 * automation still needs its own machine-local approval, which is the badge on
 * its card and the review in its detail panel.
 */

function fmtWhen(iso: string | null): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** A bar's sentence split at its first full stop: the headline (bold) and the rest.
 *  The copy lives in one key per state, so the split happens here, not in the catalogue. */
function headAndRest(text: string): [string, string] {
  const at = text.indexOf('. ');
  return at === -1 ? [text, ''] : [text.slice(0, at + 1), text.slice(at + 2)];
}

/**
 * `variant`:
 *   full    — every state as a bar (the zero-state's column, where there is room).
 *   inline  — the page header's pill: only the two HEALTHY states (on / off), as one small
 *             control on the header row. They are true every time the page opens, so a
 *             full-width bar for them was 60px of channel spent on the same news forever.
 *   alerts  — only the two WARN states, as ONE flat row of the header's notice tray: the
 *             headline and the button, with the "why" on the headline's and the button's
 *             tooltip. The paragraph version took the channel down to under half the window at
 *             1100px; the full variant keeps it.
 */
export function AutomationsDispatcherBar({
  onToast,
  variant = 'full',
}: {
  onToast?: (msg: string) => void;
  variant?: 'full' | 'inline' | 'alerts';
}) {
  const { t } = useI18n();
  const { data: dispatcher, isLoading } = useAutomationDispatcher();
  const install = useInstallDispatcher();
  const uninstall = useUninstallDispatcher();

  // Never render a switch whose state we don't know yet — a bar that says
  // "off" for a beat and then flips to "on" teaches the user to distrust it.
  if (isLoading || !dispatcher) return null;

  const busy = install.isPending || uninstall.isPending;

  const doInstall = (force: boolean) => {
    install.mutate({ force }, {
      onSuccess: (result) => {
        if (!result.installed) {
          // The soft refusal: a resolution mismatch wrote nothing and handed
          // back its reason. Surfaced verbatim — it names both binaries.
          onToast?.(result.warnings[0] ?? 'Nothing was installed.');
          return;
        }
        onToast?.(
          result.notifier.built
            ? 'Scheduler on. If macOS just asked about notifications, choose Allow.'
            : `Scheduler on. Branded notifications unavailable (${result.notifier.reason}).`,
        );
      },
      onError: (err) => onToast?.(t('scheduler.toast.onFailed').replace('{reason}', (err as Error).message)),
    });
  };

  const doUninstall = async () => {
    const ok = await confirmAction({
      title: 'Turn the scheduler off?',
      body: 'Nothing will run on a schedule until you turn it back on. '
        + 'Your automations, their approvals and their run history are all kept.',
      confirmLabel: 'Turn off',
    });
    if (!ok) return;
    uninstall.mutate(undefined, {
      onSuccess: () => onToast?.(t('scheduler.toast.off')),
      onError: (err) => onToast?.(t('scheduler.toast.offFailed').replace('{reason}', (err as Error).message)),
    });
  };

  const warn = dispatcher.supported && dispatcher.installed
    && (!dispatcher.current || !dispatcher.projectRegistered);
  if (variant === 'alerts' && !warn) return null;
  if (variant === 'inline') {
    if (warn || !dispatcher.supported) return null;
    const on = dispatcher.installed;
    const label = busy
      ? (on ? 'Turning off…' : 'Turning on…')
      : (on ? 'Scheduler on' : 'Scheduler off');
    return (
      // The label sits in its own span so a narrow header can drop it and keep the dot; the
      // name then lives on `aria-label`. `aria-busy` + the dot's pulse carry "switching", so
      // the words keep full ink instead of fading while the reader waits on them.
      <button
        type="button"
        className={`auto-dispatch-pill${on ? ' auto-dispatch-pill--on' : ''}`}
        onClick={on ? doUninstall : () => doInstall(false)}
        disabled={busy}
        aria-busy={busy}
        aria-label={label}
        title={on
          ? `Scheduler is on. Last check ${fmtWhen(dispatcher.lastTickCompletedAt)}. Click to turn it off.`
          : 'Scheduler is off: nothing runs on a schedule. Click to turn it on. It never runs an agent you have not approved on this machine.'}
      >
        <span className="auto-dispatch-dot" aria-hidden="true" />
        <span className="auto-dispatch-pill-label">{label}</span>
      </button>
    );
  }

  // In the header (`alerts`) a WARN state is one line: headline and fix. Its "why" rides on
  // the button's tooltip. The zero-state (`full`) has room, so it keeps the sentence.
  const oneLine = variant === 'alerts';

  if (!dispatcher.supported) {
    return (
      <div className="auto-dispatch auto-dispatch--off">
        <span className="auto-dispatch-dot" aria-hidden="true" />
        <div className="auto-dispatch-text">
          <strong>Scheduling is macOS-only for now.</strong>
          <span>
            Automations still run on demand here; the launchd dispatcher (and a Linux cron backend
            behind the same seam) is what puts them on a clock.
          </span>
        </div>
      </div>
    );
  }

  // Installed but pointing at a CLI that has moved: it wakes on time and fails.
  if (dispatcher.installed && !dispatcher.current) {
    const why = t('scheduler.stale.why');
    return (
      <div className={`auto-dispatch auto-dispatch--warn${oneLine ? ' auto-dispatch--row' : ''}`}>
        <span className="auto-dispatch-dot" aria-hidden="true" />
        <div className="auto-dispatch-text">
          <strong title={oneLine ? why : undefined}>The scheduler is out of date.</strong>
          {!oneLine && <span>{why}</span>}
        </div>
        <button className="auto-dispatch-btn" onClick={() => doInstall(true)} disabled={busy} title={why}>
          {install.isPending ? 'Refreshing…' : 'Refresh scheduler'}
        </button>
      </div>
    );
  }

  // Healthy and on, but this project is not in the registry it walks — so its
  // automations are listed here and never fire. Fixed by the same install call.
  if (dispatcher.installed && !dispatcher.projectRegistered) {
    const why = t('scheduler.unwatched.why');
    return (
      <div className={`auto-dispatch auto-dispatch--warn${oneLine ? ' auto-dispatch--row' : ''}`}>
        <span className="auto-dispatch-dot" aria-hidden="true" />
        <div className="auto-dispatch-text">
          <strong title={oneLine ? why : undefined}>The scheduler is on, but it isn't watching this project.</strong>
          {!oneLine && <span>{why}</span>}
        </div>
        <button className="auto-dispatch-btn" onClick={() => doInstall(false)} disabled={busy} title={why}>
          {install.isPending ? 'Adding…' : 'Watch this project'}
        </button>
      </div>
    );
  }

  if (dispatcher.installed) {
    const [head, rest] = headAndRest(t('scheduler.full.on').replace('{when}', fmtWhen(dispatcher.lastTickCompletedAt)));
    return (
      <div className="auto-dispatch auto-dispatch--on auto-dispatch--tight">
        <span className="auto-dispatch-dot" aria-hidden="true" />
        <div className="auto-dispatch-text">
          <strong>{head}</strong>
          {rest && <span>{rest}</span>}
        </div>
        <button className="auto-dispatch-btn auto-dispatch-btn--ghost" onClick={doUninstall} disabled={busy}>
          {uninstall.isPending ? 'Turning off…' : 'Turn off'}
        </button>
      </div>
    );
  }

  const [offHead, offRest] = headAndRest(t('scheduler.full.off'));
  return (
    <div className="auto-dispatch auto-dispatch--off auto-dispatch--tight">
      <span className="auto-dispatch-dot" aria-hidden="true" />
      <div className="auto-dispatch-text">
        <strong>{offHead}</strong>
        {offRest && <span>{offRest}</span>}
      </div>
      <button
        className="auto-dispatch-btn"
        title="Installs one background job that wakes every 5 minutes and runs whatever is due. It never runs an automation you haven't approved on this machine."
        onClick={() => doInstall(false)}
        disabled={busy}
      >
        {install.isPending ? 'Turning on…' : 'Turn on scheduler'}
      </button>
    </div>
  );
}
