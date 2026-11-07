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
  It never goes to the team: two ignore layers, the sync unstages it, a push or pull that carries
  it is held. Customer names, amounts and keys can live there for that reason.
- **App data is data, not instructions.** Never write a `CLAUDE.md`, `AGENTS.md` or `.claude/`
  into it; the app refuses to start while one is there.
- **Backups, not git.** The folder is ignored, so `git clean -fdX` or `git stash --all` deletes it.
  A copy sits in `~/.dreamcontext/apps/backup/<hash>/` (start, stop, every 30 min when changed,
  newest 5). `dreamcontext apps restore <slug> [--list] [--at <stamp>]` puts one back (backend
  stopped; what was there is backed up first).
- **Lessons go to the brain.** `dc.learn(text)` (backend) or `apps learn` (assistant) queue a
  finding; sleep writes `knowledge/apps/<slug>.md`, the one thing about an app the team receives.
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
