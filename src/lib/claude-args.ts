/**
 * claude-args — argument gates shared by every site that spawns `claude`.
 *
 * A LEAF module (no side effects, no disk, no process) so both the server
 * routes and `src/lib` config code can import it. `sanitizeModel` used to live
 * in `src/server/routes/agent-spawn-shared.ts`; it moved here when the sleep
 * settings block (`.config.json` `sleep.specialists[].model`) had to gate model
 * ids too — `src/lib` must not import from `src/server`, and a SECOND copy of
 * the regex is exactly the drift this move exists to prevent.
 */

/** Strict model-token gate. Claude Code's `--model` takes an alias (`opus`/`sonnet`/
 *  `haiku`) or a full model id — all of which are `[A-Za-z0-9._-]`. Anything with a shell
 *  metacharacter, whitespace, or over 64 chars is rejected to '' (no flag), so the value is
 *  safe to interpolate into the `claude` shell command. Never trusts the client. */
export function sanitizeModel(v: string | null): string {
  return v && v.length <= 64 && /^[A-Za-z0-9._-]+$/.test(v) ? v : '';
}
