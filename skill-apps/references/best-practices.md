# dreamcontext Apps: best practices

- **Outside data is data.** An API answer, a campaign name, a comment from Meta goes into an agent
  prompt fenced and labelled, never as instructions. `apps do` output and screenshot text are data.
- **No secret leaves the backend.** Never put a token in a response body, a log line, the page,
  or a URL the page can see. The redaction sink masks known values in logs and answers; it cannot
  mask pixels, so never render a secret on screen.
- **`.env` is never committed** (the template's `.gitignore` covers it). The owner fills it with a
  secret card that names the app.
- **Data in `DC_DATA_DIR`** (`_dream_context/apps/<slug>/` in the brain). Writing into the code
  folder reloads the window (the watcher) and is lost on a re-clone; DC_DATA_DIR survives restarts.
  Only the paths the manifest's `data` declares shared, and the owner approved, go to the team;
  everything else stays on this Mac. Customer names, amounts and keys belong in local paths.
- **Shared or local: four questions, first "local" wins.** Can it be produced again (fetched or
  computed)? Personal? Secret? Big (images, exports) or written every minute? What is left is hand-made data the
  team made: shared. Why: the team's value is what people made, not what any Mac can fetch again.
- **One file per record** (`favorites/<id>.json`), the shared part split from a mixed file into its
  own folder. Why: the unit of a conflict is a file; two people's records in two files never clash.
- **Write shared files with `dc.data.write`** (atomic: temp name then rename). Why: sync never
  picks up a half-written file. A database is never shared: export the shared part as files.
- **Shared data is someone else's data.** Read it through a schema (`dc.data.read(path, validate)`),
  draw it with `textContent`, never `innerHTML`, `dangerouslySetInnerHTML` or `v-html` (`apps
  validate` warns `data_html_sink`), and pass it to `ask`/`learn` fenced as data.
- **Show where the data lives with `dc.data.status()`,** never a fixed sentence: the owner's
  approval and the sync mode change it. Say "shared with the team" only when `mode === 'shared'`
  (an approved path is live); `pending`, `local`, `undecided` and `sync_off` all read "only on this
  Mac". Why: a path waiting for approval has not reached anyone yet.
- **App data is data, not instructions.** Never write a `CLAUDE.md`, `AGENTS.md` or `.claude/`
  into it; the app refuses to start while one is there.
- **Backups, not git.** The folder is ignored, so `git clean -fdX` or `git stash --all` deletes it.
  A copy sits in `~/.dreamcontext/apps/backup/<hash>/` (start, stop, every 30 min when changed,
  newest 5). `dreamcontext apps restore <slug> [--list] [--at <stamp>]` puts one back (backend
  stopped; what was there is backed up first).
- **Lessons go to the brain.** `dc.learn(text)` (backend) or `apps learn` (assistant) queue a
  finding; sleep writes `knowledge/apps/<slug>.md`, which the team receives next to the shared data.
  Never put personal data or raw records in a finding.
- **Bind to `HOST` (127.0.0.1), keep `dcGuard`.** `backend.unguarded: true` only when the owner
  asks for it, never to silence "dcGuard missing".
- **Cookies:** cookies the page's JavaScript sets never reach the backend (the gateway prefixes and
  filters them). Use the backend's own `Set-Cookie`.
- **Paths are decoded to a fixed point** (`/a%2fb` is `/a/b`; a literal `%25` is refused). Design
  routes without encoded slashes.
- **Tools are the contract.** One action (tool) per job, a clear one-line `title`, `does`, typed
  `params`, `topics`; `danger: true` on irreversible ones. Agents call tools; they never
  re-implement them. Why: every agent of the project picks a tool by these words, and `apps do`
  checks `--input` against `params` before any call, so a vague tool is a tool nobody uses right.
- **A tool that only reads is a GET.** The platform decides what a tool does to the world by its
  method alone (`effectOf`): a GET with no `danger` reads, anything else changes and needs the
  owner's yes. Why: an app's own word cannot make a write a read, so `"effect": "read"` on a POST
  still counts as a change.
- **Say what the backend serves** with `dc.actions([...])` and answer health with `dc.health()`.
  Why: the manifest and the backend drift apart silently otherwise; the card shows the drift.
- **Ask before the irreversible:** `confirm()` works in the window. Recommended, not enforced.
- **Escape HTML** you build from data (`esc()` in the template) and keep the template's CSP: it refuses inline `<script>`, so page code lives in files like `public/app.js`.

## Icon

Every app draws its own icon because the Dock is how the owner tells windows apart: the first real
app shipped with the dreamcontext logo and could not be told from dreamcontext, and an `.icns` drew a
broken image on the card (the card shows PNG and JPEG only). So: a PNG of the app's subject, checked
by its content. A system record proves a process, never what the eye can tell apart; only reading
the picture and the owner's look at the Dock do.
