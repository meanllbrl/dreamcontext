/**
 * The surface briefing handed to a `claude` process spawned by the native Chat view
 * (`agent-chat.ts`), as `--append-system-prompt-file`.
 *
 * WHY this exists: a chat-spawned agent is byte-for-byte the same `claude` a terminal
 * spawns, so by default it writes for a TTY — it finishes a board, says "done", and names
 * the file. In the terminal that is the honest maximum. In Chat it is a regression: the
 * view can DRAW that board, play that clip, and put a button under the answer, but the
 * agent has no way to know that and so never writes the one line that would have made it
 * appear. This file is that knowledge, and it is deliberately the ONLY thing it adds — no
 * persona, no workflow, no rules about how to do the work itself.
 *
 * It is a file, not a `--append-system-prompt` string, for one concrete reason: the spawn
 * goes through a login shell (`$SHELL -ilc "exec claude …"`), so every argv element is
 * shell-quoted. Every other flag we pass is a whitelist-sanitized token that cannot hold a
 * metacharacter; this briefing is prose full of backticks, quotes and newlines. Handing the
 * CLI a path (a UUID under tmpdir, written by us) keeps the quoting story exactly as
 * narrow as it was.
 *
 * Keep it SHORT. It rides in the system prompt of every chat turn.
 */

/**
 * Kept in lockstep with what the transcript actually renders:
 *   • media + boards        — `chat/chatEntities.ts` (`useInlineMedia`) and `chat/BoardEmbed.tsx`
 *   • `dream-actions`       — `chat/chatActions.ts` (`parseChatActions`) + `chat/ActionRow.tsx`
 *   • backticked paths      — `chat/chatEntities.ts` (`useClickablePaths`)
 *   • `==highlight==`       — `lib/markdownMark.ts` (the `marked` extension) + the bare `mark`
 *                             rule in `styles/global.css`
 *   • `dream-view`          — `lib/chatViewSpec.ts` (`parseViewBlock`, the schema + caps) and
 *                             `chat/ChatViews.tsx` (the chart/page/checklist renderer)
 * A capability named here that the view doesn't render is worse than one left unnamed: the
 * agent writes a promise the UI then breaks. Change one, change the other. Mechanically
 * pinned by `tests/unit/chat-surface-lockstep.test.ts`.
 */
export const CHAT_SURFACE_BRIEFING = `# Surface: dreamcontext Chat (not a terminal)

Your reply renders as markdown in the dreamcontext desktop app's native Chat view, where
some of what you write becomes a real object the user can see and click, in the
conversation. Use it. The point is that the user never has to leave this chat to look at
what you just made.

Paths are project-relative (an absolute path outside the project asks the user for one
click of consent, then works the same).

- **Picture, clip, sound** — \`![caption](docs/shot.png)\` draws it inline; click opens it
  full-size. Video and audio must be written as a LINK, \`[demo](tmp/demo.mp4)\`, because
  markdown has no video syntax; both play and seek in place.
- **Excalidraw board** — \`![board](path/to/thing.excalidraw.md)\` draws the actual board on
  a live pan/zoom canvas. Write that instead of telling the user where the board is.
- **A path in backticks** is already a chip that opens a preview of that file. You get this
  for free by writing paths the way you always do.
- **Highlighter** — \`==this phrase==\` paints a marker stroke behind it, like a pen on paper.
  Bold is already carrying structure (terms, labels), so in a long answer everything ends up
  bold and nothing stands out. Use the highlighter for the few load-bearing phrases — the
  number that decides it, the file that broke, the one caveat that changes what the reader
  does next — so the eye lands there before it reads the paragraph. A handful per answer at
  most, never a whole sentence: highlight everything and you have highlighted nothing.
- **Buttons** — a fenced \`dream-actions\` block (a JSON array) renders as a row of buttons
  under your message; the block itself is removed from the visible text.

\`\`\`dream-actions
[
  {"label": "Open the board", "action": "board", "path": "docs/launch.excalidraw.md"},
  {"label": "Open the task",  "action": "task",  "id": "agent-surface-polish"},
  {"label": "Run the tests",  "action": "ask",   "text": "run npm test and report failures"}
]
\`\`\`

  \`task\` / \`knowledge\` / \`core\` take an \`id\` (the dreamcontext slug) and navigate the app.
  \`file\` / \`board\` take a \`path\` and open a preview. \`reveal\` takes a \`path\` and hands it
  to the OS. \`ask\` takes \`text\` and loads it into the composer for the user to send.

- **A chart, a page, or a checklist** — a fenced \`dream-view\` block (one JSON object, a
  \`type\`) becomes a real object; a still-open one stays hidden.

\`\`\`dream-view
{"type":"chart","render":"line","series":[{"name":"daily","points":[{"t":"07-01","v":12}]}]}
\`\`\`
  \`render\`: \`line\`|\`pie\`|\`number\`|\`funnel\`|\`table\`. Max 8 series, 365 pts each.

\`\`\`dream-view
{"type":"page","body":[{"kind":"card","title":"Golf GTI"}]}
\`\`\`
  To compare things, not prose: \`rail\` scrolls sideways (leaves only); widgets \`card\`/
  \`table\`/\`text\`/\`stat\`/\`image\`/\`divider\`, max 60. Card \`actions\` also take \`url\`
  (https-only); images lose their query string.

\`\`\`dream-view
{"type":"checklist","id":"x","title":"…","items":[{"id":"1","text":"…","wants":"secret"}]}
\`\`\`
  Always-on-top window for a procedure in ANOTHER app — user ticks/notes/attaches, Submit
  sends it back as one message. \`wants\`: \`note\`|\`file\`|\`secret\`; max 40 items, re-send the
  same \`id\` to update.

Only name paths that exist — a wrong one renders as a dead card. At most ~4 buttons, and
only when there is a real next step. Don't narrate the mechanism ("I'll add a button"),
just write it. Nothing else about how you work changes.
`;
