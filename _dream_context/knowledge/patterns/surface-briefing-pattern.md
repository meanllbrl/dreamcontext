---
id: surface-briefing-pattern
name: "Surface Briefing Pattern (brief non-default surfaces explicitly)"
description: "When spawning an agent into a NON-DEFAULT surface (Chat vs Terminal, email reply, webhook handler), brief it explicitly about that surface's capabilities via --append-system-prompt-file, or it degrades to describing its output instead of rendering it. The briefing is surface-only (no persona, workflow, or work rules), travels safely through login-shell spawns, and degrades gracefully (failed write = un-briefed agent, not failed spawn). Pin the briefing and client parser in lockstep via shared tests."
tags: ["architecture", "decisions", "topic:agents"]
pinned: true
date: "2026-07-25"
---

## Why This Exists

The Chat view shipped with a recurring failure: the agent would finish drawing a board and say "done, it's at path/to/board.excalidraw.md" instead of embedding it with `![board](path)`. The root cause: a chat-spawned `claude` and a terminal-spawned `claude` are THE SAME BINARY — the agent has no native awareness of which surface it's in. Without explicit briefing, it defaults to terminal semantics (describe what you made, name the file) everywhere.

The surface briefing pattern emerged from this: brief the agent about the surface's rendering capabilities so it outputs markdown that USES them.

## The Pattern

### 1. Brief via `--append-system-prompt-file`, not argv prose

```typescript
// src/server/chat-surface.ts
const briefingPath = await writeChatSurfaceBriefing();
const args = [
  'claude', '-p',
  '--output-format', 'stream-json',
  '--append-system-prompt-file', briefingPath,  // NOT in argv directly
  // ... other args
];
execFile('$SHELL', ['-ilc', `exec ${args.join(' ')}`]);
```

**Why file-based:** the spawn goes through a login shell (`-ilc`) to inherit the user's PATH/env. Prose in argv must be shell-escaped, which is fragile and error-prone when the briefing contains markdown examples with special chars. A tmpfile (mode 0600, cleaned on exit) keeps argv clean.

### 2. Briefing content: surface capabilities ONLY

```markdown
# Surface: Chat View

You are running in the dreamcontext Chat view, not a terminal.

Your markdown is rendered as a native UI:
- `![board](path/to/x.excalidraw.md)` draws the board inline on a live pan/zoom canvas.
- `![caption](image.png)` / `[text](video.mp4)` render/play in place.
- A path in backticks with separator+extension or trailing `/` becomes a clickable chip.
- A fenced ```dream-actions block (JSON array) becomes real buttons under your message.

DO NOT describe what you made — show it. Use the markdown above.
```

**What to EXCLUDE:** persona, workflow rules, task-specific instructions. The briefing is ONLY "in this surface, markdown X becomes UI Y." All work-level context still comes from the user's prompt and the brain's SessionStart preload.

### 3. Degrade gracefully

```typescript
try {
  await fs.writeFile(briefingPath, briefing, { mode: 0o600 });
} catch (err) {
  console.warn('Failed to write surface briefing, spawning un-briefed:', err);
  // remove --append-system-prompt-file from args
  // spawn proceeds WITHOUT the briefing — agent describes instead of renders
}
```

A failed briefing write NEVER fails the spawn. The agent runs un-briefed (describes output verbally) rather than the user seeing "spawn failed."

### 4. Pin briefing ↔ parser in lockstep via tests

The briefing promises certain markdown shapes. The client parser must handle those shapes. When either changes, the other must change. A shared test suite pins both.

```typescript
// tests/unit/agent-board-assets.test.ts
describe('Surface briefing ↔ parser contract', () => {
  it('briefing promises ![board](x.excalidraw.md), parser extracts it', () => {
    const briefing = readChatSurfaceBriefingTemplate();
    expect(briefing).toContain('![board](');
    
    const parsed = parseChatMessage('![board](docs/arch.excalidraw.md)');
    expect(parsed.boards).toHaveLength(1);
  });
  
  it('briefing promises backticked paths, parser makes them clickable', () => {
    // similar pinning
  });
});
```

This is the mechanical guard: drift between promise and parser breaks a test.

## When to Apply

- **Always** when spawning into a non-default surface (Chat, not Terminal).
- **Maybe** for surfaces with different rendering from the primary one (email reply, Slack bot, webhook handler — all non-TTY).
- **Never** when the surface IS the default (terminal spawn needs no briefing — it's already a terminal).

## Reusability

Any future non-TTY surface needs this pattern:
1. Identify what markdown shapes the surface CAN render (inline media, buttons, special blocks).
2. Write a briefing telling the agent those shapes exist.
3. Write the client parser that handles those shapes.
4. Pin both in a shared test.
5. Degrade gracefully (failed briefing → un-briefed spawn, not error).

## Known Instances (as of 2026-07-26)

### Instance 1 — Chat view rich output (boards, media, paths, actions)
- **Where:** `src/server/chat-surface.ts` — the Chat view briefing for non-`dream-view` capabilities.
- **Shapes briefed:** `![board](x.excalidraw.md)` → inline pan/zoom canvas; `![](image)` / `[](video)` → inline media; backticked paths → clickable chips; ` ```dream-actions ` → button row.
- **Parser:** `chatActions.ts` `parseChatActions()`.
- **Pinned by:** `tests/unit/agent-board-assets.test.ts`, `tests/unit/chat-actions.test.ts`, `tests/unit/chat-clickable-paths.test.ts`.

