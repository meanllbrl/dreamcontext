# What was frozen (learn-202611)

The data lives in `~/.dreamcontext/eval-frozen/learn-202611/`, outside the repo (dir 0700,
files 0600). `scripts/learn-eval/freeze.ts` wrote it, and `manifest.json` there holds the sha256
of every file. This page names the files, their counts and their hashes. It holds no words.

## Sources

- `raw/olcum-2/`: measurement 2's data. That is 588 owner turns (`owner_final.json`: index,
  time, session id, project, surface, typed or card answer, his words), the 41 hand-labelled
  clusters (`clusters.json`), and the scripts that made them.
- `raw/olcum-3/`: measurement 3's data. That is the 68 sayings of an already written rule
  (`the68.json`), their labels (`rows.json`: in context, not in context, unknown, and where),
  the context scan (`scan.json`, `scan2.json`) and the child briefs (`child_*.json`).
- `raw/notes/`: the brain's measurement notes `olcum-1` to `olcum-4`.
- `raw/tilki-patterns/`: the Tilki vault's patterns before any backfill (criterion 7).
- `raw/replay.json`: the 101-prompt replay, only when one was handed over (`--replay`).
- `raw/dispatch.json`: frozen dispatch positives, only when handed over (`--dispatch`).

## Derived (read by every script; shapes in `scripts/learn-eval/lib.ts`)

- `derived/turns.json`: `{n, at, sid, proj, surf, kind, own}` per owner turn.
- `derived/clusters.json`: `{id, group, scope, rule, turns, landing}` per cluster.
- `derived/repeats.json`: `{cid, n, at, sid, proj, surf, g, act, where, charsBetween}` per saying.
- `derived/child-briefs.json`, `derived/dispatch.json`, `derived/replay.json`.
- `derived/baseline.json`: the counts below, also printed by `freeze.ts`.

## Hashes (pasted from the `freeze.ts` output at G-pos)

- TODO(G-pos): set sha256: `<from freeze.ts>`
- TODO(G-pos): frozen at: `<ISO time>`
- TODO(G-pos): the `derived/*.json` table (file, bytes, sha256), pasted from the "For eval/learn/FROZEN.md" block
- TODO(G-pos): raw file counts: olcum-2 `<n>`, olcum-3 `<n>`, notes `<n>`, Tilki patterns `<n>`
- TODO(G-pos): 101-prompt replay: frozen with `<n>` prompts, or "not found"
