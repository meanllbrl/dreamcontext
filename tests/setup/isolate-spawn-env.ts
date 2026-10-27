import { scrubSpawnEnv } from '../../src/lib/session-origin.js';
import { setCapacityFactsForTests } from '../../src/lib/super/capacity.js';
import { setMcpHomeRedirectForTests } from '../../src/lib/mcp-store.js';
import { mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

// The suite must score sessions the same whether a human or a spawned builder runs `npm test`.
//
// 1. A builder's own spawn marker (DREAMCONTEXT_SPAWNED, an automation run id, background
//    sleep) would be inherited by every hook process the integration tests launch, marking each
//    one spawned. Scrub them.
// 2. The ancestry walk stops at DREAMCONTEXT_SERVER_PID. A pane-inherited boundary sits above
//    the builder's claude, so it must be overwritten, not defaulted: a goal-skill builder is a
//    plain `claude -p` child of a Chat pane and inherits the server's pid, and the hook children
//    would then walk vitest -> npm -> claude(builder) -> claude(pane) -> server, count two
//    claudes and score every human-path Stop 0. Bounding the walk at this worker keeps it inside
//    the test (the same mechanism as tests/integration/hook.test.ts's explicit SERVER_PID).
scrubSpawnEnv(process.env);
process.env.DREAMCONTEXT_SERVER_PID = String(process.pid);

// 3. `super delegate` holds a job when THIS machine is short of room (orchestration plan r5 D11).
//    The suite must not pass or fail by the developer's swap: every test sees a roomy machine
//    unless it sets its own facts (`setCapacityFactsForTests`), or injects readers.
setCapacityFactsForTests({
  availMemGb: 12, diskFreeGb: 200, load1: 1, totalMemGb: 32, swapUsedGb: 0, swapTotalGb: 4, claudeSessions: 1, heavySteps: 0,
});

// 4. Every chat, terminal or automation spawn syncs the MCP stores (task mcp-management). A test
//    that spawns without faking HOME must not migrate the developer's REAL stores or delete the
//    retired mirror: writes aimed at the real home land in a throwaway dir. Tests that fake HOME
//    (or pass one) are untouched.
setMcpHomeRedirectForTests(homedir(), mkdtempSync(join(tmpdir(), 'dc-test-mcp-home-')));
