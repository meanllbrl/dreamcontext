import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SUPER_STATE_REL } from './store.js';
import { SUPER_HANDOFF_REL } from './handoff-file.js';

/**
 * The context handoff in a SUPER session. The Super Agent hands off into its OWN file,
 * `state/.super/handoff.md` (super/handoff-file.ts), through `dreamcontext super handoff` — never
 * into a task (owner 2026-10-22), and never into a child's task (field 2026-10-21: the hook once
 * named a child's task for the super's own handoff).
 *
 * Read synchronously and defensively: this runs inside a hook that must never break a tool call.
 */

export interface SuperHandoffContext {
  /** Its live children, for the handoff's --next. */
  children: string[];
}

/**
 * Is this the vault's recorded super session, and is it handed over (`enabled`)? Then its
 * handoff context. A taken-back super is not the Super Agent any more: null.
 */
export function superHandoffContext(contextRoot: string, ids: ReadonlyArray<string | null | undefined>): SuperHandoffContext | null {
  let raw: { session?: unknown; enabled?: unknown; children?: Record<string, { endedAt?: unknown }> };
  try { raw = JSON.parse(readFileSync(join(contextRoot, SUPER_STATE_REL), 'utf-8')); } catch { return null; }
  const session = typeof raw?.session === 'string' ? raw.session : null;
  if (!session || raw.enabled !== true || !ids.some((id) => id === session)) return null;
  const children: string[] = [];
  for (const [sid, ch] of Object.entries(raw.children ?? {})) {
    if (ch?.endedAt === undefined) children.push(sid);
  }
  return { children };
}

/** The ONE command the super hands off with, every part spelled out. */
export function superHandoffCommand(fields: ReadonlyArray<{ flag: string; hint: string }>): string {
  return `dreamcontext super handoff ${fields.map((f) => `${f.flag} "<${f.hint}>"`).join(' ')}`;
}

/** The line the super's nudge ends with. */
export function superNudgeLine(ctx: SuperHandoffContext): string {
  const kids = ctx.children.length ? ctx.children.join(', ') : 'none';
  return `You are the Super Agent: your handoff goes into YOUR file, _dream_context/${SUPER_HANDOFF_REL.split('\\').join('/')}, never into a task (each child hands off its own). Put your live children in --next with what each one does: ${kids}.`;
}
