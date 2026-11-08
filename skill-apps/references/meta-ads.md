# Worked example: a Meta ad manager

The repository's test fixture `tests/fixtures/apps/meta-ads/` is a complete app against a
FICTIONAL Graph API (`scripts/verify/fixtures/fake-graph-api.mjs`). Build a real one the same way.

1. `dreamcontext apps new meta-ads --name "Meta Ads"`, then `dreamcontext apps assign meta-ads ua-manager`.
2. Ask the owner for the token with a secret card that names the app:
   `{"type":"secret","id":"meta-token","title":"Meta access token","app":"meta-ads","fields":[{"key":"META_TOKEN","label":"Access token"}]}`
   plus `META_ACCOUNT=act_<id>` (not secret) in `.env`.
3. Backend routes (see the fixture's `server.mjs`):
   - `GET /api/campaigns`: calls `/<account>/campaigns`, FOLLOWS `paging.next` on the server (it
     carries the token) and returns only `{id, name, status, spend}`;
   - `POST /api/campaigns/pause` / `resume` `{id}`: validates the id, sets `status`.
4. Actions in the manifest: `list-campaigns`, `pause-campaign` (`danger: true`), `resume-campaign`.
   The page's buttons and the agent call the SAME actions:
   `dreamcontext apps do meta-ads pause-campaign --input '{"id":"1202"}'`.
5. A morning schedule (`"schedules": [{"id":"morning","schedule":{"days":"daily","at":"08:30"},"call":{"method":"GET","path":"/api/campaigns"},"notify":"failure"}]`)
   checks the account every day without Claude.
6. Never return the raw Graph page: its `paging.next` holds the token. The sink masks it if you
   slip, but the rule is the app's.
