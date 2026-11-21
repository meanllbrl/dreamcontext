import type { Command } from 'commander';
import { AGENT_SLICE_S, ciWait, realGh } from '../../lib/ci-wait.js';
import { inAgentSession } from '../../lib/session-id.js';
import { findTool } from '../../lib/tool-finder.js';

export function registerCiCommand(program: Command): void {
  const ci = program
    .command('ci')
    .description('Continuous integration from an agent session, without holding it past the shell tool\'s ceiling');

  ci
    .command('wait')
    .argument('[run-id]', 'The GitHub Actions run id (digits)')
    .option('--branch <branch>', 'Wait on the newest run of this branch instead')
    .option('--sha <sha>', 'With --branch: the run of this commit')
    .option('--slice <seconds>', `How long this call may wait (in an agent session at most ${AGENT_SLICE_S}, the default)`)
    .description(`Wait for a CI run to finish, polling gh run view (never gh run watch): exit 0 = green, 1 = red (failed jobs and the failed log, as data), 4 = still running after the slice (run the same command again), 2 = bad input or no gh. In an agent session a call stops at ${AGENT_SLICE_S}s, before the 600 s tool ceiling. Never reruns a run`)
    .action(async (runId: string | undefined, opts: { branch?: string; sha?: string; slice?: string }) => {
      const r = await ciWait({ runId, branch: opts.branch, sha: opts.sha, slice: opts.slice }, {
        gh: realGh(findTool(['gh'])),
        now: Date.now,
        sleep: (ms) => new Promise((done) => { setTimeout(done, ms); }),
        inAgent: inAgentSession(),
      });
      for (const l of r.lines) (r.exit === 0 ? process.stdout : process.stderr).write(`${l}\n`);
      process.exitCode = r.exit;
    });
}
