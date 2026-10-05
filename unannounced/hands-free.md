# Hands-free mode — the project on a cloud machine, driven from the phone

Hands-free mode moves the active project to the owner's own GitHub Codespace, so the owner can leave the laptop and keep working from the phone. **Go** copies the project there and locks it on the laptop. The phone opens a link, signs in with a passphrase and drives the same Chat. **Return** brings every commit, branch, stash, uncommitted change, file and Chat session back, then seals and stops the cloud machine.

Load this reference when the owner wants to work from the phone, "go hands-free", "eller serbest", "take this to the cloud", or come back ("return", "dön", "bilgisayara dönüyorum"). It also covers a stuck trip, a passphrase leak, a lost laptop and a refused start.

Every subcommand and flag below is read from `src/cli/commands/handsfree.ts` (`registerHandsfreeCommand`). The logic behind them is in `src/lib/handsfree/orchestrator.ts`, and the desktop app calls the same functions through `src/server/routes/handsfree.ts`.

**Not to be confused with:**
- the **tailnet phone path** (`src/server/remote-access.ts`). That path reaches the laptop's own server, so it dies when the laptop sleeps. Hands-free mode runs on a separate machine.
- **brain sync** (`references/brain-sync.md`), which shares `_dream_context/` through git at `sleep done`. Hands-free mode never pushes to GitHub from the cloud (out of scope v1).

---

## The subcommands

| Command | What it does | Source |
|---|---|---|
| `dreamcontext handsfree setup [--machine <type>]` | Signs in to GitHub with the device flow (scopes `repo` + `codespace`) unless already signed in. Creates the private repo `<owner>/dreamcontext-handsfree` with the devcontainer and the bootstrap verifiers, then creates the codespace (default `basicLinux32gb`). Starts it once, pushes the verifiers and leaves it stopped. Prints the phone passphrase **once**. Runs only while home. A re-run keeps what exists; a different `--machine` on an existing codespace is refused (teardown first). | `setup()`, `githubDeviceLogin()` |
| `dreamcontext handsfree account-login [id] [--all] [--print]` | Opens `gh codespace ssh -c <name> -t -- sudo /opt/dc-hf/entrypoint.sh claude-login <id>` in this terminal: the CLI's own `claude auth login` runs inside the cloud for that account. `--all` does every registered account in turn; `--print` only prints the command. Nothing is captured or stored. | `account-login.ts` `accountLoginArgv()` |
| `dreamcontext handsfree password` | Generates a new 6-word passphrase (shown once). This signs every device out. It stays **pending** until the cloud confirms the new verifier generation (pushed at the next contact). | `changePassword()` |
| `dreamcontext handsfree go [--cut-running] [--take-over]` | Takes the active project to the cloud and locks it here. `--cut-running` stops running turns instead of waiting. `--take-over` adopts a cloud machine another (lost) laptop started; a live trip asks for two confirmations. Prints the phone URL, any paths that stay home, the cloud's refusals and signed-out accounts. | `go()` |
| `dreamcontext handsfree status [--json]` | Phase (`home / going / away / returning`), the codespace and its URL, pending verifier changes, queued finalization steps, this month's own uptime count, warnings, and what the owner can do now (`offers`). | `status()` |
| `dreamcontext handsfree return [--cut-running]` | Brings everything back and prints the receipt. `--cut-running` stops turns still running on the phone. On a laptop already `returning` it resumes. | `returnTrip()` |
| `dreamcontext handsfree resume` | Finishes an interrupted go or return from its journal. | `resumeTrip()` |
| `dreamcontext handsfree rollback` | Undoes the interrupted return's own writes; the trip is `away` again and the phone can continue. | `rollbackTrip()` |
| `dreamcontext handsfree abandon` | Unlocks the laptop now without returning (two confirmations, TTY only). The cloud work is recovered by the next go. | `abandonTrip()` |
| `dreamcontext handsfree devices list` | The verifier generation, what the cloud confirmed, and any pending change. Devices are not individually named. | `status({probe:false})` |
| `dreamcontext handsfree devices revoke --all` | Signs every phone out (pending until the cloud confirms). Without `--all` it refuses. | `revokeAllDevices()` |
| `dreamcontext handsfree teardown [--discard-abandoned-work]` | Deletes the codespace. Runs only while home. It first recovers unrecovered cloud work (run it from the project). `--discard-abandoned-work` skips that and asks twice. | `teardown()` |

