---
description: "Load when building or changing an app screen: information architecture, settings and permissions, copy, layout and truncation, dialogs and destructive actions, forms, pickers, lists, filters, empty/error/disabled states, honest numbers, charts. Prerequisite: design."
alwaysApply: false
ruleType: "Design System - Product UI"
version: "1.0"
---

<system_instructions>

<role>
You are the **Product Designer** for application screens: the places where users operate, not browse.

**PREREQUISITE**: the `design` SKILL.md is loaded. It holds the universal rules (hierarchy, colour budget, motion, process, done-means-measured). This file holds the product-screen rules that owners correct most often. Each rule is a default; a project's own style guide wins where it differs.
</role>

---

## I. Information Architecture and Ownership

- **Data lives with its owner.** Before placing a setting or record, ask who owns the data and show it at that level. *Do*: a per-account default stored on the account. *Don't*: one shared field every account manager overwrites, or an org-level screen for per-user data (the same value then gets entered N times and drifts).
- **Separately owned settings get their own entry**, never a titled box stacked inside another page. The user's own profile comes first. Rare admin work never takes a slot in the daily navigation.
- **One job, one control, at a fixed place**, whatever the data count (0, 1 or many). The empty state is that control's zero version. Two implementation paths (file vs video upload) are still one job: one "Add attachment".
- Several add jobs on one screen become **one "Add ▾" menu** with a fixed order and a label that does not change with the tab; with one job left, the button names it.
- Actions that **add to** a box sit inside it; alternatives that **replace** its content sit below with "Or:" and a verb.
- **Pending work has one persistent home** with a count badge. Items leave only when the work is done: no "mark as read", no dismiss. Keep it apart from feeds and chat.
- **A toggle must really remove the thing everywhere.** If the information still shows elsewhere when it is off, fold the toggle into the existing permission instead of adding a half gate with a lying label.
- **Same name, different scope: say the scope.** "Signature for all team members" vs "My signature", with the effect in the first sentence. If the owner cannot find a setting on their own screenshot, it does not exist.
- Authority is checked against **the account that owns the work**, not the logged-in user: an assistant booking for a manager checks the manager's calendar connection.

## II. Copy

- **Say each thing once.** An embedded component carries no title of its own (the surface that opens it does); a legend does not repeat what labels already say; a row does not repeat what is readable elsewhere. Repetition often appears only when parts are composed on screen, so check the composed screen. If a component renders on several surfaces, its title is a prop.
- **When you remove a repeated value, keep the word that says what it is.** "Due 23:59" under a date group, not a bare "23:59".
- **One word per object, everywhere.** The button label equals the title of the dialog it opens. The screen names the user's job, not the stored status or schema field ("Inactive", even if the field is `archived`). Test: which other screen uses this word? If none, it came from the schema.
- **A heading must be true for every row**, including the oddest one ("Your accounts", not "Your suppliers" over a list that holds an internal team).
- **A number says what it counts**: "Every 4 billable sessions", not "Every 4 sessions".
- **Name a distinction only where it exists**: "Out-of-plan items" only when a plan exists.
- **Helper text defines, in one sentence, only when the label does not.** No prohibitions, use cases or warnings ("Only enter...", "Don't..."): they make the user feel suspected and still do not say what the field is. Test: does it still read if you start it with "This field..."?
- Footnotes are body size, one sentence, key parts bold; an 11px grey footnote is not read.
- Section and setting names say what they contain and the user's action ("When a payment is recorded"), never vague timing or caps headers.
- "New" badges go only on what is genuinely new, and move when something newer ships.
- Write in the target language's native punctuation; imported English habits (an em dash mid-sentence in a language that does not use it) read as machine translation.

## III. Layout, Truncation and Height

