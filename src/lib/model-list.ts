/**
 * The models a picker offers, from ONE list.
 *
 * Two places read it: the Chat composer's model menu (`GET /api/agent/model-config`, which adds
 * prices and the user's defaults) and the AI Team's temporary model, which validates an owner's
 * pick against it before a spawn. A second copy of the list is exactly the drift that would let
 * the menu offer a model the server then refuses.
 *
 * A LEAF module: no disk, no process. The caller reads `~/.claude.json` and passes it in.
 */

import { MODEL_FACTS } from './model-facts.js';

export interface ModelOption {
  id: string;
  label: string;
}

/** The aliases every Claude Code install understands. */
export const BASE_MODEL_OPTIONS: readonly ModelOption[] = Object.freeze(
  MODEL_FACTS.map((m) => ({ id: m.alias, label: m.alias.charAt(0).toUpperCase() + m.alias.slice(1) })),
);

/** Map any full model id / alias to our short alias bucket (opus/sonnet/haiku/fable). */
export function modelAlias(full: string): string {
  const s = (full || '').toLowerCase();
  for (const m of MODEL_FACTS) if (s.includes(m.family)) return m.alias;
  return full || '';
}

/**
 * The base list plus the extra models the CLI itself has cached as available
 * (`additionalModelOptionsCache` in `~/.claude.json`), deduped by alias. `globalJson` is that
 * file parsed, or null when it could not be read.
 */
export function modelOptionsFrom(globalJson: Record<string, unknown> | null): ModelOption[] {
  const cache = globalJson?.additionalModelOptionsCache;
  const extras: ModelOption[] = Array.isArray(cache)
    ? cache
        .map((m) => {
          const v = String((m as { value?: unknown })?.value ?? '');
          const id = modelAlias(v);
          return { id, label: String((m as { label?: unknown })?.label ?? id) };
        })
        .filter((m) => m.id)
    : [];
  const seen = new Set(BASE_MODEL_OPTIONS.map((m) => m.id));
  const models = BASE_MODEL_OPTIONS.map((m) => ({ ...m }));
  for (const e of extras) if (!seen.has(e.id)) { seen.add(e.id); models.push(e); }
  return models;
}
