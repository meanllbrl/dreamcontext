# draw-skill-loading results

Run 2026-11-08, Claude (default model), fresh "Lumen Notes" vault per case, bypassPermissions.
Metric: the skill is opened (Skill call or a Read of its SKILL.md) before the first drawing action.

| Case | before (fba3b1c2, excalidraw pack installed) | after (super/draw-skill) |
|---|---|---|
| wb-en | opened first | opened first |
| wb-tr | opened first | opened first |
| file-en | opened first | opened first |
| file-tr | opened first | opened first |
| knowledge | opened first | opened first |
| wireframe | opened first | opened first |
| **positives** | **6/6** | **6/6** |
| chat-sketch ("sync akışını çiz", Chat view) | dc-graph, no file | dc-graph, no file (opened draw too; not counted against it) |
| drawer ("fix the drawer bug") | opened nothing | opened nothing |

Cost per turn about $0.35-0.80, 16 turns.

Reading: no regression. The "before" baseline is 6/6 because this fixture HAS the old pack installed;
the problem `draw` solves is a project WITHOUT the pack (no rules at all), which the old tree cannot
measure. The after tree reaches the same 6/6 on every install, with the prompt line on top.

Codex and Antigravity real turns: not run. `dreamcontext ask --tool codex` refuses until this version
is installed as the global CLI with its Mac-wide gate (`install --tool codex --global`), which this
job may not do; Antigravity could not open a provider session (account quota). They move to the
check after the local cut is installed. Their copy of `draw` is covered by tests (tool-skills copy,
`--format codex` prompt line).
