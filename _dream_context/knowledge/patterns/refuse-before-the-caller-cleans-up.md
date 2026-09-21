---
id: know_gS632yb6
name: patterns/refuse-before-the-caller-cleans-up
description: >-
  A pluggable delivery that can be REFUSED must say so before the caller tears
  down the user's state. Restoring afterwards only restores what you remembered
  to restore — and you will forget one.
tags:
  - 'kind:pattern'
  - architecture
  - frontend
  - 'domain:correctness'
pinned: false
date: '2026-09-21'
---

## Why This Exists

A shared component hands work to a pluggable host and then cleans up after itself — clears the
field, drops the staged attachments, releases the quote. That sequence is correct for every
host that ACCEPTED the work and destructive for any host that did not.

The `#agents` channel mounts the chat's `Composer` through an adapter host. A message naming
no agent has nobody to answer it, so the host refuses. The first implementation refused and
then put the draft back, using the seam built for exactly that (`draftEpoch`, "the host
replaced the draft wholesale").

It restored the text. It silently dropped the file.

`commit()` clears in four steps — `setDraft('')`, `syncDraft('')`, `dropSentAttachments()`,
`onClearQuote()` — and the restore only addressed the first two. The attachment chip was gone
before anyone could put it back, and the assertion written for the restore ("the sentence is
put back, not eaten") passed, because it only ever asked about the sentence.

## The Pattern

**Give the delivery a way to say "I did not take this", and let the caller skip the whole
teardown.** Not a way to undo it afterwards.

```ts
// The seam: returning nothing means delivered, which every existing host already says.
send(text: string): void | false;

// The caller: one branch, before any cleanup.
else if (session.send(message) === false) return;
setDraft('');
session.syncDraft('');
dropSentAttachments(convId);
onClearQuote();
```

Nothing was delivered, so nothing is cleared. The draft, the chips and the quote are all
still the user's, untouched, with a note under them saying why.

## What This Retires

The restore-afterwards version needed a one-shot `swallowNextSync` ref, because `commit`
called `syncDraft('')` one line after the delivery returned and that `''` landed on top of the
draft the refusal had just restored. So the fix depended on the ORDER OF STATEMENTS inside a
function in another module — a coupling nothing could enforce and no type could express.

Refusing first deleted that ref, the epoch counter, and the coupling. **A correct fix is
usually smaller than the workaround it replaces.** If yours is bigger, the model is probably
wrong.

## How To Recognise It

- A callback returns `void`, and the caller does cleanup after calling it.
- The callee has a legitimate reason to decline (validation, addressing, a closed slot).
- Cleanup spans MORE THAN ONE piece of state, and only some of it is easy to reconstruct.

That last point is what makes this a trap rather than an inconvenience. Text is easy to hold
and put back, so a restore looks like it works. An object URL, an in-flight upload, a revoked
handle — those are gone, and they are gone quietly.

## Anti-patterns

- **Restoring after the teardown.** You will restore the state you were thinking about.
- **A `boolean` return meaning "success".** Make the refusal the special value (`false`) and
  silence mean delivered, so every existing implementation stays correct with no edit. A
  `true`-means-ok contract breaks every `void` host at once.
- **Testing the refusal with text alone.** Stage the awkward thing — a file, an upload
  mid-flight — and refuse with THAT on screen. The text path is the one that survives by
  accident.
