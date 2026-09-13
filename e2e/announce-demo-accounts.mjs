/**
 * Seed SYNTHETIC Claude accounts into the demo home, so the Agents panel and the
 * auto-switch policy can be photographed without a real account on screen.
 *
 * Why this exists: `announce-demo-vaults.mjs` isolates the vault registry, but the
 * account register is a different file, and an unseeded demo home draws "No accounts
 * are connected yet" — which photographs the account layer as if it did not ship.
 * Pointing the capture at the author's real register is the thing the demo harness
 * exists to prevent: it names every Claude account they are signed into.
 *
 * NOTHING IS MOCKED IN THE APP. Three identities are written to the register and each
 * one's sandbox gets a `.claude.json` carrying a `cachedUsageUtilization` block in the
 * CLI's own shape. The panel then reads those caches through the ordinary reader and
 * draws the ordinary bars — the same code path a real machine runs between refreshes.
 *
 *   HOME=$(node e2e/announce-demo-vaults.mjs --print-home) node e2e/announce-demo-accounts.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = process.env.HOME ?? homedir();
const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;

/** Fictional-but-plausible, matching the demo vault set's Acme cast. */
const ACCOUNTS = [
  { id: 'ada-acme-dev', email: 'ada@acme.dev', org: 'Acme', tier: 'max', session: [34, 3 * HOUR + 12 * MIN], weekly: [61, 4 * 24 * HOUR] },
  { id: 'team-acme-dev', email: 'team@acme.dev', org: 'Acme Engineering', tier: 'team', session: [7, 4 * HOUR + 40 * MIN], weekly: [22, 6 * 24 * HOUR] },
  { id: 'ops-atlas-dev', email: 'ops@atlas.dev', org: 'Atlas Mobile', tier: 'team', session: [88, 51 * MIN], weekly: [73, 2 * 24 * HOUR] },
];

const cache = (uuid, [sPct, sIn], [wPct, wIn]) => ({
  cachedUsageUtilization: {
    fetchedAtMs: NOW - 90_000,
    accountUuid: uuid,
    utilization: {
      five_hour: { utilization: sPct, resets_at: new Date(NOW + sIn).toISOString() },
      seven_day: { utilization: wPct, resets_at: new Date(NOW + wIn).toISOString() },
    },
  },
});

const accounts = ACCOUNTS.map((a, i) => ({
  id: a.id,
  accountUuid: `00000000-0000-4000-8000-00000000000${i + 1}`,
  email: a.email,
  organizationUuid: `00000000-0000-4000-8000-0000000001${i + 1}`,
  organizationName: a.org,
  tier: a.tier,
  configDir: i === 0 ? null : join(HOME, '.dreamcontext', 'claude-accounts', a.id),
  preferred: i === 0,
}));

mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
writeFileSync(
  join(HOME, '.dreamcontext', 'claude-accounts.json'),
  JSON.stringify({ accounts, autoSwitch: true, switchStrategy: 'score', switchWeights: { session: 1, weekly: 2, order: 5 } }, null, 2),
);

ACCOUNTS.forEach((a, i) => {
  const uuid = accounts[i].accountUuid;
  const dir = i === 0 ? HOME : join(HOME, '.dreamcontext', 'claude-accounts', a.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, '.claude.json'),
    JSON.stringify({ oauthAccount: { accountUuid: uuid, emailAddress: a.email }, ...cache(uuid, a.session, a.weekly) }, null, 2),
  );
});

console.log(`seeded ${ACCOUNTS.length} synthetic accounts into ${HOME}`);
