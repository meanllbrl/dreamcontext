/**
 * The ONE place the app writes down what a Claude model is, costs and is for.
 *
 * Every other list (the cost readout's prices, the context-window rule, the sleep model picker,
 * the composer's alias lists and one-line notes, the Super Agent guide's model table) either
 * derives from this file or is pinned to it by `tests/unit/model-facts.test.ts`. Changing a
 * number here fails that test until every mirror follows.
 *
 * A LEAF module: no disk, no process, no imports. The dashboard has its own tsconfig and keeps
 * mirrors; the test reads them.
 *
 * Prices: USD per million tokens, public API list prices, 5-minute cache-write rate.
 * Stated limit: Haiku 5.5's >100K-prompt price tier is not modelled (priced at the base tier).
 */

export const MODEL_FACTS_AS_OF = '2026-10-20';
export const MODEL_FACTS_SOURCE =
  'platform.claude.com/docs/en/about-claude/models/overview + /pricing';

export interface TokenPrice { in: number; out: number; cacheWrite: number; cacheRead: number }

export type ModelFamilyKey = 'opus' | 'sonnet' | 'haiku' | 'fable';
export type ModelEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ModelFact {
  family: ModelFamilyKey;
  /** The picker alias Claude Code resolves to the latest model of the family. */
  alias: ModelFamilyKey;
  id: string;
  label: string;
  /** 1 = fastest. */
  latencyRank: 1 | 2 | 3 | 4;
  latency: string;
  price: TokenPrice;
  defaultEffort: ModelEffort;
  contextWindow: number;
  /** One line: what this model is for. The composer's menu prints it under the row. */
  note: string;
  /** Offered by the sleep settings picker (Fable is a deliberate opt-out of the picker). */
  sleepOption: boolean;
}

