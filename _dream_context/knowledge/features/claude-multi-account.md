---
id: feat_b__I_0z3
type: feature
name: claude-multi-account
description: >-
  Connect several Claude accounts to the app, pick which one a session runs on,
  order them by drag-and-drop priority, and move a message to another account at
  a turn boundary before a limit lands. Credentials are never handled — each
  account is a CLAUDE_CONFIG_DIR sandbox the CLI signs into itself.
pinned: false
date: '2026-09-05'
status: in_review
created: '2026-09-05'
updated: '2026-09-07'
released_version: 0.27.0
product: desktop
tags:
  - 'topic:agents'
  - 'topic:desktop'
  - 'topic:dashboard'
  - 'domain:security'
  - 'layer:frontend'
  - 'layer:backend'
related_tasks:
  - >-
    multi-account-connect-several-claude-accounts-pick-one-per-session-auto-switch-before-a-limit-lands
  - >-
    agents-hesap-paneli-okunur-olur-her-hesabin-iki-limiti-surukle-birak-oncelik-ve-yenile
  - a-claude-account-switch-reaches-the-sessions-already-open
  - automation-runs-must-degrade-gracefully-on-the-account-usage-limit
---

## Why

The app used to know exactly one Claude account — whoever `~/.claude.json` said. An owner
with several accounts lost work at every limit: the message sent into a nearly-full session
window errored, and the recovery was manual (switch account by hand, resend). A session
stranded mid-limit is this product's most expensive interruption.

Reaching an OPEN session with an account change was already solved (`task_8z7Ddtvz`), but that
machinery only TRACKED which single account was live. Holding several accounts, choosing one,
and moving before the limit lands did not exist at all.

## User Stories

- [x] As an owner with several Claude accounts, I can connect all of them and see who each one
      is (email, organization, plan) with its current limit state.
- [x] As a user, I can add an account from INSIDE the app — a Settings button starts the CLI's
      own OAuth flow; no token is ever shown to me, pasted by me, or stored by us.
- [x] As a user, I can choose which account a session runs on, and that choice sticks for the
      session's life (auto-switch aside).
- [x] As a user, I can drag accounts into the order I want; the top one is where new sessions
      start, and the order breaks ties when the system picks an account.
- [x] As a user, I see the five-hour AND the weekly window for EVERY account, always — so two
      accounts can actually be compared.
- [x] As a user, I can refresh usage by hand, and I can see how old each reading is.
- [x] As a user, I can turn auto-switch OFF; with it off the system reports the limit and
      changes nothing.
- [x] As a user, when a switch happens I am told which account it moved to — the billed account
      never changes silently.
- [x] As a user, when EVERY account is exhausted, I am told when work resumes, not just that it
      failed.
- [x] As a user, when a limit has ALREADY landed my message is not simply lost — the refused turn
      is carried to another account and re-sent, and the refusal is remembered so the next message
      does not have to earn the same visible error again.
- [x] As a user, I can tell whether THIS message was refused or whether it was moved because an
      EARLIER one was — the two are never told the same sentence.
- [x] As a user, I can understand what the settings under the account list actually do, and what
      each group of them is for.

## Acceptance Criteria

### Accounts, identity, and sign-in

- [x] Any number of accounts can be connected and listed; each row names the identity and the
      product ("Claude Max" / "Claude Team"), and hides an organization name that is only a UUID.
- [x] Adding an account runs `claude auth login` inside a fresh per-account sandbox; the login
      spawn's stdout AND stderr are dropped on all three legs (no file, no HTTP body, no log
      sink) because an interactive OAuth stdout can carry a callback URL with an authorization
      code. All three legs are tested.
- [x] An account whose identity has lapsed (expired, revoked, hand-logged-out) says "needs
      re-login" in the UI rather than showing an ambiguous "unknown" row.
- [x] With no second account connected, behaviour is bit-for-bit what it was: no sandbox is
      built, no symlink is laid, and no ordinary spawn is rejected.
- [x] A sandbox's `.claude.json` carries NO MCP configuration at any depth
      (`mcpServers` / `mcpContextUris` / `enabledMcpjsonServers` / `disabledMcpjsonServers`);
      MCP reaches a sandboxed session BY REFERENCE through one 0600 file (`--mcp-config`).

### Choosing an account