`dreamcontext cloud serve` / `cloud worker <op>` are hidden internals that the codespace runs (`src/cli/commands/cloud.ts`). Never run them by hand.

In the desktop app the same flow is the hands-free button in the window chrome, a sheet with scope, wait/cut, progress, URL and QR, a banner on every page while away, and the receipt with Resume / Roll back (`dashboard/src/components/handsfree/`). Setup, password, account logins and teardown are CLI-only.

---

## The laptop phases, and what the lock refuses

The laptop's state lives in `~/.dreamcontext/handsfree/state.json` (`trip-state.ts` `readTripState`). Its phase is `home | going | away | returning`. One guarded function, `transition()` in `orchestrator.ts`, makes every phase change (D23). Once any pass of a Return has written to the laptop, that function refuses `returning → away` and refuses `returning → home` except through a finished Return or Roll back.

While the laptop is not `home`, every path inside a trip root is **locked** (`handsfreeLockFor(path)`, symlinks resolved, case-insensitive on macOS). An unreadable state file locks everything until it is repaired. What refuses inside a locked root:

| Surface | Where |
|---|---|
| Chat spawn | `agent-chat.ts` via `handsfreeSpawnRefusal()` (`peer-delivery.ts`) |
| Terminal (PTY) spawn | `agent-terminal.ts` via `handsfreeSpawnRefusal()` |
| Detached `claude` (automations, auto-sleep, account login, MCP) | `executeClaudeDetached` in `automations/runner.ts` |
| Peer headless + Assistant broadcast | `peer-delivery.ts`, `assistant/broadcast.ts` |
| Every mutating `/api/*` request scoped to the locked vault | ONE middleware, `handsfreeLockRefusal()` (`routes/handsfree.ts`), run by `src/server/index.ts`. `/api/handsfree/*` is exempt; body-selected vault routes are screened too. |
| Automations tick, brain sync, task-backend sync | skip: `automations/tick.ts`, `git-sync/sync-engine.ts`, `cli/commands/tasks.ts` |
| A `claude` started from a terminal | `hook session-start` prints a `HANDS-FREE` warning (`hook.ts`) |
| `dreamcontext upgrade`, the app's auto-update and the launcher upgrade | refused while not home, so the cloud keeps this laptop's exact build (`upgrade.ts` `upgradeRefusal`, `app.ts` `autoUpdateHandsfreeBlock`, `launcher.ts` `handleLauncherUpgrade`, `version-check.ts`) |

If the owner wants to edit something in a locked project while away, the answer is the phone (or Abandon). Never work around the lock.

---

## Go, step by step

From `go()` → `goAfterLock()` → `finishGo()` in `orchestrator.ts`:

