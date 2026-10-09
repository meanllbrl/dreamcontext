import { scrubSpawnEnv } from '../../src/lib/session-origin.js';

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

// 3. Hybrid recall is the default mode, so the commands the suite drives in temp vaults (init,
//    update, a SessionStart hook, `sleep done`) would otherwise start downloading the embedding
//    model and building an index. No test may do that: provisioning is off for the whole run,
//    in this process and in every child that inherits process.env. The tests that exercise
//    provisioning itself (embed-provision.test.ts, hook-hybrid-fallback.test.ts) clear it
//    explicitly, in a temp HOME.
process.env.DREAMCONTEXT_EMBED_AUTO = '0';