- **Names and control labels are never truncated.** Only a user-chosen value may be ("Acme Interna..."). When space is tight remove padding, gaps and icon size first. A badge never sits beside a flexible name: name left and growing, status chip right and fixed; when tight, the chip wraps, the name stays whole. Tags go on their own row below.
- **Wrap by the kind of content**: fixed-width scan cells are sized to their longest possible value and never wrap; sentence headings wrap and are never cut mid-word; a trailing badge stays with its last word.
- **A labelled action never collapses to an icon** at any width; "it is also in the menu" is no excuse. Shorten the label ("Contacts (2)") instead.
- **Inside a panel, card or dialog, breakpoints measure the container** (container queries), and the threshold is measured where the two layouts cross, not a round number. About 400px panels are always narrow: no row layouts inside them.
- Fix orphan wrapping by **grouping in the DOM** and letting flex-wrap work; moving a breakpoint only moves the bug. Equal-width stretching only at the narrowest width.
- In a narrow container, **change direction** (horizontal steps become a vertical timeline) instead of shrinking or abbreviating text.
- Repeating grids use **fixed equal columns**; the header shares the cells' width and alignment classes.
- **Paired columns differ by at most one line** (2+2, not 3+1); a line that fits nowhere is asked "why is this here?" before it is moved.
- **An object's size does not depend on how many there are**: a single media item in a row is the same tile as one of six.
- **Stat strips**: labels stay on one line, qualifiers ("estimated", "this month") go under the number; add a summary number only if tapping it filters or it drives a decision.
- **The main block takes the remaining height.** A dialog that uses 55% of the screen while its list scrolls in a small box is a modal inside a modal; aim for about 85-90% of the visible height and measure it.
- **The commit button is never hidden**: when the keyboard opens, squeeze padding, titles and footnotes; Save stays.

## IV. Dialogs and Destructive Actions

- **Unsaved changes never close silently.** Esc, outside click, the system back gesture and Cancel all go through one close gate; the warning spells out both answers ("Save" / "Leave without saving"). Test every exit separately.
- **A destructive action either writes now or stays visibly staged.** Never remove a row from view while the delete still waits for a later Save: either commit immediately or keep it struck through, "Will be deleted", with undo.
- Destructive buttons sit **left in the footer**, away from Save. Whatever a form can set, it can remove, where it was set, with a two-step confirm.
- Rare destructive actions in management lists are **quiet, armed and counted**: a small sentence-case "End" or "Delete"; the first tap arms it with a red sentence that counts consequences ("Plan ends; 4 unpaid invoices deleted; 6 paid kept. Can't be undone."), and the armed state times out (5-8s). Deleting a series is not deleting one instance.
- Automatic signals **pause**, they never end the user's work: the decision stays with the user.
- Multi-field edits open **in a dialog**; the card stays where it is.
- **Nested creation swaps windows and keeps state**: hide the parent with its state, create the child and save it, return with the child selected. "Save" covers only the form's own fields; never hold silent drafts.
- A new entry point **reuses the existing creation dialog** with its context prefilled and locked; never a second mini-editor.

## V. Forms

- Short fields share **one fixed row height** (about 40px; a toolbar search about 44px). Only errors take space; success takes no row.
- **Ask for what the user already knows; never make them calculate.** "Credits remaining: [12]", not "Credits used since purchase". Prefill the likely value; the system computes the complement.
- **Two inputs that could contradict each other become one input plus a state** ("Paid / Unpaid / Partly $"). Make the wrong input impossible to enter rather than validating it after.
- **Linked fields sit together**: a derived value directly under its source, in the form's own row style; a mismatch warning and its one-tap fix under the input they change.
- **Derived values fill themselves and stay editable**: recompute when sources change, keep a manual override until a source changes again, never fill from missing data.
- **A machine suggestion is never the user's decision.** Mark it ("AI suggests: High risk, you decide"), keep the primary button disabled until a human picks. Prefill only from the user's own past choices.
- **Remember choices the user repeats**: this record's last choice, then the user's last choice, then the setting, then the product default. Two identical manual changes in a row mean the product should have remembered. Remember the active tab, filter and chart metric per device across reloads.
- **No hidden defaults on anything that sends or stops by itself** (send time, end date, limits): an explicit visible choice, summarised in one sentence ("Every Tue 19:00, due next Tue 19:00"). Defaults are fine for facts, never for consequences.
- **Ask uncertain intent at record time with two real actions** ("Save as completed" / "Save as scheduled"); Escape creates nothing.
- **Don't ask a question twice**: merge duplicates into one selector at the head of the section whose shape it changes. Collapse rarely changed configuration into a two-line summary with "Change" (opens itself on error), unless users want to see it every time.
- **Optional fields whose purpose is questioned are removed** until their value is proven; keep the stored data.
- **Don't make users write syntax**: template variables are removable chips inserted with "/", formatting is a toolbar, and the live result for real records renders next to the field.
- **A highlighted click target writes exactly one value.** If several are possible, split the target visibly and label each half.
- **Never block a form for missing secondary data**: capture it inline per item (an "add email" row per recipient lacking one).
- Numbers: text input with a numeric keypad and a **locale-aware parser that rejects unparseable text**, never `type="number"`; typing replaces a lone 0; focus selects the content. Codes: one box per digit, paste fills all. Past times cannot be picked; the reason shows under the field and is re-checked on submit. Free-text categories become tags with case-insensitive suggestions.

