/**
 * Sleep-connector types — the brain's sensory feed (task sleep-connectors).
 *
 * A connector is a standing "learn from this external source" agreement:
 * manifest (`connectors/<slug>.md`) + bounded event cache
 * (`connectors/cache/<slug>.json`). Pulls are read-only against the source by
 * contract; the durable output is a canonical-doc update written at distill
 * time by the sleep flow — the cache is ephemeral working material, never a
 * knowledge copy (federation staleness lesson).
 *
 * `clickup` is the first ready-made kind. Its scope is COMMENTS + newly
 * created tasks only: task state (status/assignees/fields) belongs to the
 * task-sync backend, and double-writing it would corrupt mirror integrity.
 */

export const CONNECTOR_KINDS = ['clickup'] as const;
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number];

export class ConnectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectorError';
  }
}

/** One ClickUp list feeding a connector. A connector may hold MANY. */
export interface ClickUpListRef {
  id: string;
  /** Display label for reports (falls back to the id). */
  name: string | null;
}

export interface ClickUpSource {
  kind: 'clickup';
  lists: ClickUpListRef[];
}

/** Discriminated union — future kinds (slack/http/script) slot in here. */
export type ConnectorSource = ClickUpSource;

/**
 * Pull cadence: due when EITHER trigger fires. `every_cycles` counts completed
 * sleep cycles since the last pull; `ttl_hours` is wall-clock. Neither set ⇒
 * `every_cycles: 1` (pull each sleep).
 */
export interface ConnectorCadence {
  every_cycles: number | null;
  ttl_hours: number | null;
}

/** Bounded both ways — event count AND total text size (Lab's history lesson). */
export interface ConnectorCaps {
  max_events: number;
  max_chars: number;
}

export interface ConnectorManifest {
  slug: string;
  title: string;
  source: ConnectorSource;
  cadence: ConnectorCadence;
  caps: ConnectorCaps;
  path: string;
  /** `## Learn` prose — what the distilling agent should extract vs ignore. */
  body: string;
}

/** One observed event. `id` is the dedup key across re-pulls. */
export interface ConnectorEvent {
  id: string;
  /** ISO timestamp (source server time). */
  t: string;
  kind: 'comment' | 'task';
  /** Which list produced it (name when known, else id). */
  list: string;
  /** The task the event belongs to. */
  task: string;
  author: string | null;
  text: string;
  link: string | null;
}

export interface PullRecord {
  pulledAt: string;
  added: number;
  pending: number;
  dropped: number;
  error: string | null;
}

export interface ConnectorCache {
  slug: string;
  /** ISO time of the last pull attempt. */
  pulledAt: string | null;
  /** Sleep-cycle count (completed sleeps) at the last pull — cadence anchor. */
  pulledCycle: number | null;
  /** Per-list provider watermark: ClickUp `date_updated` epoch-ms. */
  cursors: Record<string, number>;
  /** Events pulled but not yet distilled. An aborted cycle re-offers these. */
  events: ConnectorEvent[];
  /** ISO time the sleep flow last consumed (distilled + cleared) events. */
  consumedAt: string | null;
  history: PullRecord[];
  error: string | null;
  errorAt: string | null;
}

export const DEFAULT_EVERY_CYCLES = 1;
export const DEFAULT_MAX_EVENTS = 100;
export const DEFAULT_MAX_CHARS = 20_000;
/** Kept pull-history entries per connector. */
export const MAX_HISTORY = 20;
/** First pull on a fresh cursor reaches back this far, no further. */
export const DEFAULT_BACKFILL_MS = 7 * 24 * 60 * 60 * 1000;
