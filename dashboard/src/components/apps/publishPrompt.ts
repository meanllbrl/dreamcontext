/**
 * What the Share click hands Claude (owner 2026-11-06, yayinla-claude: no publish form; app-ux-genel
 * K6: one line). The click opens a one-hour grant for this app on the server; a NEW chat tab gets
 * one plain line in the owner's language naming the app by its slug and the grant, and Claude reads
 * the steps from `dreamcontext apps job <slug> --grant <id>` (src/lib/apps/share/job.ts), so the
 * bubble is what the owner would say, never a page of English CLI text in his name.
 *
 * Only the slug ([a-z0-9-]) and the grant (base64url) are in the line: the app's name, which can
 * come from another author's manifest, never is. tests/unit/apps-publish-handoff.test.ts pins it.
 */

export type Say = (key: string, vars?: Record<string, string>) => string;

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const GRANT_RE = /^[A-Za-z0-9_-]{10,64}$/;

export interface PublishHandoff {
  slug: string;
  grant: string;
  /** A published app's new version ("Güncellemeyi yayınla"): who sees it stays as it is. */
  update?: boolean;
}

export function publishPrompt(h: PublishHandoff, say: Say): string {
  if (!SLUG_RE.test(h.slug)) throw new Error('bad slug');
  if (!GRANT_RE.test(h.grant)) throw new Error('bad grant');
  return say(h.update ? 'handoff.publishUpdate' : 'handoff.publish', { slug: h.slug, grant: h.grant });
}
