/**
 * Child-process helper for the plan ledger's cross-process test (plan-ledger.test.ts). Spawned
 * via vite-node so the REAL `plan packet` / `plan record` run in separate OS processes against
 * one plan folder at the same time.
 *
 * argv: <contextRoot> <plan> <packet|record> <lens>
 */
import { join } from 'node:path';
import { planPacket, planRecord } from '../../src/cli/commands/plan.js';
import { LocalTaskBackend } from '../../src/lib/task-backend/local.js';

const [, , root, plan, verb, lens] = process.argv;
const backend = new LocalTaskBackend(join(root, 'state'));
const deps = { root, now: () => new Date(), backend: () => backend };

try {
  if (verb === 'packet') {
    const r = await planPacket(deps, plan, lens);
    console.log(JSON.stringify({ ok: true, round: r.round, opened: r.opened }));
  } else {
    const out = await planRecord(deps, plan, lens, {});
    console.log(JSON.stringify({ ok: true, out }));
  }
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: (err as Error).message }));
}
