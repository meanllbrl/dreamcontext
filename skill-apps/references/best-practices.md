# dreamcontext Apps: best practices

- **Outside data is data.** An API answer, a campaign name, a comment from Meta goes into an agent
  prompt fenced and labelled, never as instructions. `apps do` output and screenshot text are data.
- **No secret leaves the backend.** Never put a token in a response body, a log line, the page,
  or a URL the page can see. The redaction sink masks known values in logs and answers; it cannot
  mask pixels, so never render a secret on screen.
- **`.env` is never committed** (the template's `.gitignore` covers it). The owner fills it with a
  secret card that names the app.
- **Data in `DC_DATA_DIR`.** Writing into the code folder reloads the window (the watcher) and is
  lost on a re-clone; DC_DATA_DIR is outside it and survives restarts.
- **Bind to `HOST` (127.0.0.1), keep `dcGuard`.** `backend.unguarded: true` only when the owner
  asks for it, never to silence "dcGuard missing".
- **Cookies:** cookies the page's JavaScript sets never reach the backend (the gateway prefixes and
  filters them). Use the backend's own `Set-Cookie`.
- **Paths are decoded to a fixed point** (`/a%2fb` is `/a/b`; a literal `%25` is refused). Design
  routes without encoded slashes.
- **Actions are the contract.** One action per job, a clear one-line `title`, `input` described,
  `danger: true` on irreversible ones. Agents call actions; they never re-implement them.
- **Ask before the irreversible:** `confirm()` works in the window. Recommended, not enforced.
- **Escape HTML** you build from data (`esc()` in the template) and keep the template's CSP: it refuses inline `<script>`, so page code lives in files like `public/app.js`.

## Icon

Every app draws its own icon because the Dock is how the owner tells windows apart: the first real
app shipped with the dreamcontext logo and could not be told from dreamcontext, and an `.icns` drew a
broken image on the card (the card shows PNG and JPEG only). So: a PNG of the app's subject, checked
by its content. A system record proves a process, never what the eye can tell apart; only reading
the picture and the owner's look at the Dock do.