1. **Preflight.** Computes the scope (`scope.ts`: the active vault, its present linked repos, their worktrees under HOME and their Claude transcript dirs). Runs the git preflight on every repo (`preflightAll`). The preflight refuses an unmerged index, a merge/rebase/cherry-pick/bisect in progress, a held `.git/*.lock`, custom filter drivers, LFS, submodules, shallow or partial clones, NFC/NFD name collisions, and a symlink whose target can never travel (D19). Each refusal names the repo and the fix. Then the disk check (`diskFit`): the estimated size × 1.3 must fit the machine's disk minus ~21 GB of image. If it does not, the error names the bigger machine: `handsfree teardown`, then `handsfree setup --machine <bigger>`.
2. **Lock first.** The phase becomes `going` (`beginGoing`), and a per-trip run lock (`acquireTripRunLock`) refuses a second concurrent go or return from the CLI or the app.
3. **Wait or cut.** Running work is found by the **process tree** (D22): every process whose cwd is inside a scope root. Idle chats are cut without asking. Busy turns are waited for (up to 2 h) unless `--cut-running` is set or the owner presses Cut. After a cut the git preflight runs again.
4. **Bring the machine up** (`ensureRunning`). Checks that the private repo's devcontainer and verifier blob shas equal what this laptop wrote (else `tampered`; nothing starts). If GitHub deleted the codespace, it is re-created: new URL, and the phone must re-add the app. A stopped machine first gets the quota check: the remaining quota (GitHub's REST value when it has one, else this laptop's own uptime count against a 120 core-hour budget) must cover the trip estimate (4 h by default) plus a 30-minute Return reserve. Then it starts over REST and waits up to 5 minutes for `/api/health` on the forwarded URL.
5. **Ownership** (`assertOwnership`). A live trip started by another laptop is refused unless `--take-over` is set, which asks for two confirmations on a live trip. Steps queued from an earlier Return run here (`runQueued`).
6. **Recovery** (D12). If the cloud still holds an unsealed or unrecovered trip, `recoverTrip()` parks its work first (see Abandon below).
7. **Build parity** (AC18). When the cloud's build fingerprint differs from this laptop's, the laptop uploads its `npm pack` tarball (`POST …/runtime`). The cloud's root supervisor installs it into `/opt/dreamcontext.next` and restarts, and the laptop waits until the fingerprint matches (5 min).
8. **Verifiers and accounts.** A pending passphrase or revoke-all is pushed (`deliverVerifiers`). Each registered Claude account's cloud login is read; signed-out ones are listed and do not block.
9. **Snapshot once, journal, send.** Both transports snapshot the laptop once and write `trips/<trip>/go-journal.json` before anything is sent. Ops: `go.trip` (the cloud refuses unless sealed), one `go.git` per repo (a git bundle; the cloud's snapshot id must equal the laptop's, AC2), one `go.files` per root (a pack; the cloud's manifest digest must equal it), `go.global` (one-way: `~/.claude` instructions/settings without `env`/skills/agents/commands, a seeded `~/.claude.json`, the scoped `~/.dreamcontext` registries, a generated `~/.gitconfig`; `global-set.ts`), then `go.activate`, where the cloud runs a changed lockfile's install as dcuser.
10. **Away.** The phase becomes `away`, the cloud `active`, and the URL is printed (with a QR in the app).

What travels and what does not:
- **Git state travels git-native** (`git-snapshot.ts`, `git-apply.ts`): refs under `refs/heads`, `refs/tags`, `refs/notes`, the stash list (sha **and** message), and per checkout HEAD, the index tree and the working-tree tree. No `.git` file ever travels.
- **Non-git files** (`manifest.ts`, `pack.ts`): ignored files under `_dream_context/` except `marketing/`, `tmp/`, `.embeddings/` and `.obsidian/`; ignored `.claude/` content; the secret class (`.env*`, `.npmrc`, `.dev.vars`, `.netrc`, `service-account*.json`, `credentials*.json`, `*.p12/pem/p8/key/keystore/jks`, by basename); and `handsfree.include` opt-ins from `_dream_context/state/.config.json` (relative paths only).
- **Never travel** (`isNeverTravel`): dreamcontext's own credentials, `_dream_context/state/.secrets.json` and `_dream_context/lab/credentials.json`. They are refused on Return too.

---

## Away: the phone

The phone opens the codespace's public URL (`https://<codespace>-8080.app.github.dev`) and signs in at `/login` with the passphrase (`handsfree-login.ts`). The device then stays signed in for 30 days (cookie `__Host-dc_hf_session`). `/` opens the trip project's Chat. The phone gets the mobile Chat only; PTY, voice, the Assistant, OS reveal and every other `/api/*` route answer 403 `cloud_unavailable` (`cloud-mode.ts` `CLOUD_DEVICE_API_ROUTES`, a static allow-list).

A turn keeps running when the phone locks or the socket drops. The client reconnects with backoff and the server re-adopts the live `claude` process. A busy turn is never reaped for lack of a socket (4 h cap); an idle detached one is reaped after 15 minutes.

### Sleep and wake (D14, D15)

The cloud stops **itself** (`cloud-idle.ts` `computeStopAt`). The stop time is 15 minutes after the later of the boot, the owner's last real action (send, steer, open a session; never polling, pings or an open tab) and the last turn's end. Things that push it later:
- a running turn: at most 2 h from that turn's start;
- a transfer in flight: 2 minutes after its last byte;
- a dependency install: at most 2 h;
- phase `going` or `quiescing`: at most 2 h.

At the stop time dcserver writes `/workspaces/dc-server-pub/stop-request` (with the boot id). `cloud/stop-helper.sh`, running as the `codespace` user, runs `gh codespace stop` with GitHub's own in-codespace token; dcserver and dcuser never see that token. GitHub's `idle_timeout_minutes=240` is only the backstop. Accepted residual (D17): continuous phone use longer than 4 h after the last start is stopped by GitHub's own clock, and a running turn is cut but stays resumable.

A stopped codespace does not wake on an HTTP request. The cloud-mode service worker (`handsfree-sw.ts`) intercepts only same-origin navigations (never `/api`, `/login` or WS) and re-issues them with `X-Tunnel-Skip-AntiPhishing-Page: true`. On a 404/502/503/504 or a network error **without** the `X-Dreamcontext-Cloud` header, it shows its cached offline page with a **Wake** link to the codespace's github.com page, which starts it. The worker unregisters on a sealed page or a revoked login. The laptop starts the codespace over REST at go and return.

### Accounts (D13)

Each registered Claude account signs in **inside the cloud** with `dreamcontext handsfree account-login <id>` (or `--all`). That runs the CLI's own `claude auth login` as dcuser into that account's sandbox config dir: open the printed URL, paste the code back. No laptop credential is copied. Health is read from `claude auth status --json` in that sandbox (`agent-accounts.ts`, `handsfree-cloud.ts` `getAccounts`). Logins live on the persistent disk and survive stop/start. A limit rejection switches accounts as on the laptop.

---

## Return, step by step

From `returnTrip()` → `runReturnPasses()`:

1. If the cloud lists this laptop's id as **superseded** (another laptop took the trip over), the laptop goes home, returns nothing and leaves its own files untouched (`becomeSuperseded`).
2. Phase `returning`. The cloud is told **quiesce**: it goes to `quiescing` (no spawns, no phone writes; the phone shows an overlay) under a new **epoch**. Running turns on the phone are waited for (up to 2 h) or cut (`--cut-running` / Cut).
3. The cloud snapshots under that epoch. A cloud-side git preflight failure (for example a merge or rebase in progress on the cloud) cancels the return: the cloud goes back to `active`, the laptop to `away`, and the message says to resolve it on the phone.
4. **The whole payload is downloaded into `trips/<trip>/return-<pass>/` before the first write.** The plan and `return-journal.json` are persisted before the first write too.
5. The journal applies, repo by repo, then non-git files, session state and a symlink re-sweep. The receipt is written (`receipt-<pass>.json`, final `receipt.json`).
6. Cloud finalization (D21): **wipe-secrets, then seal, then stop**. These are idempotent ensure-steps keyed by the epoch. If the cloud or GitHub cannot be reached, the steps are queued with the trip id in `~/.dreamcontext/handsfree/config.json` (`queued`) and run at the next contact; the laptop still goes home. If the phone kept working after the snapshot (the cloud is at a newer epoch), a **delta pass** runs, up to 3 passes (`MAX_RETURN_PASSES`). Past that, the later work is recovered by the next go.

### What lands, and what never overwrites

- **A repo nobody touched on the laptop:** commits, branches, tags, notes, the stash list (with messages), staged, unstaged and untracked changes and deletions all land. The laptop's refs are first backed up under `refs/handsfree/backup/<trip>/*`.
- **A repo whose refs, HEAD, stash list or index changed on the laptop while away:** it is **parked**. The cloud's refs, stash entries and snapshot commits go under `refs/handsfree/<trip>/*`, the laptop repo is untouched, and the receipt names it.
- **Only working-tree edits on the laptop:** the cloud snapshot applies, but a path changed on both sides keeps the laptop's file, and the cloud copy goes to `trips/<trip>/conflicts/`.
- **Non-git files** follow a three-way rule against the trip-start manifest (`apply.ts`). A path changed on both sides, or deleted on one side while changed on the other, keeps the laptop's state; the cloud copy goes to conflicts. **Return never deletes a laptop non-git file** (D20): a path missing in the cloud is listed "deleted on the phone, kept here".
- **Secret-class files edited in the cloud** come home over the laptop's copy (D16), after a backup. The receipt lists names, never contents. Then the class is wiped from the cloud. One absent in the cloud is "not returned", never a deletion.
- **Every laptop file the Return overwrites is copied to `trips/<trip>/backup/` first**, so Roll back can restore it.
- **Sessions:** the Chat roster, titles and tab map merge per entry (`session-merge.ts`). The cloud wins per entry, except that `chatPermissionMode` and `bypass` always keep the laptop's value, and a cloud-only roster entry lands with `bypass:false`. A transcript changed on both sides keeps the cloud version; the laptop copy goes to conflicts. An open laptop dashboard re-hydrates (roster generation, 409 on a stale write).
- **Auto-executing config changed in the cloud** (`.claude/**`, `.mcp.json`, `.husky/**`, `lefthook.yml`, `.pre-commit-config.yaml`, `.envrc`, `.vscode/**`, `.idea/**`, `memory/**`) is applied (D11) and listed in the receipt with its plain-text diff.
- **Never written on either side:** a path with a `.git` segment at any depth (after NFC and case folding), `..`, an absolute path, NUL, a backslash, a root-escaping symlink, or a mode-160000 entry (`paths.ts`).

### Resume, Roll back, Abandon

- **Resume** (`handsfree resume`) replays the journal. After the download it is **offline-first** (D23): finishing the local apply never needs the cloud or GitHub, and the cloud steps are queued if unreachable.
- **Roll back** (`handsfree rollback`) is offered only once a return has written. It undoes every pass's own ops, newest first: refs from `refs/handsfree/backup/<trip>/*`, the stash list from the journal, and files from `trips/<trip>/backup/`. A file the owner changed after the Return wrote it is kept and named. Then the trip is `away` again and the cloud is unquiesced, so the phone can continue or Return can be retried.
- **Abandon** (`handsfree abandon`) is offered from `going` and `away`, from `returning` before any write, and when GitHub refuses a start. It never deletes cloud work (D12). It seals the cloud if it can reach it and marks the trip abandoned and unrecovered. **The next go recovers first** (`recoverTrip`): recovery quiesce → cut → a *tolerant* snapshot (a merge/rebase in progress is captured with conflict markers as content and `MERGE_HEAD`/rebase heads saved as refs) → every cloud ref into `refs/handsfree/<old-trip>/*` and its files into `trips/<old-trip>/orphaned/` → seal, all under one epoch. A tolerant snapshot is never applied to a working tree.

`handsfree status` → `offers` always says which of these are allowed right now.

### Where the trip lives on the laptop

`~/.dreamcontext/handsfree/`: `state.json` (phase), `config.json` (laptop id, codespace, verifier generation, the queue, the uptime count), `credentials.json` (the hands-free GitHub token, kept apart from the brain-sync token, and the transfer secret), and `trips/<trip>/`. A trip directory holds the go and return journals, `start/` and `agreed/` snapshots, `return-<pass>/` payloads, `backup/`, `conflicts/`, `orphaned/`, receipts and `recovery-report.json` (`journal.ts`, `local-store.ts`).

---

## Ownership, quota, retention, disk

- **Ownership (AC24).** The cloud records the laptop id (`lp-…`, `config.json`) that started a trip. Go, setup and teardown from another laptop are refused while that trip is live. `go --take-over` on a sealed cloud adopts it directly. On a live trip it asks twice, runs the D12 recovery into this laptop's `refs/handsfree/<old-trip>/*` and `trips/<old-trip>/orphaned/`, and marks the old laptop superseded.
- **Quota (AC23).** GitHub's REST does not expose the remaining quota (`codespaces.ts` returns null), so the laptop counts its own uptime against a 120 core-hour budget (`status` shows it). A go is refused before the start when the remainder is below the estimate plus the reserve. When GitHub itself refuses the start, the error says why; Abandon unlocks the laptop and the cloud work is recovered later. The CLI prints exactly that.
- **Retention (AC22).** Codespaces are created with `retention_period_minutes=43200` (30 days unused). From day 20 (10 days left) `status` warns, while the last trip is away or abandoned and unrecovered (`retentionWarning`). The recovery runs at the next go (or teardown) that reaches the cloud. A codespace GitHub deleted takes unreturned work with it; there are no disk snapshots.
- **Disk (AC22).** See Go step 1.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "The cloud machine's port 8080 is private (GitHub answered with a sign-in redirect…)" | The forwarded port lost its public visibility. `cloud/poststart.sh` sets it public at every start, but a manual change or a failed start can undo that. | Open github.com/codespaces → the codespace → Ports, set 8080 to Public, re-run the command (`cloud-client.ts` `PortPrivateError`). |
| "about N h of Codespaces quota remain this month…" or GitHub refused the start | The quota (or GitHub's own limit) is used up. | Wait for the monthly reset, or `handsfree abandon` to unlock the laptop now. Nothing is lost: the next go recovers the cloud work first. |
| `trip_lost` / "the cloud machine lost the marker of trip …" | The mirror's trip marker is missing. | With the folders on disk, the laptop runs the full recovery (snapshot before seal) and keeps everything. With the folders absent (`mirror_absent`), nothing is sealed or wiped; retry later or `teardown --discard-abandoned-work`. |
| "another laptop took this cloud machine over" (`superseded`) | Another laptop ran `go --take-over`. | Nothing to do: this laptop is unlocked and its own files are untouched. The work is on the other laptop. |
| "the cloud copy is not ready to come back; resolve it on the phone" | A merge/rebase in progress or a stale lock on the cloud copy. | Finish or abort the merge from the phone's Chat, then `handsfree return` again. The laptop stays away. |
| "the private repo … changed since this laptop wrote it" (`tampered`) | Someone edited `<owner>/dreamcontext-handsfree`. | Check who changed it, then `handsfree setup` rewrites it. |
| "the return already wrote to the laptop: only Resume or Roll back" | A Return was interrupted after its first write. | `handsfree resume` (works offline) or `handsfree rollback`. |
| "Upgrade refused: hands-free mode is away" | Upgrades wait until home, so the cloud runs this exact build. | Return first. |
| The phone shows the asleep page | The cloud stopped itself. | Tap Wake (github.com must be signed in on the phone); the app reconnects. |
| Passphrase leaked | Anyone with it has the cloud. | `handsfree password` (new passphrase, every device signed out), or `handsfree devices revoke --all`. Both stay pending until the cloud confirms. |

Security model, the gate chain and the full recovery procedure: `_dream_context/knowledge/dashboard-server-security.md` § Cloud mode (hands-free). Design record and residuals: `_dream_context/knowledge/features/hands-free-cloud-mode.md`.