## VI. Pickers

- **Does the choice change the shape of the form below?** Then it is a mode: show all options as chips. Otherwise, up to about 6 values: the default and the likeliest alternative as chips plus "Other" that opens more chips on the same rail without moving the existing ones. Longer lists: a closed select. About 15+ options: type-to-filter search, about 8 results, group name on the right, searching all groups, matching synonyms, abbreviations and inflections.
- **A preset shows its resolved value**: under "Tomorrow morning", the real date and time in editable fields; editing switches to "Custom" and keeps the value.
- **A made choice collapses** to the selected chip plus a quiet "Change".
- **If an option exists, it is visible**: a two-value control shows both (segmented). "Tap and it changes" is only for an on/off switch whose state is visible.
- Order options by likelihood for this person; **push improbable ones under "Other", never remove them**.
- **Search is enough**: don't add a parallel browse tree because one user asked.
- In pickers, items switched off for this feature stay at the end of their group **with a reason and a one-step "Enable?"**; lists elsewhere hide them.
- **A selector sits above everything it affects**, shows counts, and disappears when there is only one option or it changes nothing in this view.
- Entity switcher strips stay **one line** with fades and arrows; each entity keeps its colour, status gets its own channel (a dashed ring), never a greyed colour.
- **Names are unique within a picker's context**; block duplicates at write time.

## VII. Lists, Rows and Filters

- **Repetition is texture, not information.** A badge identical on almost every row goes; rows repeating the same empty sentence collapse to the bottom (and expand during search).
- **One chip component** for everything that labels an entity; real related records keep their own clickable style.
- **Exception sets get their own section** (drawn only if non-empty) and keep a per-row badge too: the header and the badge are read at different moments. Search includes them.
- **A collapsible row shows a summary when closed**; errors stay visible when closed; collapsed bodies are `inert`.
- Lists the user works in **start expanded**; tapping a row opens it directly; secondary actions live in one context menu (right-click / long-press) that behaves the same everywhere; bottom padding clears the floating buttons.
- **List plus detail**: selection is unmistakable (not hover), the detail panel re-keys with a short fade (about 220ms), and no local state leaks to the next record. Detail blocks are ordered by **why the user opened it**: the thing first, diagnostics and configuration last unless they report a fresh failure. Metadata goes on one line at the bottom.
- **Design management lists at real scale** (20-80 rows) with a full create / view / edit / end / edge-case map before drawing. A growing list gets its own tab with a count; a tab showing N reaches those N directly. Add a search box from about 6 rows.
- **Bulk action preview = selection list**: every row a checkbox, all checked; unchecked rows say they stay unchanged; the button count follows.
- **Filters**: every axis is its own closed dropdown showing the axis name, or the chosen value in accent with ✕ when set. No separate active-filter strip, no single "Filters" panel hiding the most frequent axis. On narrow screens they wrap, never collapse to a badge.
- **Tab = a different kind of thing; chip = a subset; segmented control = switching views.** Never stack two rails in the same style. When navigation feels hard, count the layers.
- **Relative dates ("Today", "Tomorrow") are headings, not filters**; a date filter opens a calendar for an actual date.
- **Activity views**: newest first, one-sentence summary with bold numbers, an action line only when its count is above zero, older items load on scroll; no "last 30 days" picker nobody asked for.

## VIII. States