- [x] A new session takes `&account=<id>` on the chat WS URL; with no parameter the server
      resolves the PREFERRED account, else account #0. An unknown id is REJECTED, never
      silently downgraded to the real HOME.
- [x] Changing the account of a RUNNING session calls the turn-boundary respawn machinery
      (`--resume` on the same conversation id); the picker states which of the two will happen
      before the user confirms. A picker that silently no-ops is not acceptable.
- [x] The resolved account id joins the session state next to `spawnAuthEpoch`, so the live
      panel can be labelled with the account actually being billed.
- [x] Automations run on the preferred account — one line in the shared spawn core
      (`...accountEnv`). Per-automation account pinning is explicitly out of scope (owner call).

### Auto-switch

- [x] `chooseAccount(readings, {threshold, orderedIds})` is PURE and takes usage readings as
      arguments — no I/O, so every case is a unit test. It picks the lowest session usage whose
      session AND weekly windows are both under threshold and whose `lockedReason` is empty.
- [x] An `unknown` or `stale` reading is NEVER a candidate and is never counted as zero.
- [x] Registry order is a real tie-break term (`orderedIds`), in both the measured branch and the
      last-resort branch — numbers still come first, so a busy top-row account loses to a free
      one. Omitting `orderedIds` preserves the old id ordering exactly.
- [x] Percentages are the FORECAST path only: probe at session ≥80%, switch at ≥90% or as soon as a
      `lockedReason` arrives (`shouldProbe` / `shouldSwitchAway` / `SWITCH_THRESHOLD_PERCENT`). The
      LOAD-BEARING trigger is the API's own refusal — see the reversal below.
- [x] A limit that has ALREADY landed is acted on, not only forecast: the refusal is read off the
      stream (`claude-limit-signal.ts`), the turn is carried to another account and re-sent, and the
      refusal is WRITTEN TO DISK (`claude-limit-rejections.ts` →
      `~/.dreamcontext/claude-account-limits.json`) so the next message does not re-earn the error.
- [x] A recorded rejection is ACCOUNT-wide, not pane-wide, and overrides that account's own
      percentages. A stated reset beats a bounded 20-minute estimate (`DEFAULT_COOLDOWN_MS`, flagged
      `estimated: true`); on collision the LONGER exile wins, so an estimate can never shorten a
      known reset. If the file disappears, behaviour falls back and never costs a turn.
- [x] `healthy-unmeasured` — the judge answered "signed in" but `/usage` publishes no percentages
      for that account — is a LAST-RESORT candidate: never chosen in preference to a measured
      account, and the result carries `unmeasured: true` so the banner says there is no number
      behind it. `unknown` / `stale` are still never candidates.
- [x] The wire and the banner keep `limit_hit` (THIS message was refused), `limit_known` (this
      message did not fall; an earlier one did, so it was moved without trying) and `stayed_put`
      (refused, nowhere better to go — shown only after a REAL refusal) apart, alongside
      `limit_near`, `all_exhausted`, `needs_relogin` and `auto_switch_disabled`.
- [x] When no candidate exists the message is neither blocked nor swallowed: it is sent on the
      current account and the honest limit error surfaces with the earliest reset time.
- [x] One switch per conversation at a time — a second trigger while a restart is pending is a
      no-op, not a second respawn.
- [x] A switch happens at a TURN BOUNDARY, never mid-turn: an in-flight turn was authorized with
      the old credentials.
- [x] The client's switch gate reads the SERVER's real turn state, not its own optimistic `busy`
      flag, and every user frame joins a promise chain so evaluation #2 cannot start before #1
      finishes (message ORDER preserved, deadlock closed).
- [x] In-flight turns are tracked by a CLAMPED COUNTER, not a boolean — `setEffort` writes its own
      user frame outside the gate and the CLI answers it with a fast synthetic turn, which would
      drop a shared boolean while the real turn was still running.
- [x] The held message is re-sent via `enqueue`, not `send`: the new session's socket is still
      `CONNECTING` microseconds after creation, so the direct write was losing the message 100% of
      the time. `ws.onopen` now calls `maybeFlushQueue()`.
- [x] A copied switch notice cannot recurse: `armAccountSwitch` returns when the announced
      account IS this session's own account (the server never announces a switch to the account
      you are already on, so such a notice can only be an inherited copy).

### Reading the limit signal

