/**
 * Freezes the BEFORE arm: what a Super Agent and an ordinary Chat tab were handed before the AI
 * Team routing change (dreamcontext 0.36.1, main/main 5ccb9b3b). Run ONCE, on that code, before
 * any edit; it refuses to overwrite. The files in frozen/ are the baseline the eval's `before`
 * arm replays and the unit test diffs the team-less spawn prompt against.
 *
 *   npx vite-node eval/super-team-routing/freeze.ts
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPER_ORCHESTRATION_GUIDE_PATH, superBriefing } from '../../src/server/chat-modes.js';
import { chatSubagents } from '../../src/lib/automations/chat-subagents.js';
import { makeTeamProject } from './setup.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'frozen');
const files = ['super-briefing.md', 'roster.md', 'agents.json', 'guide.md'];
if (files.some((f) => existsSync(join(OUT, f)))) {
  console.error('frozen/ already holds the baseline: it is never re-frozen from changed code.');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });
const root = mkdtempSync(join(tmpdir(), 'super-team-freeze-'));
try {
  const t = makeTeamProject(root, { team: true });
  const sub = chatSubagents(t.contextRoot, { home: t.home });
  if (!sub) throw new Error('the fixture team has no callable agent');
  writeFileSync(join(OUT, 'super-briefing.md'), superBriefing(SUPER_ORCHESTRATION_GUIDE_PATH));
  writeFileSync(join(OUT, 'roster.md'), sub.roster);
  writeFileSync(join(OUT, 'agents.json'), `${JSON.stringify(sub.agents, null, 2)}\n`);
  writeFileSync(join(OUT, 'guide.md'), readFileSync(resolve(HERE, '..', '..', 'skill', 'references', 'super-orchestration.md')));
  console.log(`frozen: ${files.join(', ')}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
