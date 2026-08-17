import { useAutomationDispatcher, useInstallDispatcher, useUninstallDispatcher } from '../../hooks/useAutomations';
import { confirmAction } from '../../lib/desktop';
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

export function AutomationsDispatcherBar({ onToast }: { onToast?: (msg: string) => void }) {
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
      onError: (err) => onToast?.(`Could not turn the scheduler on — ${(err as Error).message}`),
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
      onSuccess: () => onToast?.('Scheduler off — nothing will fire on a schedule.'),
      onError: (err) => onToast?.(`Could not turn the scheduler off — ${(err as Error).message}`),
    });
  };

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
    return (
      <div className="auto-dispatch auto-dispatch--warn">
        <span className="auto-dispatch-dot" aria-hidden="true" />
        <div className="auto-dispatch-text">
          <strong>The scheduler is out of date.</strong>
          <span>
            It was installed against a different <code>dreamcontext</code> than the one running now,
            so it wakes on schedule and fails. Reinstalling re-bakes the path.
          </span>
        </div>
        <button className="auto-dispatch-btn" onClick={() => doInstall(true)} disabled={busy}>
          {install.isPending ? 'Refreshing…' : 'Refresh scheduler'}
        </button>
      </div>
    );
  }

  // Healthy and on, but this project is not in the registry it walks — so its
  // automations are listed here and never fire. Fixed by the same install call.
  if (dispatcher.installed && !dispatcher.projectRegistered) {
    return (
      <div className="auto-dispatch auto-dispatch--warn">
        <span className="auto-dispatch-dot" aria-hidden="true" />
        <div className="auto-dispatch-text">
          <strong>The scheduler is on, but it isn't watching this project.</strong>
          <span>
            This machine's registry has no entry for this project, so the dispatcher never looks
            here — the usual cause is automations that arrived over brain sync rather than being
            created on this machine.
          </span>
        </div>
        <button className="auto-dispatch-btn" onClick={() => doInstall(false)} disabled={busy}>
          {install.isPending ? 'Adding…' : 'Watch this project'}
        </button>
      </div>
    );
  }

  if (dispatcher.installed) {
    return (
      <div className="auto-dispatch auto-dispatch--on">
        <span className="auto-dispatch-dot" aria-hidden="true" />
        <div className="auto-dispatch-text">
          <strong>Scheduler is on.</strong>
          <span>
            Wakes every 5 minutes and runs what's due — last check {fmtWhen(dispatcher.lastTickCompletedAt)}.
            Each automation still runs only once you approve it on this machine.
          </span>
        </div>
        <button className="auto-dispatch-btn auto-dispatch-btn--ghost" onClick={doUninstall} disabled={busy}>
          {uninstall.isPending ? 'Turning off…' : 'Turn off'}
        </button>
      </div>
    );
  }

  return (
    <div className="auto-dispatch auto-dispatch--off">
      <span className="auto-dispatch-dot" aria-hidden="true" />
      <div className="auto-dispatch-text">
        <strong>Scheduler is off — nothing runs on a schedule.</strong>
        <span>
          Turning it on installs one background job that wakes every 5 minutes and runs whatever is
          due. It never runs an automation you haven't approved on this machine.
        </span>
      </div>
      <button className="auto-dispatch-btn" onClick={() => doInstall(false)} disabled={busy}>
        {install.isPending ? 'Turning on…' : 'Turn on scheduler'}
      </button>
    </div>
  );
}
