# Learning-loop evals (`eval/learn`)

These are the frozen evals of the learning-loop plan (`ogrenme-dongusu`, section "Evals",
gate G-pos, criteria 5 to 11, 14, 16 and 17). The scripts live in `scripts/learn-eval/`. This
folder holds four files, and only these four are allowed in the repo:

- `README.md`: this file.
- `FROZEN.md`: what was frozen (file names, counts, sha256). It holds no words.
- `BASELINE.md`: the "today" numbers recorded at G-pos.
- `fixture.synthetic.json`: synthetic turns for a fictional project and a fictional owner. It has
  the same shape as the frozen set and is used by the unit test and by `--fixture` runs.

The owner's real turns never enter the repo. `freeze.ts` copies them to
`~/.dreamcontext/eval-frozen/learn-202611/` (dir 0700, files 0600). Every other script reads them
from there, and results go to `~/.dreamcontext/eval-frozen/learn-202611/results/`.

## Order

| step | script | cost | when |
| --- | --- | --- | --- |
| 1 | `freeze.ts` | $0 | G-pos, once. It prints the FROZEN.md table and the BASELINE.md numbers. |
| 2 | `reach.ts --phase before` | $0 | G-pos. It prints the T table; the lead freezes T. |
| 3 | `repeats.ts --phase before` | $0 | G-pos |
| 4 | `position.ts` | about $17-20 | right after W1, beside W2. Add `--arm p2` (about $8-10) only if P1 misses the bar. |
| 5 | `reach.ts --phase after`, `repeats.ts --phase after` | $0 | after W2 |
| 6 | `surfaces.ts` | about $20 | Close |
| 7 | `sleep-replay.ts` | about $5 | Close |
| 8 | `updated-input-probe.ts` | about $1 | Close |

Run each one with `npx vite-node scripts/learn-eval/<name>.ts -- [flags]`, after a fresh
`npm run build:cli`. The scratch vaults run this checkout's `dist/index.js`, never the global CLI.

## Spend

Each model-spending script (position, surfaces, sleep-replay, updated-input-probe) does three
things:

- It prints its estimate before the first run (`SpendGuard.announce`). Until it has, a run is
  refused.
- Before each run it checks the shared ledger
  `~/.dreamcontext/eval-frozen/learn-202611/spend.jsonl`, which every script writes to. It stops
  before any run that could take the total over `DREAMCONTEXT_EVAL_MAX_USD` (default 60, never
  above the owner's hard cap of $60).
- It caps each run with `--max-budget-usd`.

`--dry-run` prints the plan and the estimate and spends nothing. Every run uses
`claude -p --model opus --output-format json` with `--settings`. Fable is never used.

## Isolation

- Each scratch vault has its own fake HOME. A `dreamcontext` shim pins every CLI call, and every
  hook Claude starts, to that fake HOME.
- Claude itself keeps the real HOME so it stays signed in. Its settings deny reads and writes
  under the real brains, the checkouts and `~/.dreamcontext`.
- `surfaces.ts` reports whether the real `~/.dreamcontext/me` or `owner-words` changed during
  the run.