- [x] The CLI's per-turn `rate_limit_event` frame is read as a METER, not a refusal: its payload
      key is `rate_limit_info`, its `status` is the authority, and `overageStatus: "rejected"`
      is a SEPARATE, org-level-disabled facility that reads "rejected" on a perfectly healthy
      turn. An unrecognized shape returns `null` instead of a confidently wrong guess.
- [x] Every usage number carries its AGE; a reading older than 10 minutes reads in a warning
      tone. The panel probes once on mount only when the OLDEST reading is stale (gating on the
      freshest reading reproduced the reported bug — a busy account masks its quiet neighbour).

### The account panel (Settings → Agents)

- [x] The five-hour AND weekly windows are drawn for EVERY account, always. With no reading, a
      HATCHED empty rail labelled "not measured" is drawn — not a 0%-full bar (which reads as
      "unused") and not a sentence (which ends the comparison). >70% amber, >90% red, a locked
      window says "limit reached".
- [x] Priority changes by drag-and-drop, with a handle and a rank number, PLUS keyboard up/down
      buttons — a control that only works with a mouse is not a control. New route:
      `POST /api/agent/accounts/reorder`.
- [x] The order IS the priority: `reorderClaudeAccounts` makes position 0 preferred as it writes,
      so the "new sessions start here" flag can never drift from the list order. The separate
      "Make preferred" button is gone.
- [x] `POST /api/agent/accounts/refresh` probes accounts SEQUENTIALLY (N concurrent spawns is
      exactly the storm the list route avoids) and reports how many refreshed / could not be
      read. An unreadable account keeps its old value and the request does not error.
- [x] `reorderClaudeAccounts` is defensive: unknown ids ignored, accounts the caller forgot kept
      at the end (a stale tab cannot drop an account by reordering), duplicate ids taken once,
      `autoSwitch` preserved.
- [x] The settings under the account list say what they do: "Move a message to another account
      before a limit lands" → "Auto-switch accounts near a limit" with a one-line explanation and a
      folded detail; groups renamed ("Accounts" → "Claude accounts", "Surface" → "The agent panel",
      "New sessions" → "What a new session starts with"). The panel's own copy states the order
      rule: new sessions start at the top and a switch between equally free accounts follows it.
- [ ] Manual owner checklist (owner's own two real accounts): add the second account from
      Settings, fill a session limit and watch the switch land mid-work with the transcript
      intact, change a running session's account, turn auto-switch off, delete a sandbox by hand
      and see "needs re-login".

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

- **[2026-09-05] REVERSAL — auto-switch steers on the API's actual refusal, not on a forecast
  percent.** The ≥80/≥90 percentage trigger never opened on a real machine: the account that refused
  a turn at 02:28 read session 6% three minutes later, and a cache whose windows carry a null
  `resets_at` yields an EMPTY `limits[]`, so no threshold is established at all — two roads to the
  same dead end. Percentages survive as the early-warning path; the load-bearing trigger is now the
  refusal read off the stream.
- **[2026-09-05] A refusal is REMEMBERED, not just reacted to once.** A post-hoc switch that forgets
  has to be re-earned with a second visible error. Recorded to disk, account-wide; a bounded 20-min
  estimate when no reset is stated (`estimated: true`), and the longer exile wins a collision so an
  estimate can never shorten a known reset.
- **[2026-09-05] An account we cannot MEASURE but the judge vouches for is a last-resort candidate
  (`healthy-unmeasured`).** This was the difference between the feature working and not on the very
  machine it shipped on: one measurable + one unmeasurable account produced `all_exhausted`. An
  account we cannot VOUCH for (`unknown` / `stale`) is still never a candidate.
- **[2026-09-05] `limit_hit` and `limit_known` are kept apart** on the wire and in the banner.
  Telling both the same sentence is the same class of lie as silently changing the billed account.
- **[2026-09-05] The per-turn `rate_limit_event` is a METER, not a refusal.** Its payload key is
  `rate_limit_info`, its `status` is the authority, and `overageStatus: "rejected"` reads on a
  perfectly healthy turn. Read as a refusal it disqualified every account on every message and
  produced "Every account is at its limit" while the measured windows were 7% and 19%. An
  unrecognized shape now returns `null` rather than a confidently wrong guess.
- **[2026-09-05] The stale-reading auto-probe gates on the OLDEST reading, not the freshest.**
  Gating on the freshest reproduced the reported bug — a busy account keeps itself fresh and masks
  its quiet neighbour's hours-old number.
- **[2026-09-05] A switch notice carries BOTH presentation and instruction**, so the copy handed to
  the new session must be guarded (`armAccountSwitch` returns when the announced account is its
  own). Unguarded, the new session re-moved itself, recursed, and left an orphan tab.
- **Open, unexplained:** the on-screen "resets 4:10am (Europe/Istanbul)" never reconciled with the
  live five_hour window's 04:19 UTC = 07:19 Istanbul. It gates nothing now (the system reads the
  refusal, not the percentage), but it was not solved.
