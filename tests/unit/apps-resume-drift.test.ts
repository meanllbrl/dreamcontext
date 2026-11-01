import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * An app conversation runs only in its envelope, so every path that resumes a session has to ask
 * `appChatRefusal` (or go through `startChatSession`). A new resume path fails here until it is
 * added on purpose.
 */

const GUARDED: Record<string, RegExp> = {
  'src/server/routes/agent-chat.ts': /lookupAppChatOf/,
  'src/server/routes/agent-terminal.ts': /appChatRefusal/,
  'src/lib/builder-spawn.ts': /assertNotAppChat/,
  'src/lib/automations/verdict.ts': /assertNotAppChat/,
  'src/lib/automations/runner.ts': /assertNotAppChat/,
};
/** Their ids are tool threads, or the flag is another program's. */
const NOT_A_CLAUDE_RESUME = new Set([
  'src/cli/commands/tasks.ts', 'src/cli/commands/brain.ts', 'src/cli/commands/t3-chat.ts', 'src/lib/task-objection.ts',
  'src/lib/t3-bridge/spawn.ts', 'src/lib/t3-bridge/headless-envelope.ts',
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (p.startsWith('src/vendor') || p.startsWith('src/dashboard')) continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('every resume flag in src/', () => {
  const code = (f: string) => readFileSync(f, 'utf-8').split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
  const hits = walk('src').filter((f) => /['"]--resume['"]|--resume \$\{/.test(code(f)));
  it('is on the list', () => {
    for (const f of hits) expect(f in GUARDED || NOT_A_CLAUDE_RESUME.has(f), `${f} resumes a session: send it through appChatRefusal`).toBe(true);
  });
  it.each(Object.entries(GUARDED))('%s asks', (f, re) => {
    expect(readFileSync(f, 'utf-8')).toMatch(re);
  });
});
