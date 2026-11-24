import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Sub-agents never run on Fable (soul rule; plan super-cocuk-tasarruf D5). Measured 2026-11-22:
 * 17 sub-agents ran on Fable ($117), every one dispatched with no model under a Fable parent, so
 * it inherited the parent's. The PreToolUse(Agent) hook rewrites the model in exactly two cases,
 * both to `opus`; everything else is left as dispatched (no cost rise under a cheaper parent).
 */

/** Claude Code's own agent types: no definition file, so they inherit the parent's model. */
const BUILT_IN_TYPES = new Set(['general-purpose', 'explore', 'plan', 'statusline-setup', 'claude']);

const SAFE_TYPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

const isFable = (m: string | null | undefined): boolean => typeof m === 'string' && /fable/i.test(m);

/** The `model:` of an agent definition file's frontmatter, or null for none. A symlink or an
 *  unreadable file reads as not found. */
function frontmatterModel(path: string): string | null | undefined {
  try {
    if (!lstatSync(path).isFile()) return undefined;
    const text = readFileSync(path, 'utf-8');
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (!fm) return null;
    const line = /^model:\s*(.*)$/m.exec(fm[1]!);
    const v = line ? line[1]!.trim().replace(/^["']|["']$/g, '') : '';
    return v || null;
  } catch {
    return undefined;
  }
}

/**
 * What an agent type's own definition says about its model: a model name, `'none'` (no model
 * of its own: `inherit`, no `model:` line, or a built-in type), or `'unknown'` (a plugin type,
 * or a name no definition was found for). Project `.claude/agents` first, then the user's.
 */
export function agentDefinitionModel(subagentType: string, cwd: string, home: string): string | 'none' | 'unknown' {
  const type = subagentType.trim();
  if (!type) return 'none'; // Claude Code's default dispatch is general-purpose
  if (type.includes(':')) return 'unknown';
  if (!SAFE_TYPE.test(type)) return 'unknown';
  for (const dir of [join(cwd, '.claude', 'agents'), join(home, '.claude', 'agents')]) {
    const m = frontmatterModel(join(dir, `${type}.md`));
    if (m === undefined) continue;
    if (m === null || m.toLowerCase() === 'inherit') return 'none';
    return m;
  }
  return BUILT_IN_TYPES.has(type.toLowerCase()) ? 'none' : 'unknown';
}

/**
 * The model to put on a dispatch, or null to leave it untouched: `opus` for an explicit Fable
 * model, or for no model under a Fable parent when the agent has no model of its own.
 */
export function pinSubagentModel(input: {
  requested: string | null | undefined;
  definition: string | 'none' | 'unknown';
  parentModel: string | null | undefined;
}): 'opus' | null {
  const requested = typeof input.requested === 'string' ? input.requested.trim() : '';
  if (requested) return isFable(requested) ? 'opus' : null;
  if (input.definition === 'none' && isFable(input.parentModel)) return 'opus';
  return null;
}

/** The one line the pinned agent's prompt gains. */
export const MODEL_PIN_LINE = '[dreamcontext] This sub-agent runs on Opus, not Fable: sub-agents never run on Fable (project rule).';

/** The main chain's model from a transcript's last assistant record, or null. */
export function parentModelFrom(records: ReadonlyArray<Record<string, unknown>>): string | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]!;
    if (r.type !== 'assistant' || r.isSidechain === true) continue;
    const m = (r.message as { model?: unknown } | undefined)?.model;
    if (typeof m === 'string' && m && m !== '<synthetic>') return m;
  }
  return null;
}
