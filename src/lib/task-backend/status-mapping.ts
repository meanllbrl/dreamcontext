/**
 * How each status of the project's set maps onto the remote backends — the
 * read-only view behind `dreamcontext tasks statuses`. Lives INSIDE the
 * task-backend package because it knows both providers' wire shapes; callers
 * (the CLI) stay provider-agnostic and only see the rendered description.
 */
import { dirname } from 'node:path';
import { readSetupConfig } from '../setup-config.js';
import { SHIPPED_STATUS_KEYS, parentOf, sortByOrder, statusColor, subStatusMarker, type StatusDef, type StatusKind } from '../task-status.js';
import { statusToClickUp } from './clickup-map.js';
import { statusToGitHub, subStatusLabel } from './github-map.js';
import { SyncLedger } from './sync-state.js';

export interface StatusMappingRow {
  key: string;
  label: string;
  kind: StatusKind;
  order: number;
  /** 6-hex, no `#` — the declared colour or the kind default. */
  color: string;
  shipped: boolean;
  /** The shipped status this one rides under on every remote. */
  parent: string;
  /** The `dc:<key>` marker that carries the child (label on GitHub, tag on ClickUp); null for shipped. */
  marker: string | null;
  /** `state[+state_reason] [dc:<key>]`, or `(state untouched)` for a key the set does not declare. */
  github: string;
  /** The remote (ClickUp) list status a push would use, or null when the cached list has none. */
  remote_status: string | null;
  /** Declared remote-status aliases (`clickup:` in overrides/task.md). */
  remote_aliases: string[];
  /** Whether the cached remote list statuses were available for `remote_status`. */
  remote_list_cached: boolean;
}

/** The cached ClickUp list statuses for a ClickUp-backed project; [] otherwise / never synced. */
export function cachedRemoteListStatuses(contextRoot: string): string[] {
  try {
    const cfg = readSetupConfig(dirname(contextRoot));
    if (cfg?.taskBackend !== 'clickup') return [];
    return new SyncLedger(contextRoot).readListStatuses();
  } catch {
    return [];
  }
}

/** One row per status of the set, in pipeline order. */
export function describeStatusMappings(contextRoot: string, statuses: readonly StatusDef[]): StatusMappingRow[] {
  const defs = sortByOrder(statuses);
  const listStatuses = cachedRemoteListStatuses(contextRoot);
  return defs.map((d) => {
    const gh = statusToGitHub(d.key, { statuses: defs });
    const label = subStatusLabel(d.key, defs);
    const github = `${gh.state ?? '(state untouched)'}${gh.state_reason ? `+${gh.state_reason}` : ''}${label ? ` ${label}` : ''}`;
    return {
      key: d.key,
      label: d.label,
      kind: d.kind,
      order: d.order,
      color: statusColor(d),
      shipped: SHIPPED_STATUS_KEYS.includes(d.key),
      parent: parentOf(defs, d.key),
      marker: subStatusMarker(defs, d.key),
      github,
      remote_status: statusToClickUp(d.key, listStatuses.length > 0 ? listStatuses : null, defs),
      remote_aliases: d.clickup ?? [],
      remote_list_cached: listStatuses.length > 0,
    };
  });
}
