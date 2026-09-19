/**
 * DRIFT LOCK — the secret card's constants have ONE owner (`src/lib/env-secrets.ts`, which
 * is what the server validates a submitted body against) and are MIRRORED into
 * `dashboard/src/lib/chatViewSpec.ts` because the dashboard is a separate bundle and cannot
 * import from `src/`.
 *
 * A mirror that drifts here is not cosmetic: the card would draw a field the server then
 * refuses, or accept a `.env.<something>` path the writer will not write — a submit that
 * fails after the user has already pasted their key. This test reads BOTH files as text and
 * fails the moment the two disagree. See `knowledge/patterns/mirror-with-drift-test.md`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const owner = readFileSync(join(ROOT, 'src/lib/env-secrets.ts'), 'utf-8');
const mirror = readFileSync(join(ROOT, 'dashboard/src/lib/chatViewSpec.ts'), 'utf-8');
const runOwner = readFileSync(join(ROOT, 'src/server/routes/agent-spawn-shared.ts'), 'utf-8');

/** The literal right-hand side of `export const <name> = <value>;`, as written. */
function constant(source: string, name: string): string {
  const m = new RegExp(`export const ${name} = ([^;]+);`).exec(source);
  if (!m) throw new Error(`${name} not found — did it get renamed or reshaped?`);
  return m[1].trim();
}

describe('secret-card constants stay mirrored', () => {
  it.each(['ENV_KEY_RE', 'SECRET_FILE_RE', 'MAX_SECRET_FIELDS', 'MAX_SECRET_VALUE_CHARS', 'DEFAULT_SECRET_FILE'])(
    '%s matches src/lib/env-secrets.ts',
    (name) => {
      expect(constant(mirror, name)).toBe(constant(owner, name));
    },
  );
});

describe('run-card command cap stays mirrored', () => {
  it('MAX_RUN_COMMAND_CHARS matches the server\'s MAX_EXEC_COMMAND_CHARS', () => {
    // Same number, different names on purpose: the client's is "what a card will DRAW", the
    // server's is "what a PTY will RUN". If they ever disagree, a card offers a ▶ on a
    // command the bridge then truncates — which would run a DIFFERENT command than the one
    // the user read, and that is the one outcome the run card may never have.
    expect(constant(mirror, 'MAX_RUN_COMMAND_CHARS')).toBe(constant(runOwner, 'MAX_EXEC_COMMAND_CHARS'));
  });
});
