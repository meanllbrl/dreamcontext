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
  name: string;
  grant: string;
  /** What the owner clicked: Share (people he invites) or "Share publicly" (for good). */
  visibility: 'private' | 'public';
  /** Published before: a new version. */
  published?: { fullName: string; public: boolean } | null;
  /** A published app's new version ("Güncellemeyi yayınla"): who sees it stays as it is. */
  update?: boolean;
}

export function publishPrompt(h: PublishHandoff, say: Say): string {
  if (!SLUG_RE.test(h.slug)) throw new Error('bad slug');
  if (!GRANT_RE.test(h.grant)) throw new Error('bad grant');
  return say(h.update ? 'handoff.publishUpdate' : 'handoff.publish', { slug: h.slug, grant: h.grant });
}

/** The app's name on one line, no control or sentinel characters: it can come from another
 *  author's manifest and lands inside a message the Super reads. */
function oneLineName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f\u007f\u2028\u2029\ue0a7]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

/**
 * The same publish, handed to the project's Super Agent (owner 2026-11-13, paylas-prompt): he
 * works on the Super's screen, so a publish started in a Window tab ran where he never looked,
 * and every press started another one. The Super runs it as ONE child he sees on its stage,
 * reports back, and a second press while one runs shows that child instead of starting another.
 */
export function superPublishAsk(h: PublishHandoff, say: Say): string {
  const name = oneLineName(h.name);
  const brief = publishPrompt({ ...h, name }, say);
  return [
    `I pressed Share on the app "${name}" (${h.slug}) on the Apps page. Run this publish as ONE child of yours that I can see on your stage (develop mode, no worktree: the app has its own folder), and tell me when it is done or needs me.`,
    `One publish per app at a time: if a child of yours is already publishing ${h.slug}, do not start another; show me that one and give it the new grant below only if it asks for one.`,
    '',
    'The child\'s brief, word for word:',
    '',
    brief,
  ].join('\n');
}
