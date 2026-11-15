// The Settings line for the CLI self-update (components/settings/AutoUpdateSetting.tsx). Pure:
// the view comes from GET /api/launcher/self-update, the strings from the caller's t().

/** GET /api/launcher/self-update (src/server/routes/launcher.ts). */
export interface SelfUpdateView {
  enabled: boolean;
  disabledBy: string | null;
  desktop: boolean;
  logPath: string;
  record: {
    checkedAt: number;
    at: number;
    installed: string | null;
    latest: string | null;
    state: 'current' | 'updating' | 'updated' | 'failed' | 'deferred' | 'disabled' | 'unknown';
    from?: string;
    to?: string;
    error?: string;
    reason?: string;
  } | null;
}

function when(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** The last outcome in one sentence. An env opt-out is said even when the switch is on. */
export function statusLine(view: SelfUpdateView, t: (k: string) => string): string {
  if (view.disabledBy && view.enabled) return t('settings.selfUpdate.status.env').replace('{reason}', view.disabledBy);
  if (!view.enabled) return t('settings.selfUpdate.status.off');
  const r = view.record;
  if (!r || (r.checkedAt === 0 && r.state !== 'deferred')) return t('settings.selfUpdate.status.never');
  const fill = (key: string) => t(key)
    .replace('{installed}', r.installed ?? '?')
    .replace('{latest}', r.latest ?? '?')
    .replace('{from}', r.from ?? '?')
    .replace('{to}', r.to ?? r.installed ?? '?')
    .replace('{when}', when(r.at));
  switch (r.state) {
    case 'current': return fill('settings.selfUpdate.status.current');
    case 'updated': return fill('settings.selfUpdate.status.updated');
    case 'updating': return fill('settings.selfUpdate.status.updating');
    case 'deferred': return fill('settings.selfUpdate.status.deferred');
    case 'failed': return `${fill('settings.selfUpdate.status.failed')} ${t('settings.selfUpdate.status.log').replace('{path}', view.logPath)}`;
    default: return fill('settings.selfUpdate.status.unknown');
  }
}

/** GET /api/launcher/update-channel (src/server/routes/launcher.ts `updateChannelView`). */
export interface UpdateChannelView {
  channel: 'stable' | 'beta';
  appVersion: string | null;
  stableVersion: string | null;
  /** Off Beta, on a build newer than stable: it stays until stable passes it. */
  staysUntilStable: boolean;
  desktop: boolean;
}

/** The line under the Beta row: on, off, or off with the build in place staying (never a downgrade). */
export function channelStatusLine(v: UpdateChannelView, t: (k: string) => string): string {
  if (!v.desktop) return t('settings.beta.status.desktopOnly');
  if (v.channel === 'beta') return t('settings.beta.status.on');
  if (v.staysUntilStable && v.appVersion) return t('settings.beta.status.stays').replace('{installed}', v.appVersion);
  return t('settings.beta.status.off');
}
