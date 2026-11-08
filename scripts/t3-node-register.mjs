// `node --import ./scripts/t3-node-register.mjs`: installs scripts/t3-node-hooks.mjs (test-only).
import { register } from 'node:module';

register('./t3-node-hooks.mjs', import.meta.url);