- **[2026-09-05] The order is full priority, but numbers still win.** `orderedIds` became the last
  tie-break term in place of "smallest id". Alphabetical order was only there to be deterministic,
  yet it was quietly deciding which of two equally free accounts took the work.
- **[2026-09-05] A "not measured" account draws a hatched rail, not an empty bar.** A 0%-full bar
  reads as "unused" and a prose sentence ends the comparison; the point of the panel is that two
  accounts can be held side by side.
- **[2026-09-04] Auto-switch does NOT respect the organization boundary — owner's call, taken
  after the risk was stated plainly.** Conversation history produced under one org's account can
  silently continue under another's, so that history goes to the API on the second organization's
  behalf. The security lens raised this as a DATA BOUNDARY crossing, not a billing-visibility
  issue; the owner chose the smoother experience. The remaining mitigation is visibility: every
  switch is shown and names the account moved to.
- **[2026-09-04] Credentials are never taken.** Sign-in runs the CLI's own OAuth flow into a
  directory the CLI owns (`CLAUDE_CONFIG_DIR` per account). Nothing is read, stored, displayed,
  or pasted by the user. This answered the plan's one open design question: we store them nowhere.
- **[2026-09-04] MCP configuration is never copied into a sandbox** — reached by reference through
  a single 0600 file, so the blast radius is 1 instead of N.
- **[2026-09-04] A switch happens at a turn boundary, never mid-turn.**
- **[2026-09-04] The billed account never changes silently.**
- **[2026-09-04] Per-automation account pinning is out of scope** (owner call) — automations run on
  the preferred account; the manifest field, parser and UI do not exist.
- **[2026-09-04] Codex is not in this round** — the architecture is NAMED to carry more than one
  provider, but only Claude is implemented.
- **[2026-09-04] `task_9uefkZSK` (sign in from inside the app) was FOLDED INTO this feature**
  rather than shipping separately (owner call).
- **Known and accepted:** there is no cross-conversation reservation. Several panels crossing the
  threshold at once can pick the same lowest candidate and churn. Worst case is one extra switch,
  not corruption, and a reservation protocol costs more than the churn. Revisit if observed.

## Technical Details

**Credential isolation.** One `CLAUDE_CONFIG_DIR` sandbox per account. `src/lib/claude-auth.ts` +
`claude-auth-watch.ts` (cheap trigger: `~/.claude.json` `oauthAccount` stat/mtime at 2s; authority:
`claude auth status --json`, ~4.8s cold) moved from a single-account assumption to an N-account
registry; the three-field identity fingerprint (`accountUuid` + `emailAddress` +
`organizationUuid` — two orgs are two limit pools) carried over unchanged. `--resume` targeting is
untouched and `projects/` stays SHARED, so a resumed conversation is found whichever account
resumes it — the most consequential consequence of the share/isolate split, pinned by a verify
assert.

**Server.** `src/lib/claude-accounts.ts` (registry, `reorderClaudeAccounts`),
`src/lib/claude-account-switch.ts` (`chooseAccount`, pure), `src/lib/claude-limit-signal.ts` (four
readers over the refusal frame — structural first, the synthetic assistant TEXT last and locked to
`model === '<synthetic>'`, because a false positive bills a healthy conversation to another
account), `src/lib/claude-limit-rejections.ts` (`readAccountRejections` /
`recordAccountRejection` / `clearAccountRejection`, `DEFAULT_COOLDOWN_MS = 20m`),
`src/lib/claude-usage-probe.ts` (`probeAccountUsage`, incl. the `healthy-unmeasured` outcome),
`src/server/routes/agent-accounts.ts` (list / login / reorder / refresh, wired at
`src/server/index.ts:385-388`), the account-switch block of `src/server/routes/agent-chat.ts`
(`shouldProbe` / `shouldSwitchAway` / `SWITCH_THRESHOLD_PERCENT`, passing the live `accounts` array
as `orderedIds`), and the one-line `...accountEnv`
addition in the shared automations spawn core (`src/lib/automations/runner.ts`).
`~/.dreamcontext/app.json` holds `autoSwitch` (default ON);
`~/.dreamcontext/claude-account-limits.json` holds recorded rejections.

