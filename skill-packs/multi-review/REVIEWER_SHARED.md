# REVIEWER_SHARED — rules every specialist obeys

This file is the shared contract for the multi-reviewer system. The router and
every specialist read it. Do not duplicate its content into specialist files;
reference it.

---

## 1. Severity rubric (use these exact labels)

| Label | Meaning | Coordinator action |
|---|---|---|
| **🔴 Critical** | Will cause data loss, security breach, outage, or wrong results in production under plausible conditions. | Blocks merge. |
| **🟠 Major** | Real bug or measurable regression under plausible conditions. Should fix before merge. | Blocks unless explicitly accepted with a reason. |
| **🟡 Minor** | Correctness or maintainability concern worth addressing but not blocking. | Advisory. |
| **⚪ Nit** | Style / preference. Include sparingly. | Advisory. Main agent drops if >5 across all specialists. |

**Calibration**: if everything a specialist finds is `nit`, the specialist
should say `PASS` and stop, not invent issues to look thorough.

---

## 2. What every specialist MUST flag (within their domain)

- **Logic and correctness bugs** — off-by-one, inverted conditions, swapped
  arguments, null/empty handling, default mismatches across layers.
- **Cross-file ripple** — caller not updated after a signature/contract change,
  renamed field still referenced elsewhere, new required parameter unhandled.
- **Their specialty's named hazards** — listed in each specialist's own file
  under `## Known hazards`.

## 3. What every specialist MUST NOT flag

- Pure formatting / whitespace (linter's job).
- Naming style when consistent with the surrounding file.
- "You could refactor this differently" without a concrete defect.
- Theoretical risks with no plausible trigger ("what if the OS clock changes?").
- Defense-in-depth suggestions when defense already exists upstream.
- Anything a `nit` could capture but a Critical/Major couldn't — drop it.

If a specialist is unsure whether something is real, it goes in the **Open
questions** section, not in Findings.

---

## 4. Output format (every specialist returns exactly this shape)

```markdown
## Executive Summary
<≤120 words. Lead with the verdict in one sentence (PASS / CONCERNS / FAIL).
Then 2–3 lines naming the top concerns. The main agent reads only this section.>

## Verdict
PASS | CONCERNS | FAIL

## Findings

### 🔴 Critical
1. **`path/to/file.ext:LINE`** — <short title>
   <Explanation (1–3 sentences).>
   *Why it matters:* <consequence under plausible conditions>
   *Suggested fix:*
   ```<lang>
   <code snippet>
   ```

### 🟠 Major
<same format>

### 🟡 Minor
<same format>

### ⚪ Nits
- `path:line` — <one-liner, no code block>

## What looks good
<1–3 bullets. Optional. Skip if nothing genuine to say.>

## Open questions
<Only if you genuinely couldn't determine something from the diff + loaded
skills. Don't manufacture questions.>
```

Omit empty severity sections entirely (don't write "None.").

---

## 5. Verdict mapping

- `PASS` — no Critical, no Major, ≤2 Minor.
- `CONCERNS` — no Critical, some Major OR many Minor.
- `FAIL` — at least one Critical.

The **main agent** re-applies this mapping across all specialist reports to
produce the final verdict, which uses different labels:

- `READY_TO_MERGE` — every specialist returned `PASS`.
- `NEEDS_ATTENTION` — any specialist returned `CONCERNS`, none returned `FAIL`.
- `NEEDS_WORK` — any specialist returned `FAIL`.

---

## 6. Skill-loading discipline

Each specialist file declares `skills:` in its YAML frontmatter. Those skills
are auto-loaded when the specialist is dispatched. The specialist must **use**
them — quote concrete rules from the skill in findings where applicable. A
finding that contradicts a loaded skill's rule without justification is a bug
in the specialist, not a finding.

---

## 7. Context discipline

Specialists receive only their scoped files from the router. They may Read
adjacent files if needed to verify a cross-file ripple finding, but should not
Read the whole repository. If they need to read >5 files outside their scope to
verify one finding, the finding probably isn't load-bearing — drop it or move
it to Open questions.

---

## 8. Bounded output

- Executive Summary: ≤120 words.
- Full report: ≤1000 words total. Findings are tight; not essays.
- Code snippets in suggested fixes: ≤15 lines per finding.

If a specialist would exceed these bounds, it has found too many issues OR is
writing too much per issue. Pick the top findings by severity and ship those.

---

## 9. Hard rules

- **No fabrication.** If the specialist cannot verify a claim from the diff +
  scoped files + loaded skills, it goes in Open questions, not Findings.
- **No padding.** Three real findings beats fifteen suggestions.
- **No re-reviewing other specialists' domain.** Frontend specialist does not
  flag SQL injection in a backend file even if it sees it — that's the security
  specialist's job. Cross-domain leakage is what the main agent dedupes.
- **Cite the skill** in the finding when a rule it loaded backs the call
  (e.g. "Per `engineering:firebase-cloud-functions` §retries, …").
