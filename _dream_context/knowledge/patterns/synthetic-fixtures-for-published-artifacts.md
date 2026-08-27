---
id: synthetic-fixtures-for-published-artifacts
name: "Synthetic Fixtures For Published Artifacts"
description: "Anything this repo PUBLISHES — a screenshot, a code comment's worked example, a test fixture — must name a fictional project and a fictional person, never one from the author's machine. The demo vault set is the shared vocabulary; a machine-read denylist test is the gate. Applies to any artifact built by photographing or transcribing a real working environment."
tags: ["architecture", "decisions", "topic:announcements", "topic:privacy", "domain:knowledge"]
pinned: true
date: "2026-08-27"
updated: "2026-08-27"
---

## Why This Exists

On 2026-08-27 an audit of the What's New feed found that three released versions had
published the owner's private work inside the npm tarball and the public GitHub repo:

| Shipped in | What it published |
|---|---|
| `v0-24-0/chip-strip.png` | A client's entire task board — every card title, in Turkish — plus four private project names |
| `v0-23-1/core.png` + `people.png` | The owner's full legal name, under a PEOPLE heading |
| `v0-26-1/launcher.png` | Five private project names and their logos |
| `v0-26-1/peer-mention.png` | A peer product's positioning statement — market, customer, pricing model |
| `v0-26-1.json` | A real client file path and an internal field name, in a `terminal` block |

The same sweep then found the leak was not a screenshot problem at all. It was
everywhere the codebase reached for a worked example: ~300 references to private
projects — five of them, by name — and ~130 to the
owner's identity (full name, slug, two real email addresses, a GitHub login, hardcoded
`/Users/<name>/` import paths) — in code comments, in CLI `--help` text, in test
fixtures, in skill docs, in agent prompts. `src/` and `dashboard/src/` build into
`dist/`, so a comment naming a client shipped to every npm install.

Nobody did anything careless. Each one was written by an author reaching for the most
vivid example to hand, which is always the real thing they were looking at.

## The Pattern

### 1. Name the two surfaces that publish

- **PHOTOGRAPHED** — screenshots, clips, recorded terminal output. These capture
  whatever was on screen. You choose prose word by word; a screenshot takes everything.
- **TRANSCRIBED** — code comments, doc examples, `--help` strings, test fixtures. These
  are chosen, but the choice is made while staring at real data.

Both leak. The second leaks more, because it never feels like publishing.

### 2. One fictional vocabulary, used everywhere

A shared cast beats ad-hoc invention: an author reaching for "a project name" finds one
already sitting there, and a reviewer spotting an unfamiliar name knows it is a leak.

| Role | Use |
|---|---|
| Projects | `acme-storefront`, `acme-payments`, `acme-design`, `atlas-mobile`, `field-notes` |
| People | `Kerem Çınar` / `kerem`, alongside the existing `Ada Lovelace` / `ada` |
| Hosts, mail | `acme.example`, `kerem@example.com`, `kerem@example.test` |
| Org paths | `acme-co/acme-brain.git` |

Names must be plausible enough that a screenshot doesn't read as a mock-up, and
impossible to mistake for anyone's real project.

### 3. Photograph a fixture, not a machine

`e2e/announce-demo-vaults.mjs` builds the cast as REAL vaults under a throwaway `$HOME`,
then serves the app against it. The isolation is the whole trick:

```js
// listVaults() resolves under homedir(), and Node honours $HOME on POSIX — so the app
// reads a registry containing only the demo set. The real ~/.dreamcontext/vaults.json
// is never opened: nothing to back up, nothing to restore, nothing to get wrong.
run(dir, ['init', '-y', '--name', v.name, ...], { env: { ...process.env, HOME } });
```

A fixture that must photograph well needs more than existing: seed it a board, write it
a real soul. `init`'s `(Add your principles here)` placeholders photograph as an
unfinished product.

