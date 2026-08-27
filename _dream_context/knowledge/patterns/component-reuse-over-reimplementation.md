---
id: component-reuse-over-reimplementation
name: "Component Reuse Over Reimplementation"
description: "When a new surface needs existing UI behavior (chat, permissions, composer), mount the existing components on the new context rather than hand-rolling copies. The data is the parameter; the components are not."
tags:
  - "kind:pattern"
  - "frontend"
  - "architecture"
  - "ui"
  - "topic:reuse"
pinned: false
date: "2026-08-26"
---

## Why This Exists

When building a new surface that needs behavior an existing component already provides, the reflex is to "make it look similar" by hand-rolling a simplified copy. This creates three problems:

1. **Feature drift** — the hand-rolled version starts with a subset of the real component's capabilities and drifts further behind every time the real one changes
2. **Duplicate maintenance** — every fix, improvement, or new feature in the real component must now be manually ported to the copy
3. **Inconsistent UX** — users encounter two slightly different versions of "the same thing" and neither behaves the way they expect in all contexts

The peer mail UI hit all three: a hand-rolled textarea (no slash menu, no attachments, no model/effort/mode triggers), hand-rolled Allow/Deny buttons (no command preview, no edit diff, no "always allow"), and a pre-wrapped string for the transcript (no markdown rendering, no tool cards, no code fences, no file chips). The owner corrected: "A peer session IS a chat, so it gets THE CHAT."

## The Pattern

**When a new surface needs behavior an existing component provides:**

### Step 1: Identify what VARIES (the context/data), not what REPLICATES (the behavior)

Ask: "What is different about this surface?"
- Not: "It needs a text input with a send button" (that's a composer)
- But: "It needs to talk to a DIFFERENT agent session" (that's the data)

The peer session needs:
- A transcript of PEER messages (data: `items` from the peer's session)
- Permissions for the PEER's requests (data: `pending` from the peer's session)
- A composer that sends to the PEER (data: `session` pointing to the peer)

The components themselves (`ItemView`, `PermissionCard`, `Composer`) are generic — they work on ANY chat session object, not just the main one.

### Step 2: Make the data parameterizable, not the behavior

Instead of:
```tsx
// BAD: hand-rolled copy
<textarea value={input} onChange={...} />
<button onClick={send}>Send</button>
```

Do this:
```tsx
// GOOD: mount the real component on different data
<Composer
  session={peerSession}  // ← the ONLY parameter that varies
  model={chrome.model}
  effort={chrome.effort}
  // ... all the same props the main pane uses
/>
```

The session is what changes; the Composer is not.

### Step 3: Verify the mounting by construction

If the real component has a known class name or test hook, assert on it in the new surface's verification:

```js
// GOOD: regression to a bespoke widget fails the suite
await expect(page.locator('.peer-panel .chat-cmp-input')).toBeVisible();
await expect(page.locator('.peer-panel .chat-cmp-send')).toBeVisible();
await expect(page.locator('.peer-panel .chat-permcard')).toBeVisible();
```

If the component is accidentally replaced with a hand-rolled copy, these selectors vanish and the test fails.

## When to Make an Exception

**When the existing component is TIGHTLY COUPLED to a single context and cannot be cleanly parameterized without a full refactor**, a new component is warranted. But that threshold is high. Signs the existing component IS reusable:
- It already takes the varying data as props (e.g., `session`, `items`, `pending`)
- Its behavior is the same regardless of WHERE it's mounted
- Other surfaces already mount multiple instances of it (e.g., main chat pane + sub-agent drill-in both use `ItemView`)

If you're about to hand-roll a copy, ask first: "Can I pass the real component the data it needs?"

## Concrete Example — Peer Session (v0.25.0)

**Before (hand-rolled):**
- Textarea + send button → no slash menu, no attachments, no model/effort triggers, no queue, no drafts
- Two Allow/Deny buttons → no command preview, no edit diff, no "always allow"
- `<pre>{transcript}</pre>` → no markdown, no tool cards, no file chips

**After (mounted real components on peer's session):**
- `<Composer session={peerSession} ... />` → slash menu, attachments, model/effort/mode, queue, drafts
- `<PermissionCard item={p} session={peerSession} ... />` → command preview, edit diff, always-allow
- `<ItemView item={item} ... />` → markdown, tool cards, code fences, file chips

Cost: ~1KB less CSS (the hand-rolled rules), zero feature drift risk, zero duplicate maintenance.

**Lesson (generalizes past this surface):** When a new surface needs a chat-shaped thing, the session is the parameter; the components are not.

## Related Patterns

- **Surface Briefing Pattern** (`surface-briefing-pattern.md`) — how to brief an agent about what the surface CAN render, when the surface changes
- **Build & Propagate Pattern** (`build-and-propagate-pattern.md`) — ensures the bundled dashboard is current, so reused components are the real ones

## Last Verified

2026-08-26 (peer mail UI — `scripts/verify/peer-mail-ui.mjs`, 43 assertions, reuse proven by `.chat-cmp-*` selectors inside `.peer-panel`).
