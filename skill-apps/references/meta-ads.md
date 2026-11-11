# Worked example: a Meta ad manager

Build it against the Graph API in this shape: the routes below, a token from `.env`, no raw
Graph page returned. (The repository keeps a test fixture of it; the npm package does not ship it.)

1. `dreamcontext apps new meta-ads --name "Meta Ads"`, then `dreamcontext apps assign meta-ads ua-manager`.
2. Ask the owner for the token with a secret card that names the app:
   `{"type":"secret","id":"meta-token","title":"Meta access token","app":"meta-ads","fields":[{"key":"META_TOKEN","label":"Access token"}]}`
   plus `META_ACCOUNT=act_<id>` (not secret) in `.env`.
3. Backend routes:
   - `GET /api/campaigns`: calls `/<account>/campaigns`, FOLLOWS `paging.next` on the server (it
     carries the token) and returns only `{id, name, status, spend}`;
   - `POST /api/campaigns/pause` / `resume` `{id}`: validates the id, sets `status`.
4. Actions in the manifest: `list-campaigns`, `pause-campaign` (`danger: true`), `resume-campaign`.
   The page's buttons and the agent call the SAME actions:
   `dreamcontext apps do meta-ads pause-campaign --input '{"id":"1202"}' --confirm` (a change: say what
   it will do and add `--confirm` only after the owner's yes).
5. A morning schedule (`"schedules": [{"id":"morning","schedule":{"days":"daily","at":"08:30"},"call":{"method":"GET","path":"/api/campaigns"},"notify":"failure"}]`)
   checks the account every day without Claude.
6. Never return the raw Graph page: its `paging.next` holds the token. The sink masks it if you
   slip, but the rule is the app's.