**Where shooting the real thing is still fine.** The test is not "is this mine" but "is
anything on this screen someone's private information". This repo's own Lab board is
fine — every insight in it is a `demo-*` fixture with invented numbers.

### 4. Preserve the meaning, drop the name

A scrub that deletes the fact is worse than the leak, because the record stops being
true. Rewrite so the sentence still carries what it knew:

| Before | After |
|---|---|
| `<client> is a B2B tutoring SaaS` | `acme-payments is the service that owns every refund` |
| `ported from <client>'s Concierge` | `ported from a sibling project's Concierge` |
| `(<client>) going 500 -> 350` | `(a large peer vault) going 500 -> 350` |

Provenance stays provenance. A measurement stays a measurement.

### 5. Gate it with a denylist read from the machine, never written down

```ts
// ~/.dreamcontext/vaults.json is the launcher's registry — the same list the leaked
// screenshots came from — and it lives OUTSIDE the repo. Hardcoding those names into a
// test file in a public repo would itself be the leak. On CI the file is absent and
// these cases self-skip; the generic patterns still run everywhere.
function localVaultNames(): string[] { /* … minus the product's own name */ }
```

Four checks, and the last two are safe to hardcode because they are shapes, not data:
locally registered project names · the git `user.name`/`user.email` · `/Users/…`-shaped
paths · email addresses.

**Prove the gate can fail.** Inject a known leak, watch the test go red, restore. A
denylist test that never fires is indistinguishable from one that cannot.

### 6. Expect the rename to break real assertions

Fixture names carry meaning beyond their spelling, and a global substitution destroys it
silently. Both of these were caught only by running the suite:

- The new first name sorted before `lina` where the old one did not — a roster-order
  assertion flipped.
- `Nuraydın → Yılmaz` created a **third** Yılmaz in a fixture whose entire point was that
  exactly two members share a surname. Renamed that one to `Çınar`, which still carries
  the dotless `ı` the diacritic-folding test exists to prove.

Before substituting, ask what each fixture name is *for*: sort position, case contrast,
diacritics, collision. Never reuse a name already in the cast — `ada` was already the
second example person, and collapsing two people into one would have gutted every
multi-person test while leaving them green.

## When NOT To Apply

- **Functional constants that name the real public project.** `meanllbrl/dreamcontext` as
  `APP_RELEASE_REPO` / `UPSTREAM_REPO` / the About link is this project's own repo. Scrub
  it and the updater breaks.
- **Genuinely untracked local files.** A file git does not track publishes nothing, so it
  may name whatever is true. But VERIFY it, and verify it twice — this audit got the
  answer wrong in both directions within one session. First a shell loop mis-read its own
  exit code and reported 17 brain files as tracked when the check was inconclusive; then
  `git ls-files _dream_context` returned 0 and was believed, when it had run from a
  subdirectory that the shell's working directory had silently changed to. The brain is in
  fact tracked — 372 files of it, public.

  ```bash
  cd "$(git rev-parse --show-toplevel)"     # a pathspec is relative to CWD
  git ls-files <path> | wc -l               # 0 means untracked; check the count, not $?
  ```

  Whenever a privacy answer rests on "that file isn't public", re-run the check from the
  repo root and read the count. `$?` from a pipeline is the last command's, not grep's.

## Applying It

```bash
# What does this repo actually publish? Only tracked files, plus whatever `files` ships.
git ls-files -z | xargs -0 grep -lniE '<private-names>'
node -p "JSON.stringify(require('./package.json').files)"

# After any scrub: the suite is the fixture-semantics gate, not tsc.
CI=1 npx vitest run tests/unit --reporter=dot
```

## Related

- `skill-announcements/SKILL.md` — "The privacy rule" and "The coverage gate"
- `e2e/announce-demo-vaults.mjs` — the cast, as buildable vaults
- `tests/unit/announcements.test.ts` — `the shipped feed carries nothing personal`
