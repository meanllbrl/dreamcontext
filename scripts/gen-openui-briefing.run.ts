/** Writes what `gen-openui-briefing.ts` renders. Kept apart so importing the generator (from
 *  the drift test) can never write to the working tree. */
import { writeFileSync } from 'node:fs';
import { renderGeneratedFile, OPENUI_GENERATED_PATH } from './gen-openui-briefing.js';

writeFileSync(OPENUI_GENERATED_PATH, renderGeneratedFile(), 'utf-8');
console.log('wrote ' + OPENUI_GENERATED_PATH);