**Client.** `dashboard/src/components/settings/ClaudeAccounts.{tsx,css}` (the panel — drag order
reconciled over an ID LIST, not objects, so a background refetch does not fight the row in hand),
`dashboard/src/components/sleepy/AgentSurface.tsx` (`armAccountSwitch`),
`chatSession.ts` (account on the WS URL, the switch gate, the in-flight COUNTER),
`chat/Banners.tsx` (`limit_hit` / `limit_known` / `stayed_put` + an `unmeasured` flag on the
`account_switch` frame — hardcoded English, consistent with that file's pre-existing convention).
`dashboard/src/components/sleepy/respawnTrace.ts` is kept deliberately: any swallowed throw on the
respawn path produces the same silent orphan tab, and this turns it into one loud console error.

**Measured, not reviewed.** A `/usage` probe in an identity-less or broken sandbox does NOT error —
it exits code 0, `is_error:false`, `subtype:'success'` with an empty cost summary and writes no
cache. Worse than a hang, because it looks like success; an implementation trusting the exit code
reads a logged-out account as healthy. Also measured: `claude auth status --json` ignores a stale
mirror and reports `loggedIn:false`, and the CLI writes `.claude.json` at 0600 itself even under
umask 022.

## Notes

**Plan review record.** Four lenses (critic / pragmatist / edge-cases / security) ran three full
parallel rounds. Round 1: all four NEEDS_WORK, 15 blocking findings. Round 2: pragmatist SOLID,
5 new blocking. Rounds 3–5: all SOLID. No finding repeated — each round found the NEW layer the
previous one opened. The four most expensive: (1) "we reuse the existing respawn path" was FALSE,
two lenses converged on the same spot; (2) with no account-#0 exemption written down, the
reconciliation policy would have rejected EVERY ordinary spawn; (3) an unfiltered HOME-watcher
broadcast would have respawned sandboxed sessions for nothing; (4) "the project trust map carries
no credentials" was a WRONG factual claim about a secret (6 of 27 entries carry their own
`mcpServers`).

**The two build-time defects the tests did not find.** Both broke the feature's headline promise
and both had the same root cause — the SERVER holds the turn while the decision looked at the
CLIENT's own flag. Both were found by REVIEW, not by tests, because the harness had never driven a
threshold-triggered switch over a live session. Coverage was added (seven new end-to-end checks).
Lesson: if a feature's headline flow is untested, everything else being green says nothing.

**Opportunity not taken (separate work):** the per-turn `rate_limit_event` frame already carries
full utilization for BOTH windows with their reset times. That is a free, exact reading from the
account's own turn — no `/usage` probe needed — and the natural answer to "I can't see one
account's usage".

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-09-07 - Reconciled for the 0.27.0 release
- `released_version: 0.27.0` (released 2026-09-06). Consolidated the two now-completed tasks:
  `multi-account-connect-several-claude-accounts-pick-one-per-session-auto-switch-before-a-limit-lands`
  and `agents-hesap-paneli-okunur-olur-her-hesabin-iki-limiti-surukle-birak-oncelik-ve-yenile`.
  Added the refusal-driven switch, the on-disk rejection memory, `healthy-unmeasured` as a
  last-resort candidate, the limit_hit/limit_known/stayed_put honesty split, and the settings-copy
  work; folded in the percentage-trigger REVERSAL. Status stays `in_review`: the owner's manual
  two-real-account checklist is still unticked in the source task, so nothing here can tick it.

### 2026-09-05 - Created
- Feature PRD created retrospectively at sleep from the two shipped tasks (multi-account, account
  panel) and the six commits of 2026-09-05 (a9e0837, d05646a, 1d3b480, a6631d7, fd5edb5, 14ec7f3).
