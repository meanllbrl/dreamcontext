---
id: know_9LT8AJ7I
name: patterns/every-store-key-needs-a-death
description: >-
  A module-level store keyed by an id needs a birth AND a death for every key —
  and the teardown must hang off the key's real lifetime, not off whichever
  component happens to hold the value. A hardcoded key has no lifecycle of its
  own, so an owner must volunteer in writing.
tags:
  - 'kind:pattern'
  - architecture
  - frontend
  - 'domain:correctness'
pinned: false
date: '2026-09-21'
---

## Why This Exists

`composerScratch` is a module-level store of the composer's staged state — attachment chips
and the reply quote — keyed by conversation id. It owns object URLs, and `dropScratch(id)` is
the single place they are revoked. Its header is explicit about why the key is the conversation
and not the component: chips must outlive a pane respawn.

Two surfaces then mounted that composer with no conversation behind them, both reporting
`claudeId: ''`. Two independent bugs, one cause:

**`''` is not a key, it is the absence of one.** The meeting room and the agents channel shared
a single bucket, so a file staged in one appeared in the other.

**Nobody ever dropped those keys.** `dropScratch` is called from exactly one place —
`closeSessionById`, "the one path that ends a conversation for good" — which knows about chat
sessions only. A pasted image staged in either surface and then abandoned held its object URL
for the life of the app run, once per visit.

Naming the buckets fixed the first (`scratchId: 'agents-channel'`, `'meeting-room'`). The
second needed an owner — and the obvious place was wrong.

## The Second Half: Whose Lifetime Is It?

The composer lives in `AgentsFeed`, so the teardown went there. It looked right and read well:
"unmounting IS this channel's for good — there is no respawn to survive here."

It was wrong. The page's Messages/Agents toggle unmounts the feed, and so does clicking an
agent's NAME in any message. Glancing at the roster threw away a file the user had just
attached — the exact loss the store exists to prevent. The bucket belongs to the CHANNEL,
which is the page; the feed is one view inside it.

```ts
// wrong: fires on a tab switch, which is not leaving
AgentsFeed:        useEffect(() => () => dropScratch('agents-channel'), []);
// right: fires on leaving the page, which is what ends the channel
AutomationsPage:   useEffect(() => () => dropScratch('agents-channel'), []);
```

## The Pattern

For a module-level store keyed by an id:

1. **Every key needs a birth and a death.** A store whose entries are only ever created leaks
   by construction — silently, and worse when the values hold handles (object URLs, sockets,
   watchers, timers).
2. **A fixed key needs a named owner.** Ids that come from data get their death from the data's
   lifecycle. A hardcoded key (`'agents-channel'`) has no such lifecycle, so some component
   must volunteer, in writing.
3. **Hang the death on the key's REAL lifetime, not on the component that happens to hold the
   value.** Ask what the key means, then find the thing whose life matches it. If the component
   can unmount while the key is still meaningful, it is the wrong owner.
4. **An empty-string key is a bug, not a default.** Two hosts with "no id" are not the same
   host. Require a real key or make absence a separate, non-keyed path.

## How To Recognise It

- A `Map`/`Record` at module scope, outliving every component by design.
- A teardown function that exists and has ONE caller.
- A new consumer that has no natural id and passes `''`, `null`, `'default'`, or `0`.
- A key that is a literal in the source.

The tell for #3: write down the sentence "this key stops being meaningful when ___". If the
answer is not the component holding the effect, move the effect.

## How To Prove It

Both halves are assertable, and the reviewer that found the tab-switch bug found it by reading
rather than running — so pin it:

```js
// paste an image, walk Messages → Agents → Messages, the chip must still be staged
await page.locator('.agents-switch-opt', { hasText: 'Agents' }).first().click();
await page.locator('.agents-switch-opt', { hasText: 'Messages' }).first().click();
check('a staged attachment survives a trip to the roster and back', await chip.count() === 1);
```

Mutation-tested: putting the teardown back on the feed fails this check.

## Anti-patterns

- **Reusing a sentinel id across unrelated consumers.** Give each a name; make the field that
  keys the store separate from any field that also means something else (here `claudeId` is
  also the session-stats poll key, and a truthy value there starts a request for a
  conversation that does not exist).
- **Hanging cleanup on the nearest component.** Nearest is not the same as owning.
- **"Nothing ever closes it, so there is nothing to clean."** That is the leak, stated as a
  reason not to fix it.
