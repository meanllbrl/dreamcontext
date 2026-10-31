import { OWNER_KEY_STDIN_ENV, refuseInspectorSignal } from '../server/owner-key.js';

/**
 * The bundle's first module, so its first code: on a Node without `--disable-sigusr1` the window
 * in which SIGUSR1 opens an inspector ends here, not when the server starts (owner-key.ts).
 */
if (process.env[OWNER_KEY_STDIN_ENV] === '1') refuseInspectorSignal();
