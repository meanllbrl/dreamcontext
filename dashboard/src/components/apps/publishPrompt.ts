/**
 * What the Publish click hands Claude (owner 2026-11-06, yayinla-claude): no publish form. The
 * click opens a one-hour grant for this app on the server; this prompt lands in Chat with it, and
 * Claude does the whole publish: reads what goes out, cleans the app's own copy, writes the store
 * README and the settings template, runs the gate last, and publishes with the CLI.
 *
 * Plain English for the agent, like the other Apps-page asks (`store.ask.*`). The steps live here
 * AND in the /apps skill's references/sharing.md, so the prompt works even when the skill is not
 * loaded; tests/unit/apps-publish-handoff.test.ts pins both.
 */

export interface PublishHandoff {
  slug: string;
  name: string;
  grant: string;
  /** What the owner clicked: Share (people he invites) or "Share publicly" (for good). */
  visibility: 'private' | 'public';
  /** Published before: a new version. */
  published?: { fullName: string; public: boolean } | null;
  /** "Güncellemeyi yayınla" (app-onay-karti): a new version of a published app, same people. */
  update?: boolean;
}

/**
 * The prompt itself. Only the slug ([a-z0-9-]) and the grant (base64url) go on a command line;
 * the app's name, which can come from another author's manifest, never does.
 */
export function publishPrompt(h: PublishHandoff): string {
  if (h.update && h.published) return updatePrompt(h, h.published);
  const pub = h.visibility === 'public';
  const again = h.published ? `It is already on GitHub as ${h.published.fullName}: this is a new version.` : 'It has never been published.';
  const who = pub ? 'Public: anyone with the link, for good (I chose "Share publicly").' : 'Private: people I invite (I chose Share).';
  return [
    `/apps Publish the app "${h.name}" (${h.slug}). I pressed Share: do the whole publish yourself, by the /apps skill's references/sharing.md. ${who} ${again}`,
    '',
    `1. Read every file that would go out: \`dreamcontext apps publish ${h.slug}${pub ? ' --public' : ''}\` lists them. Open each one; look at the pixels of every image and screenshot.`,
    '2. Find personal or business data: names, customers, e-mails, keys, real numbers, home paths, account ids, sample data that is real. Clean it in the app\'s own folder (a fixed target moves into the manifest `config` template; sample data becomes made up) and commit.',
    '3. Write or refresh README.md, the store page: the tagline, What it does, Screenshots (at most 3 in store/, nothing personal). Commit. What\'s new comes from --note.',
    `4. Run \`dreamcontext apps publish ${h.slug}${pub ? ' --public' : ''}\` again: the gate is the last hard stop. Fix every block in the app; never work around one.`,
    `5. Ask me ONE question, only for what you cannot decide: ${pub ? '' : 'the GitHub usernames to invite, '}what changed in one line if you cannot tell, and the generic-word lines from the report I may let go.`,
    `6. Publish, giving the command a 10 minute timeout: \`dreamcontext apps publish ${h.slug} --go --grant ${h.grant}${pub ? ' --public' : ''} --note "<what changed>"${pub ? '' : ' [--invite <logins>]'} [--approve <ids>]\`. The grant is for this app, one publish, one hour. Cut off or an error: run the SAME command again, it is safe (it publishes, or says it already went out or is still running: then stop). Only when it says the grant ran out or is not it, ask me to press Share again and use the new grant (your work stays).`,
    '7. End with a short plain list: what you cleaned, what went out, where.',
  ].join('\n');
}

/**
 * The band's "Güncellemeyi yayınla": the app is published and its files changed since. Who sees
 * it and who is invited stay as they were, so the prompt never asks about them; only what goes
 * out, the store page's What's new, the gate and the push.
 */
function updatePrompt(h: PublishHandoff, published: { fullName: string; public: boolean }): string {
  const pub = published.public;
  return [
    `/apps Publish the new version of the app "${h.name}" (${h.slug}). I pressed "Güncellemeyi yayınla": it is already on GitHub as ${published.fullName}, ${pub ? 'public' : 'private'}, and stays exactly that. Do not ask me about visibility or invitees.`,
    '',
    `1. See what changed since the last publish: \`dreamcontext apps publish ${h.slug}${pub ? ' --public' : ''}\` lists the changed files. Open each one; look at the pixels of every image.`,
    '2. Find personal or business data in them: names, customers, e-mails, keys, real numbers, home paths, account ids. Clean it in the app\'s own folder and commit.',
    `3. Run \`dreamcontext apps publish ${h.slug}${pub ? ' --public' : ''}\` again: the gate is the last hard stop. Fix every block in the app; never work around one.`,
    '4. Ask me ONE question only if you cannot tell what changed, or for the generic-word lines from the report I may let go.',
    `5. Publish, giving the command a 10 minute timeout: \`dreamcontext apps publish ${h.slug} --go --grant ${h.grant}${pub ? ' --public' : ''} --note "<what changed>" [--approve <ids>]\`. The grant is for this app, one publish, one hour. Cut off or an error: run the SAME command again, it is safe. Only when it says the grant ran out or is not it, ask me to press the button again.`,
    '6. End with a short plain list: what changed, what went out, where.',
  ].join('\n');
}