### Instance 2 — Chat view interactive answer objects (`dream-view`)
- **Where:** `src/server/chat-surface.ts` — the Chat view briefing extension (2026-07-26).
- **Shapes briefed:** ` ```dream-view ` fence with typed JSON → chart (line/bar/scatter/area/distribution), page (widgets: stack/rail/card/table/text/stat/image/divider), checklist (pinned window, vault+conversation scoped).
- **Parser:** `chatViewSpec.ts` `parseViewBlock(json, toAction)`.
- **Pinned by:** `tests/unit/chat-surface-lockstep.test.ts` — executes the briefing's own three fenced examples through the real parser AND asserts bidirectional coverage between the briefing's named types and `VIEW_TYPES`.
- **Size budget enforced:** `CHAT_SURFACE_BRIEFING.length < 3000` (test assertion in `agent-board-assets.test.ts` — briefing landed at 2916/3000, ~180 tokens added for the three-type protocol).
- **What makes this a distinct instance:** the brief promises structured JSON payloads the client validates per type (15 `MAX_*` caps, graceful degradation on invalid input, notices for dropped content), not markdown shapes the parser extracts. The briefing grew 955 chars and stayed under budget by trimming to a capability list — no examples for every widget, just the contract.

## Two refinements learned from the `dream-view` addition (2026-07-26)

**The briefing has a hard size budget, and it should be enforced by a test.** `agent-board-assets.test.ts` already asserted `CHAT_SURFACE_BRIEFING.length < 3000`. The base was 1961 chars, so the entire three-type `dream-view` protocol had to fit in ~1000 — it landed at 2916/3000 (~180 tokens added, against a ~560-token estimate). The budget did its job: it forced the briefing to stay a capability list rather than becoming documentation. **Set such a bound the moment a briefing exists**, because this file rides in the system prompt of *every* turn and there is no natural pressure against growth. When the bound binds, trim the briefing — never raise the bound to fit the prose.

**Pin by executing the briefing's own examples, not by grepping it.** The lockstep test in §4 above checks that the briefing *contains* a shape and that the parser handles that shape — two assertions that can drift apart. Stronger: extract the briefing's own fenced examples and run them through the real parser. `chat-surface-lockstep.test.ts` does this — every `dream-view` example in the briefing is fed to `parseChatActions` → `parseViewBlock`, plus a bidirectional check that every `VIEW_TYPES` member is named in the briefing and vice versa. An example the UI cannot actually parse now turns the suite red, which is the file's own standing rule ("a capability named here that the view doesn't render is worse than one left unnamed") enforced mechanically instead of trusted.

## Anti-pattern: bloating the briefing

**Don't** use the surface briefing to inject:
- Persona ("you are a helpful assistant").
- Workflow rules ("always ask before deleting").
- Task-specific instructions ("the user wants X").

The briefing is ONLY surface capabilities. Everything else travels through the normal prompt/SessionStart path.
