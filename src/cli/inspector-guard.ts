import { OWNER_KEY_STDIN_ENV, refuseInspectorSignal } from '../server/owner-key.js';

/**
 * The first import of the built entry (`src/cli/bin.ts`, run before the CLI bundle is even
 * compiled) and of `src/cli/index.ts`, so the first code: on a Node without `--disable-sigusr1`
 * the window in which SIGUSR1 opens an inspector ends here, not when the server starts
 * (owner-key.ts). Running twice only adds a second no-op listener.
 */
if (process.env[OWNER_KEY_STDIN_ENV] === '1') refuseInspectorSignal();
