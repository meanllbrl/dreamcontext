// `node --import ./ts-register.mjs <file>.ts`: see ts-hooks.mjs.
import { register } from 'node:module';

register('./ts-hooks.mjs', import.meta.url);
