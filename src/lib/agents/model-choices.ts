import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sanitizeModel } from '../claude-args.js';
import { modelOptionsFrom } from '../model-list.js';
import { EFFORT_LEVELS, type EffortLevel, type SpawnModelOverride } from '../automations/types.js';

/**
 * What an owner may pick as an agent's TEMPORARY model (AI Team): the same model list the Chat
 * composer's menu shows (`modelOptionsFrom`, behind `GET /api/agent/model-config`) and the
 * effort levels a manifest may carry. One source, so the menu can never offer a model the
 * server then refuses.
 *
 * When `src/lib/model-facts.ts` lands (the model facts table), delegate the model list to it
 * here; nothing else reads this list for validation.
 */
export interface AgentModelChoices {
  models: string[];
  efforts: EffortLevel[];
}

export function agentModelChoices(home: string = homedir()): AgentModelChoices {
  let globalJson: Record<string, unknown> | null = null;
  try {
    globalJson = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf-8')) as Record<string, unknown>;
  } catch {
    // no file, or not JSON: the base list stands
  }
  return { models: modelOptionsFrom(globalJson).map((m) => m.id), efforts: [...EFFORT_LEVELS] };
}

export type ModelOverrideParse =
  | { ok: true; override: SpawnModelOverride | null }
  | { ok: false; message: string };

/**
 * A request body's optional `model` / `effort`, checked against {@link agentModelChoices}.
 * Absent, null or '' ⇒ no override for that field; both absent ⇒ `override: null`, so a
 * request without them is byte-for-byte what it always was. Anything else that is not on the
 * list is refused, never dropped: an owner who picked a model and silently got another is the
 * one outcome a temporary model must not have.
 */
export function parseModelOverride(
  body: { model?: unknown; effort?: unknown } | null | undefined,
  choices: AgentModelChoices,
): ModelOverrideParse {
  const raw = (v: unknown): string | null | undefined =>
    v === undefined || v === null || v === '' ? null : typeof v === 'string' ? v.trim() : undefined;
  const model = raw(body?.model);
  const effort = raw(body?.effort);
  if (model === undefined || (model !== null && (!sanitizeModel(model) || !choices.models.includes(model)))) {
    return { ok: false, message: `Unknown model. Pick one of: ${choices.models.join(', ')}.` };
  }
  if (effort === undefined || (effort !== null && !(choices.efforts as string[]).includes(effort))) {
    return { ok: false, message: `Unknown effort. Pick one of: ${choices.efforts.join(', ')}.` };
  }
  if (model === null && effort === null) return { ok: true, override: null };
  return { ok: true, override: { model, effort: effort as EffortLevel | null } };
}