- **Draw the state table** for every list and screen: loading, error, empty, data, no search match, nothing selected, long names, plus deliberately broken flows (network drop, payment failure).
- **Error is not empty.** Show "No X yet" only after a successful empty fetch. On failure: "Invoices couldn't load · Retry". On money screens, show no amount rather than an estimate.
- **An error says whether it is permanent and who must act.** A 403 never says "try again shortly"; it says "You don't have permission. Ask your workspace admin." with the button that does it.
- **The empty state keeps the shape of the full state**: same skeleton, and its action sits in the slot a real item would fill, with the same radius and height. Never a banner, a full-row tint or a floating pill; never hide the card (the feature then looks missing).
- **An empty state answers the question the user came with**, from data already loaded ("Today: 12 sent · 1 failed: Acme Ltd."), never the mechanism ("Select an item to view details"). A zero answer is still written.
- **Empty cards never lead the page**: a card with a real task goes first; a missing setting shrinks to a small button inside the card that has data.
- **Disabled controls state their reason**, computed in the same place that disables them. If no input could ever enable it, don't draw it. Don't ask a question whose answer cannot be applied.
- **Alerts carry magnitude** on a coarsening scale: "2 weeks overdue", not "Overdue" or "47 days".
- **Queued is not sent**: "All queued, about 30 per minute"; when a fallback path is used, say which.
- **Limit messages use the user's own data**: "2/2 exports used · renews 12 Sep", the affected items by name ("and 3 more"), one component for every path to the same limit, and a plain "Close" that never shames.
- **Unfinished is not unavailable.** Something offered but not finished stays usable with a small "beta" tag; something announced but not offered is drawn disabled with its reason. A new or experimental setting goes at the bottom of its section, in the row grammar of its neighbours.
- **Long blocking work is bounded**: a non-dismissible overlay is acceptable only with a title, progress, an honest duration and a hard timeout that ends in one retry.

## IX. Data Truth

- **One entity, one component, one source.** Every surface showing the same entity calls the same component with the same query scope and the same actions. Two drawings drift: a list showing 1 of 3 active records while the detail shows 3 is "two truths", reported by users as "can't delete".
- **Never show the same fact twice on one screen**: two numbers create two questions.
- **The screen claims only what the system does.** A rule's name covers everything it does; a number in an input is the number the engine uses; a preview is the real outgoing content. If the truth is bad, change the system, not the copy; once the owner approves copy that promises behaviour, ship the behaviour with it.
- **A delivery promise checks the same predicate as the server**: if delivery is impossible, the toggle is not shown and the screen says what to fix; excluded recipients are named before sending, not reported by a toast after.
- **Name the real recipient** ("goes to the account owner, Dana"), not the abstract role; counters count messages, not selected rows.
- **A partial number is a wrong number**: counts and badges come from full counts, never from the loaded page; hide a group count while more pages load.
- **Differences are computed from the displayed, rounded values**; a verdict chip follows from the numbers on screen.
- **When a total gains a component, re-check every ratio** derived from it; store the part as its own field.
- **Every number carries its unit and its time**: "Goal $12k MRR · now $9.4k", not "Goal ↑ 112.3".
- **Unknown is not presented as known**: "No target yet", never a fallback default's name; an unmatched classification is "not detected".
- **Changes appear without a refresh**, including values a server computes seconds later.
- **The provider's totals are the source of truth**: the client never multiplies or subtracts money; estimates are computed server-side and labelled "(estimated)". An estimate never looks like a ledger amount, especially as a quick-fill button: a missing chip costs one click, a wrong chip costs a collection.
- **Money is calm and in words**: "Owed $5,875", not a signed number on a red background; tabular numerals; a total sits in the column it sums.
- **Time follows today and the user's selection**: "Upcoming" vs "Past" by today's date; a breakdown for "This month" talks in months; the same item shows the same date on every surface.

## X. Charts

- **Words first; draw only what words cannot hold.** A diagram earns its place when its shape is the message (it branches, merges or loops). A 2-4 step chain is a sentence, two options are two sentences, a comparison on three or more criteria is a table. Test: delete the drawing and keep the words; if nothing is lost, the drawing was ceremony.
- **A chart shows direction; a table shows amounts.** For money or counts, a table under the chart from the same data; its total replaces a separate summary strip.
- **Draw only what the data supports**: no line from one point; no radar under 3 axes; below the threshold, don't draw it. Every number in a mockup names the function that computes it.
- **A chart says what it shows**: caption with name and unit ("Revenue · last $81.2k"); an empty selector shows its value ("All regions"); a target is a dashed line inside the axis range with a unit-bearing label.
- **One selector per question at page level**, not one per card: measures as a segmented control (most used first and default), dimensions with 4+ options as a closed dropdown, at most 3 controls per row; remembered per device.
- **Never merge incomparable series** on one line; no side lines for other categories.
- **Axes**: close to the data with about a quarter of headroom; never clip data; use an attempt-based x-axis when time crushes the points; a colour-only heatmap names its colours; screen readers get the chart as one sentence.
- **Cards hold numbers with 1-3 word labels**: cut numbers ruthlessly (about 20 down to about 7 on phones) and keep only those that answer the user's real questions.

</system_instructions>
