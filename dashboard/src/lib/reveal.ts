import { RequestError, type ApiClient } from '../api/client';

/**
 * Hand a path to the OS (`POST /api/agent/reveal`) and say whether it actually went.
 *
 * Resolves to `null` when the opener took it, or to a short line to SHOW when it could not.
 * A button that silently does nothing is worse than no button — the user clicks, the app
 * says nothing, and there is no telling "opened behind the window" from "never reachable".
 *
 * The words are chosen HERE, from the route's `error` slug, and are deliberately the sort a
 * person says. The route's own prose ("Path escapes the project root") is a correct answer
 * to the wrong audience: nobody reading a chat bubble asked about project roots. Finding the
 * file the reference actually meant is `resolveChatReference`'s job on the server, and it
 * now handles the case that produced this line at all — so this copy is the rare tail, not
 * the everyday outcome.
 *
 * `mode: 'reveal'` asks for the file manager outright — "show me where this is", which is a
 * different thing to want than "open this" and now has its own button. `'auto'` (the default,
 * and what every inline card uses) lets the route decide, which for anything executable is a
 * reveal regardless: that downgrade is a SUCCESS, not something to report. The file manager
 * comes to the front with the file selected, which is the honest answer to the click.
 *
 * `api` is a PARAMETER, not a module read: `/agent/reveal` is per-vault (not on the server's
 * agnostic list), and this is a plain function called from event handlers, not a hook — it
 * can't read `useVault()` itself, so every caller passes the client bound to ITS OWN project.
 */
export function revealPath(api: ApiClient, path: string, mode: 'auto' | 'reveal' = 'auto'): Promise<string | null> {
  return api.post('/agent/reveal', { path, mode }).then(
    () => null,
    (err: unknown) => {
      const code = err instanceof RequestError ? err.code : '';
      if (code === 'not_found') return 'this file isn’t there any more';
      if (code === 'desktop_only') return 'only available in the desktop app';
      return 'couldn’t open this one';
    },
  );
}
