# eval:whiteboard-visual — results

`node eval/whiteboard-visual/run.mjs <before|after> <main|agent>` (see the header of `run.mjs`).
One real `claude` turn per run in a fresh synthetic vault ("Lumen Notes"); `before` = the CLI,
skills and briefings of `71f2c615`, `after` = this branch. PNGs and turn logs land in
`tmp/eval-whiteboard-visual/` (not committed).

## 2026-10-21 (model: the machine default, Opus)

Prompts:
- **sync**: "Whiteboard'a Lumen'in senkronizasyon motorunun nasıl çalıştığını anlatan bir şey kur."
- **screens**: "Whiteboard'a telefon uygulamasının üç ekranını koy ve her birinin ne işe yaradığını anlat."

| scenario | actor | variant | run | excalidraw skill | notes (words) | drawn shapes | pictures | drawn words | cost $ |
|---|---|---|---|---|---|---|---|---|---|
| screens | main | before | `screens-before-main-1` | no | 3 (71) | 0 | 3 | 0 | 0.37 |
| screens | main | before | `screens-before-main-2` | no | 3 (69) | 0 | 3 | 0 | 0.35 |
| screens | main | after | `screens-after-main-1` | yes | 0 (0) | 8 | 3 | 78 | 0.53 |
| screens | main | after | `screens-after-main-2` | yes | 0 (0) | 8 | 3 | 86 | 0.52 |
| sync | agent | before | `before-agent-1 *` | no | 0 (0) | 0 | 0 | 0 | 0.23 |
| sync | agent | before | `before-agent-2` | no | 0 (0) | 0 | 0 | 0 | 0.16 |
| sync | agent | before | `before-agent-3` | no | 0 (0) | 0 | 0 | 0 | 0.16 |
| sync | agent | after | `after-agent-1` | no | 0 (0) | 19 | 0 | 112 | 0.41 |
| sync | agent | after | `after-agent-2` | no | 0 (0) | 17 | 0 | 126 | 0.44 |
| sync | agent | after | `after-agent-3` | no | 0 (0) | 20 | 0 | 121 | 0.37 |
| sync | main | before | `before-main-1 *` | yes | 0 (0) | 0 | 0 | 0 | 0.83 |
| sync | main | before | `before-main-2` | yes | 0 (0) | 26 | 0 | 149 | 0.7 |
| sync | main | before | `before-main-3` | yes | 0 (0) | 25 | 0 | 173 | 0.8 |
| sync | main | after | `after-main-1` | yes | 0 (0) | 25 | 0 | 156 | 0.61 |
| sync | main | after | `after-main-2` | yes | 0 (0) | 22 | 0 | 139 | 0.59 |
| sync | main | after | `after-main-3` | yes | 0 (0) | 21 | 0 | 142 | 0.59 |

`*` first harness version, which read only `control-panel`: `before-main-1` drew on a board of its
own (its answer: a new "Senkronizasyon motoru" board, drawn with the excalidraw skill);
`before-agent-1` put nothing anywhere (its answer: "Tahtaya hiçbir şey kuramadım").

What it shows:
- **Board agent** (no skills, no `node`, the card's exact allowlist): before, 3 of 3 turns put
  NOTHING on the board (`cat …; dreamcontext whiteboard --help` and `whiteboard draw --help` match
  no rule; the agent concluded it had no Bash). After, 3 of 3 ran `whiteboard kit`, wrote a spec into
  `automations/output/<self>/`, drew it with `draw --spec`, rendered, redrew in place: a flow, three
  panels, a takeaway; 0 notes.
- **Screens** (the shape of the owner's note-heavy board, 13 XL notes + 10 screenshots): before,
  2 of 2 never opened the excalidraw skill and wrote pictures + note widgets. After, 2 of 2 opened
  it and drew the pictures with a chip and short bullets under each, one drawing, 0 notes.
- **Sync, main session**: already drew before (the skill was opened 3 of 3 here); after, the same,
  and every run kept its spec in `_dream_context/workspace/` so it can redraw in place.

The after-agent runs used the code before the end review's fixes (flow gap, panel audit); those
fixes change the kit's geometry and audit, not what the agent is told or allowed.
