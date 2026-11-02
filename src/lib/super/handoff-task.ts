import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_FILE_BYTES, MEMBER_SUPER_DIR, okMember, superRecordPath } from './store.js';
import { superHandoffFileOf, superHandoffTask } from './handoff-file.js';

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
  /** Whose handoff it is (plan-r10 1): `main`, or a member Super's `m:<slug>` (its own file). */
  superId?: 'main' | `m:${string}`;
}

/** One record read synchronously through the store's guards (no link, a file, not oversize). */
function readRecord(path: string): { session?: unknown; enabled?: unknown; children?: Record<string, { endedAt?: unknown }> } | null {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch { return null; }
}

/**
 * Is this the vault's recorded super session, and is it handed over (`enabled`)? Then its
 * handoff context. A taken-back super is not the Super Agent any more: null.
 */
export function superHandoffContext(contextRoot: string, ids: ReadonlyArray<string | null | undefined>): SuperHandoffContext | null {
  // Main's record first, then each member Super's (plan-r10 1), through the one accessor.
  const candidates: Array<{ superId: 'main' | `m:${string}`; path: string }> = [{ superId: 'main', path: superRecordPath(contextRoot, 'main') }];
  try {
    const dir = join(contextRoot, MEMBER_SUPER_DIR);
    if (!lstatSync(join(contextRoot, 'state', '.super')).isSymbolicLink() && !lstatSync(dir).isSymbolicLink()) {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.json') || name.endsWith('.read-marks.json')) continue;
        const slug = name.slice(0, -'.json'.length);
        if (!okMember(slug)) continue;
        candidates.push({ superId: `m:${slug}`, path: superRecordPath(contextRoot, `m:${slug}`) });
      }
    }
  } catch { /* no members folder */ }
  for (const c of candidates) {
    const raw = readRecord(c.path);
    const session = typeof raw?.session === 'string' ? raw.session : null;
    if (!raw || !session || raw.enabled !== true || !ids.some((id) => id === session)) continue;
    const children: string[] = [];
    for (const [sid, ch] of Object.entries(raw.children ?? {})) {
      if (ch?.endedAt === undefined) children.push(sid);
    }
    return c.superId === 'main' ? { children } : { children, superId: c.superId };
  }
  return null;
}

/** The ONE command the super hands off with, every part spelled out. */
export function superHandoffCommand(fields: ReadonlyArray<{ flag: string; hint: string }>): string {
  return `dreamcontext super handoff ${fields.map((f) => `${f.flag} "<${f.hint}>"`).join(' ')}`;
}

/** The line the super's nudge ends with. */
export function superNudgeLine(ctx: SuperHandoffContext): string {
  const kids = ctx.children.length ? ctx.children.join(', ') : 'none';
  return `You are the Super Agent: your handoff goes into YOUR file, ${superHandoffFileOf(superHandoffTask(ctx.superId ?? 'main'))}, never into a task (each child hands off its own). Put your live children in --next with what each one does: ${kids}.`;
}
