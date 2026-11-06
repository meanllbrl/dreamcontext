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
  /** Published before: same visibility, a new version. */
  published?: { fullName: string; public: boolean } | null;
}

/** The prompt itself. A slug is [a-z0-9-] and a grant base64url, so both are safe on a command line. */
export function publishPrompt(h: PublishHandoff): string {
  const again = h.published
    ? `It is already on GitHub as ${h.published.fullName} (${h.published.public ? 'public' : 'people I invite'}): this is a new version, same visibility.`
    : 'It has never been published.';
  return [
    `/apps Publish the app "${h.name}" (${h.slug}). I pressed Publish: do the whole publish yourself, by the /apps skill's references/sharing.md. ${again}`,
    '',
    `1. Read every file that would go out: \`dreamcontext apps publish ${h.slug}\` lists them. Open each one; look at the pixels of every image and screenshot.`,
    '2. Find personal or business data: names, customers, e-mails, keys, real numbers, home paths, account ids, sample data that is real. Clean it in the app\'s own folder (a fixed target moves into the manifest `config` template; sample data becomes made up) and commit.',
    '3. Write or refresh README.md, the store page: the tagline, What it does, Screenshots (at most 3 in store/, nothing personal). Commit. What\'s new comes from --note.',
    `4. Run \`dreamcontext apps publish ${h.slug}\` again (add --public for a public app): the gate is the last hard stop. Fix every block in the app; never work around one.`,
    '5. Ask me ONE question, only for what you cannot decide: who gets it (people I invite: their GitHub usernames; or anyone with the link, public for good: then I confirm its name), and any generic-word lines from the report I may let go.',
    `6. Publish: \`dreamcontext apps publish ${h.slug} --go --grant ${h.grant} --note "<what changed>" [--invite <logins>] [--approve <ids>] [--public --confirm-name "${h.name}"]\`. The grant is for this app, one publish, one hour.`,
    '7. End with a short plain list: what you cleaned, what went out, where.',
  ].join('\n');
}
