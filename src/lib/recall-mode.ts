/**
 * Recall modes — the single source of truth for every consumer (the always-on
 * hook, `memory recall`, `/api/recall`, the sleep route, chat spawns). The
 * dashboard mirrors this list in SettingsPage (drift-tested).
 *
 * `hybrid` (BM25 + local dense embeddings) is the default; it falls back to
 * plain BM25 on its own when the model or index is not ready. `raw` is
 * BM25-only, `off` disables injection.
 */
export const RECALL_MODES = ['hybrid', 'raw', 'off'] as const;
export type RecallMode = typeof RECALL_MODES[number];

export const DEFAULT_RECALL_MODE: RecallMode = 'hybrid';

/** The retired LLM-picks-docs mode. Persisted vaults and env vars may still say it. */
const LEGACY_HAIKU_MODE = 'haiku';

/** True for a value `PATCH /api/sleep` should accept: a current mode or the retired `haiku`. */
export function isAcceptedRecallModeInput(value: unknown): boolean {
  return value === LEGACY_HAIKU_MODE || (RECALL_MODES as readonly unknown[]).includes(value);
}

/**
 * Map any stored/env value to a live mode. The retired `haiku`, a missing value
 * and garbage all become the default (`hybrid`) — never `off`, so an old vault
 * keeps injecting memory.
 */
export function normalizeRecallMode(value: unknown): RecallMode {
  return (RECALL_MODES as readonly unknown[]).includes(value)
    ? (value as RecallMode)
    : DEFAULT_RECALL_MODE;
}