/** Current generation, in the order the pickers list them. */
export const MODEL_FACTS: readonly ModelFact[] = Object.freeze([
  {
    family: 'opus', alias: 'opus', id: 'claude-opus-5-5', label: 'Opus 5.5',
    latencyRank: 3, latency: 'moderate',
    price: { in: 4, out: 20, cacheWrite: 5, cacheRead: 0.2 },
    defaultEffort: 'medium', contextWindow: 1_000_000,
    note: 'Long-running agentic coding and knowledge work.',
    sleepOption: true,
  },
  {
    family: 'sonnet', alias: 'sonnet', id: 'claude-sonnet-5-5', label: 'Sonnet 5.5',
    latencyRank: 2, latency: 'fast',
    price: { in: 2, out: 10, cacheWrite: 2.5, cacheRead: 0.1 },
    defaultEffort: 'high', contextWindow: 1_000_000,
    note: 'The best combination of speed and intelligence.',
    sleepOption: true,
  },
  {
    family: 'haiku', alias: 'haiku', id: 'claude-haiku-5-5', label: 'Haiku 5.5',
    latencyRank: 1, latency: 'fastest',
    price: { in: 0.1, out: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
    defaultEffort: 'medium', contextWindow: 1_000_000,
    note: 'High-volume, latency-sensitive work: classification, extraction, routing.',
    sleepOption: true,
  },
  {
    family: 'fable', alias: 'fable', id: 'claude-fable-5-1', label: 'Fable 5.1',
    latencyRank: 4, latency: 'slower',
    price: { in: 10, out: 50, cacheWrite: 12.5, cacheRead: 0.25 },
    defaultEffort: 'high', contextWindow: 1_000_000,
    note: 'Demanding reasoning and long-horizon agentic work.',
    sleepOption: false,
  },
]);

export const MODEL_ALIASES: readonly ModelFamilyKey[] = MODEL_FACTS.map((m) => m.alias);

/**
 * The model and effort a Super Agent session opens on when the owner has not picked one (owner,
 * 2026-10-21: its decisions matter). Its children and the notch Assistant keep their own
 * defaults. The server's `agent-ui.json` defaults read this; the dashboard mirrors it in
 * `dashboard/src/lib/agentSettings.ts` (pinned by `tests/unit/agent-settings.test.ts`).
 */
export const SUPER_AGENT_DEFAULT: Readonly<{ model: ModelFamilyKey; effort: ModelEffort }> =
  Object.freeze({ model: 'opus', effort: 'high' });

/**
 * The effort a Super Agent child opens on when the delegate names none (owner, 2026-10-22: xhigh
 * is for the few jobs that earn it). Without this the child inherits the owner's own global
 * setting, often xhigh. By mode: a Plan child reasons at `high`; a Develop child builds a
 * reviewed plan at `medium` (owner, 2026-10-24: measured, xhigh and high bought no fewer review
 * FAILs, the judges are pinned to high on their own); a basic one at `medium`. `high` for a
 * security, money or data-migration develop, and `xhigh` (a critical plan) or `max`, are only
 * ever an explicit `--effort`.
 */
export const CHILD_DEFAULT_EFFORT: Readonly<Record<'basic' | 'plan' | 'develop', ModelEffort>> =
  Object.freeze({ basic: 'medium', plan: 'high', develop: 'medium' });

export function childDefaultEffort(mode: string): ModelEffort {
  return CHILD_DEFAULT_EFFORT[mode as keyof typeof CHILD_DEFAULT_EFFORT] ?? 'medium';
}

export function factForFamily(family: string): ModelFact | undefined {
  return MODEL_FACTS.find((m) => m.family === family);
}

/** Older ids Claude Code still serves, each priced at its OWN rate. Ordered: first match wins,
 *  and the list is tried BEFORE the family rule so `claude-opus-5` never reads as Opus 5.5.
 *  `mythos` (any id not listed) is the Fable 5.1 row. */
export interface LegacyModelPrice { pattern: RegExp; price: TokenPrice }

const FABLE = factForFamily('fable') as ModelFact;

export const LEGACY_MODEL_PRICES: readonly LegacyModelPrice[] = Object.freeze([
  { pattern: /fable-5(?!-1)|mythos-5(?!-1)/, price: { in: 10, out: 50, cacheWrite: 12.5, cacheRead: 1 } },
  { pattern: /mythos/, price: FABLE.price },
  { pattern: /opus-5(?!-5)/, price: { in: 5, out: 25, cacheWrite: 6.25, cacheRead: 0.5 } },
  { pattern: /opus-4-[5-8]/, price: { in: 5, out: 25, cacheWrite: 6.25, cacheRead: 0.5 } },
  { pattern: /opus-4-[01]\b|opus-4-\d{8}|3-opus/, price: { in: 15, out: 75, cacheWrite: 18.75, cacheRead: 1.5 } },
  { pattern: /sonnet-5(?!-5)/, price: { in: 2, out: 10, cacheWrite: 2.5, cacheRead: 0.2 } },
  { pattern: /sonnet-4|3-[57]-sonnet/, price: { in: 3, out: 15, cacheWrite: 3.75, cacheRead: 0.3 } },
  { pattern: /haiku-4|haiku-3|3-haiku/, price: { in: 1, out: 5, cacheWrite: 1.25, cacheRead: 0.1 } },
]);

/** USD/MTok for any model id or alias. Legacy rows first, then the current family, then the
 *  current Opus (an unknown id is far more likely a NEW model than a retired one). */
export function priceForModelId(model: string): TokenPrice {
  const s = (model ?? '').toLowerCase();
  for (const row of LEGACY_MODEL_PRICES) if (row.pattern.test(s)) return row.price;
  const current = MODEL_FACTS.find((m) => s.includes(m.family) || s === m.id);
  return (current ?? (factForFamily('opus') as ModelFact)).price;
}

/** Ids whose context window is 200K rather than 1M: the Haiku 4.x/3 line, and the Opus/Sonnet
 *  generations before 4.6. Current Haiku 5.5 is 1M. MIRRORED in
 *  dashboard/src/lib/agentComposer.ts (pinned by model-facts.test.ts). */
export const SMALL_WINDOW_MODEL =
  /haiku-4|haiku-3|3-haiku|3-opus|3-[57]-sonnet|opus-4-[01]\b|opus-4-5\b|sonnet-4-[05]\b|-4-\d{8}/;

/** Sleep ids older builds wrote into `.config.json` and `sleep config set`: still accepted
 *  (an existence contract: a brain configured with `claude-opus-5` must keep working). */
export const LEGACY_SLEEP_MODEL_IDS = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'] as const;

/** What the sleep picker offers: the current ids of the families with `sleepOption`. */
export const SLEEP_MODEL_PICKER_IDS: readonly string[] =
  MODEL_FACTS.filter((m) => m.sleepOption).map((m) => m.id);

/** Every sleep model value accepted without `--allow-unknown`. */
export const KNOWN_SLEEP_MODEL_VALUES: readonly string[] = Object.freeze([
  ...MODEL_FACTS.map((m) => m.id),
  ...LEGACY_SLEEP_MODEL_IDS,
  ...MODEL_ALIASES,
]);
