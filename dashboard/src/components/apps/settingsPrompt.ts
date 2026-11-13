/**
 * What an installed app's settings hand Claude (owner 2026-11-13, app-kurulum-claude: "kişi bunu
 * girmez ki"; app-ux-genel K6: one line). A NEW chat tab named for the app gets one plain line in
 * the owner's language naming the app by its slug; Claude reads the fields, the author's hints and
 * the steps from `dreamcontext apps job <slug>` (src/lib/apps/share/job.ts), where the author's
 * text stays inside a block labelled as data (S5). Nothing of the author's text is in the line.
 * tests/unit/apps-settings-handoff.test.ts pins it.
 */

import type { Say } from './publishPrompt';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function settingsPrompt(slug: string, say: Say): string {
  if (!SLUG_RE.test(slug)) throw new Error('bad slug');
  return say('handoff.settings', { slug });
}
