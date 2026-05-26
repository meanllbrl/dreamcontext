---
name: biv-stage-definitions
description: >
  Defines all 9 stages of the Business Idea Validation pipeline: inputs,
  outputs, success criteria, kill signals, and confidence scoring rubric
  for each stage. Referenced by the orchestrator and all specialist agents.
---

# Stage Definitions — Business Idea Validation Pipeline

Each stage follows the same structure:
- **Agent**: which specialist executes it
- **Inputs**: which prior artifacts it consumes
- **Deliverable**: what it writes to disk
- **Success Criteria**: what PASS looks like
- **Kill Signals**: specific red flags that trigger KILL
- **Confidence Rubric**: how to score 1-5

---

## Stage 1: Problem Discovery

**Agent:** `biv-researcher`
**Inputs:** `00-brief.md` (user's idea brief)
**Deliverable:** `01-problem-research.md`

### What the agent does
- Searches Reddit (via `site:reddit.com` advanced queries), forums, Quora
  for real people expressing this problem
- Mines 1-star and 2-star app store reviews of related products
- Checks Google Trends for demand trajectory
- Quantifies problem severity using evidence (upvotes, comment counts,
  emotional language intensity)
- Collects 5-15 real quotes as evidence

### Deliverable structure
```markdown
## Problem Statement
[One clear sentence defining the validated problem]

## Evidence Summary
- **Forums/Reddit**: [# of threads found, key subreddits, date range]
- **Review Mining**: [which apps reviewed, common complaints]
- **Demand Trajectory**: [Google Trends signal: growing/stable/declining]
- **Search Volume Signals**: [relevant keywords and approximate demand]

## Top Pain Points (ranked by severity)
1. [Pain point] — Evidence: "[real quote]" (source, upvotes)
2. ...
3. ...

## Existing Alternatives
[How people currently solve this — tools, workarounds, manual processes]

## Kill Signal Check
- [ ] Problem is real and evidenced by multiple independent sources
- [ ] Problem is current (threads/reviews from last 12 months)
- [ ] People express willingness to pay or have tried paid alternatives
- [ ] Google Trends shows stable or growing interest

## Confidence: [1-5]
## Kill Signals: [list, or "none"]
## Executive Summary: [≤120 words]
```

### Success Criteria (PASS)
- Found ≥5 independent sources confirming the problem
- At least 3 pain points with real quotes
- Google Trends not declining
- People are already spending money on imperfect alternatives

### Kill Signals
- Google Trends shows sustained decline (>2 years downward)
- Cannot find anyone expressing this problem online (< 3 sources)
- Problem exists but is trivially solved by free tools already
- Problem is purely hypothetical — no real-world evidence found

### Confidence Rubric
| Score | Criteria |
|---|---|
| 5 | 10+ sources, strong quotes, growing trend, paid alternatives exist |
| 4 | 5-10 sources, good quotes, stable trend, some paid alternatives |
| 3 | 3-5 sources, decent quotes, flat trend, free alternatives only |
| 2 | 1-3 sources, weak quotes, unclear trend |
| 1 | Cannot find evidence the problem exists at meaningful scale |

---

## Stage 2: Customer Analysis

**Agent:** `biv-customer-analyst`
**Inputs:** `00-brief.md`, `01-problem-research.md`
**Deliverable:** `02-customer-analysis.md`

### What the agent does
- Identifies 2-4 distinct customer segments from the problem research
- Scores each segment using the 3 Question Stud framework (Size, Pain:Payment, Accessibility)
- Selects one beachhead segment
- Creates 1-2 detailed personas for the beachhead
- Defines buyer vs. user persona if they differ (B2B scenarios)

### Deliverable structure
```markdown
## Customer Segments Identified
| Segment | Size (1-10) | Pain:Payment (1-10) | Accessibility (1-10) | Total |
|---|---|---|---|---|
| [Segment A] | | | | |
| [Segment B] | | | | |
| ...         | | | | |

## Beachhead Selection
**Winner:** [Segment name]
**Justification:** [Why this segment scores highest and is the right starting point]

## Persona 1: [Name] (User Persona)
- **Profile:** [Job title, age range, background, responsibilities]
- **Goals & Motivations:** [What success looks like for them]
- **Pains & Frustrations:** [Specific to the validated problem]
- **Current Solutions:** [What tools/workarounds they use now]
- **Quote:** "[A representative quote from research]"

## Persona 2: [Name] (Buyer Persona — if different from user)
[Same structure]

## Confidence: [1-5]
## Kill Signals: [list, or "none"]
## Executive Summary: [≤120 words]
```

### Success Criteria (PASS)
- At least 2 distinct segments identified with scoring
- Clear beachhead selected with justified reasoning
- At least 1 detailed persona with goals, pains, and current solutions
- Persona is grounded in Stage 1 research, not hypothetical

### Kill Signals
- All segments score below 4/10 on Pain:Payment ratio
- No segment is accessible (all score ≤ 2 on Accessibility)
- The people who have the problem cannot pay for a solution

### Confidence Rubric
| Score | Criteria |
|---|---|
| 5 | 3+ segments scored, clear winner, personas grounded in rich data |
| 4 | 2-3 segments, reasonable winner, personas well-defined |
| 3 | 2 segments, scores close, personas partially hypothetical |
| 2 | Only 1 vague segment, persona mostly assumed |
| 1 | Cannot define who has this problem with any specificity |

---

## Stage 3: Market Sizing

**Agent:** `biv-market-analyst`
**Inputs:** `00-brief.md`, `01-problem-research.md`, `02-customer-analysis.md`
**Deliverable:** `03-market-sizing.md`

### What the agent does
- Calculates TAM, SAM, SOM using both top-down and bottom-up methods
- Sources data from industry reports, census data, LinkedIn, directories
- Cross-validates the two methods for sanity
- Applies the ambition-level gate (VC vs. bootstrapped)

### Deliverable structure
```markdown
## Top-Down Analysis
- **TAM**: $[X] — [source and methodology]
- **SAM**: $[X] — [filters applied: geography, segment, product fit]
- **SOM**: $[X] — [realistic capture rate and justification]

## Bottom-Up Analysis
- **Target customers**: [# in beachhead segment]
- **Annual price assumption**: $[X]/year
- **SOM**: [# customers] × $[price] = $[X]
- **SAM**: [total segment size] × $[price] = $[X]
- **TAM**: [global expansion] × $[price] = $[X]

## Cross-Validation
[Do top-down and bottom-up align? If not, which is more credible and why?]

## Ambition Gate
- **Ambition level**: [VC / Bootstrapped]
- **VC threshold**: TAM > $1B, SAM supports $100M+ revenue → [PASS/FAIL]
- **Bootstrapped threshold**: SOM shows path to $1-10M/year → [PASS/FAIL]

## Confidence: [1-5]
## Kill Signals: [list, or "none"]
## Executive Summary: [≤120 words]
```

### Success Criteria (PASS)
- Both top-down and bottom-up calculations completed
- TAM/SAM/SOM documented with sources
- Cross-validation shows reasonable alignment (within 3x)
- Ambition gate passes for the user's stated level

### Kill Signals
- SOM < $500K for bootstrapped, or SAM < $500M for VC
- Top-down and bottom-up diverge by >10x (one is likely wrong)
- Cannot find any data to estimate market size (too niche)
- Market is demonstrably shrinking (corroborates declining trends from Stage 1)

### Confidence Rubric
| Score | Criteria |
|---|---|
| 5 | Both methods align, strong data sources, clear ambition-gate pass |
| 4 | Both methods completed, reasonable alignment, gate passes |
| 3 | One method strong, one weak; gate barely passes |
| 2 | Only one method possible, limited data, gate questionable |
| 1 | Cannot size the market with any credibility |

---

## Stage 4: Competitive Intelligence

**Agent:** `biv-researcher`
**Inputs:** `00-brief.md`, `01-problem-research.md`, `02-customer-analysis.md`, `03-market-sizing.md`
**Deliverable:** `04-competitive-intel.md`

### What the agent does
- Identifies direct, indirect, potential, and substitute competitors
- Creates deep dossiers on the market leader + top 2-3 direct competitors
- Builds a feature comparison matrix
- Creates a 2x2 competitive positioning matrix
- Identifies the unoccupied strategic position (the gap)

### Deliverable structure
```markdown
## Competitor Map
| Competitor | Type | Est. Revenue | Target Customer | Key Strength |
|---|---|---|---|---|
| [Name] | Direct | | | |
| [Name] | Indirect | | | |
| ...    | ...      | | | |

## Deep Dossier: [Market Leader Name]
- **Size & Revenue:** [estimates]
- **User Base:** [who, how many]
- **Brand & Messaging:** [core message, perception]
- **Strengths:** [2-3 key strengths]
- **Weaknesses:** [2-3 from reviews/forums]
- **Innovation Speed:** [feature launches in last 1-2 years]

## Deep Dossier: [Direct Competitor 1]
[Same structure]

## Feature Comparison Matrix
| Feature | Our Concept | Leader | Comp. 1 | Comp. 2 |
|---|---|---|---|---|
| [Feature 1] | | | | |
| ...         | | | | |

## 2x2 Competitive Matrix
- **Axis X:** [e.g., Price: Low → High]
- **Axis Y:** [e.g., Complexity: Simple → Powerful]
- **Positions:** [where each competitor sits]
- **Empty quadrant:** [the opportunity]

## Strategic Position
"The market is crowded with [type A] and [type B], but no one is serving
customers who need [our unique position]."

## Confidence: [1-5]
## Kill Signals: [list, or "none"]
## Executive Summary: [≤120 words]
```

### Success Criteria (PASS)
- At least 3 competitors identified and categorized
- Deep dossier on market leader with strengths AND weaknesses
- Feature matrix showing at least one differentiation opportunity
- 2x2 matrix revealing an unoccupied or underserved quadrant

### Kill Signals
- Zero competitors found (almost always means no market, not an opportunity)
- All competitors have > 4.5 star ratings and dominant market share with no complaints
- The identified gap is trivially small or not valued by customers
- A well-funded competitor launched the same concept in the last 6 months

### Confidence Rubric
| Score | Criteria |
|---|---|
| 5 | Rich competitor data, clear gap, verified complaints, defensible position |
| 4 | Good data, reasonable gap, some complaints found |
| 3 | Moderate data, gap exists but unclear if valued |
| 2 | Limited competitor info, gap is vague |
| 1 | No competitors OR no discernible gap |

---

## Stage 5: Customer Validation (AI-Simulated)

**Agent:** `biv-customer-analyst`
**Inputs:** All prior artifacts (stages 0-4)
**Deliverable:** `05-customer-validation.md`

### What the agent does
- Synthesizes Reddit/forum data from Stage 1 with personas from Stage 2
- Simulates customer responses to the proposed solution concept
- Evaluates willingness-to-pay signals from real-world evidence
- Tests the value proposition against the personas' stated pains
- Identifies potential objections and adoption barriers
- **Confidence is capped at 3** — synthetic validation cannot exceed moderate confidence

### Deliverable structure
```markdown
> **Note:** This is AI-simulated validation based on forum/review data.
> Real customer interviews would increase confidence. Treat findings as
> hypotheses to verify, not proven facts.

## Simulated Response: [Persona 1 Name]
- **Reaction to core value prop:** [positive/neutral/negative + reasoning]
- **Willingness to pay:** [evidence from forum data — existing spend, price sensitivity]
- **Likely objections:** [based on complaints about similar products]
- **Adoption barriers:** [switching costs, habits, trust]
- **Would they try it?** [assessment + reasoning]

## Simulated Response: [Persona 2 Name]
[Same structure]

## Cross-Persona Patterns
- **Strongest signal:** [what resonates across personas]
- **Biggest risk:** [what could prevent adoption]
- **Price sensitivity:** [what the data suggests about willingness to pay]

## Synthetic Validation Score
- Problem resonance: [1-5]
- Solution fit: [1-5]
- Willingness to pay: [1-5]
- Adoption likelihood: [1-5]

## Confidence: [1-3] ← CAPPED (synthetic data)
## Kill Signals: [list, or "none"]
## Executive Summary: [≤120 words]
```

### Success Criteria (PASS)
- At least one persona shows strong positive signals
- Willingness-to-pay evidence exists (people already spending on alternatives)
- No dominant objection that the proposed solution cannot address
- Adoption barriers are surmountable

### Kill Signals
- Personas' stated needs directly contradict the proposed solution
- All willingness-to-pay signals are negative (people expect free solutions)
- Dominant objection that cannot be addressed (regulatory, trust, etc.)
- The competitive alternative is "good enough" — switching cost exceeds benefit

### Confidence Rubric (capped at 3)
| Score | Criteria |
|---|---|
| 3 | Strong forum evidence, clear WTP signals, resonates with personas |
| 2 | Moderate evidence, mixed signals, some alignment |
| 1 | Weak or contradictory evidence, poor persona fit |

---

## Stage 6: Synthesis & Hypothesis

**Agent:** `biv-strategist`
**Inputs:** All prior artifacts (stages 0-5)
**Deliverable:** `06-synthesis-hypothesis.md`

### What the agent does
- Creates the Opportunity Snapshot (one-page synthesis of all research)
- Identifies the 2-3 riskiest assumptions
- Formulates a testable solution hypothesis using the structured framework
- Proposes 3-5 prioritized features using RICE scoring
- Defines the "How Might We..." questions that bridge problem to solution

### Deliverable structure
```markdown
## Opportunity Snapshot
- **Core Problem:** [one sentence, from Stage 1]
- **Target Persona:** [name, from Stage 2]
- **Obtainable Market (SOM):** [from Stage 3]
- **Key Competitor:** [from Stage 4]
- **Competitive Gap:** [from Stage 4]
- **Customer Signal:** [strongest evidence, from Stage 5]

## Riskiest Assumptions
1. **[Assumption]** — Impact: [1-10], Uncertainty: [1-10], Risk Score: [IxU]
2. **[Assumption]** — Impact: [1-10], Uncertainty: [1-10], Risk Score: [IxU]
3. **[Assumption]** — Impact: [1-10], Uncertainty: [1-10], Risk Score: [IxU]

## Solution Hypothesis
**We believe that** [target persona]
**has a problem with** [core problem]
**because** [root cause/insight].

**If we build** [proposed solution — specific, simple description]
**they will** [measurable action that proves we're right].

## How Might We...
1. HMW [reframe pain point 1 as opportunity]?
2. HMW [reframe pain point 2 as opportunity]?
3. HMW [reframe competitive gap as opportunity]?

## Proposed Features (RICE scored)
| Feature | Reach | Impact | Confidence | Effort | RICE Score |
|---|---|---|---|---|---|
| [Feature 1] | | | | | |
| [Feature 2] | | | | | |
| ...         | | | | | |

## Confidence: [1-5]
## Kill Signals: [list, or "none"]
## Executive Summary: [≤120 words]
```

### Success Criteria (PASS)
- Opportunity snapshot is coherent and internally consistent
- At least 2 riskiest assumptions identified with scoring
- Hypothesis is specific, testable, and has a measurable outcome
- Features connect back to validated pain points

### Kill Signals
- Research from stages 1-5 contradicts itself (problem exists but market doesn't,
  or customers want it but won't pay)
- Cannot formulate a testable hypothesis — the solution is too vague
- All riskiest assumptions have Risk Score > 80 (everything is uncertain)

### Confidence Rubric
| Score | Criteria |
|---|---|
| 5 | Snapshot coherent, hypothesis crisp, features strongly connected to research |
| 4 | Good synthesis, clear hypothesis, reasonable feature list |
| 3 | Some gaps in synthesis, hypothesis testable but broad |
| 2 | Significant contradictions between stages, hypothesis weak |
| 1 | Cannot synthesize a coherent story from the research |

---

## Stage 7: GTM Strategy

**Agent:** `biv-strategist`
**Inputs:** All prior artifacts (stages 0-6)
**Deliverable:** `07-gtm-strategy.md`

### What the agent does
- Identifies where the target persona "lives" online (from Stage 1+2 data)
- Evaluates 4-6 acquisition channels using ICE scoring
- Selects 1-2 primary channels (the "wedge")
- Crafts initial messaging using "Hook, Pain, Solution" framework
- Outlines a plan to reach the first 100 users
- Assesses organic marketability (TikTok/social virality potential)

### Deliverable structure
```markdown
## Channel Analysis
| Channel | Impact (1-10) | Confidence (1-10) | Ease (1-10) | ICE Score |
|---|---|---|---|---|
| [Channel 1] | | | | |
| [Channel 2] | | | | |
| ...         | | | | |

## Selected Wedge Channels
1. **Primary:** [channel] — [why it's the best fit]
2. **Secondary:** [channel] — [backup / complementary]

## Messaging Framework
- **Hook:** [attention-grabber using customer language from Stage 1]
- **Pain:** [agitate the problem]
- **Solution:** [introduce the product]
- **CTA:** [specific action: waitlist, trial, demo]

## First 100 Users Plan
1. [Week 1-2: specific action with expected result]
2. [Week 3-4: specific action with expected result]
3. [Month 2: specific action with expected result]

## Marketability Assessment
- **Social virality potential:** [high/medium/low + evidence]
- **Content potential:** [can this topic generate organic content?]
- **Controversy factor:** [does the topic naturally drive engagement?]

## Confidence: [1-5]
## Kill Signals: [list, or "none"]
## Executive Summary: [≤120 words]
```

### Success Criteria (PASS)
- At least 3 channels evaluated with ICE scoring
- Clear primary channel selected with justified reasoning
- Messaging framework uses actual customer language from Stage 1
- First-100-users plan is specific and actionable

### Kill Signals
- No viable channel to reach the target persona (all score < 3 on ICE)
- The persona is unreachable online (no forums, no social presence, no search intent)
- Acquisition will require >$100 per user with no organic alternative

### Confidence Rubric
| Score | Criteria |
|---|---|
| 5 | Clear channel, strong messaging, organic virality confirmed |
| 4 | Good channel, solid messaging, some organic potential |
| 3 | Viable channel, messaging needs testing, unclear organic potential |
| 2 | Channels are expensive/uncertain, messaging untested |
| 1 | No viable path to reach the target customer |

---

## Stage 8: Financial Viability

**Agent:** `biv-financial-analyst`
**Inputs:** All prior artifacts (stages 0-7)
**Deliverable:** `08-financial-viability.md`

### What the agent does
- Estimates Year 1 costs (one-time + monthly recurring)
- Projects Year 1 revenue from SOM (Stage 3) and pricing assumptions
- Calculates the Year 1 P&L
- Computes unit economics: CAC, LTV, LTV:CAC ratio
- Runs sensitivity analysis on key levers (price, churn, acquisition cost)
- Checks if the model improves in Year 2

### Deliverable structure
```markdown
## Year 1 Cost Estimate
| Category | One-Time | Monthly | Annual |
|---|---|---|---|
| Development (founder time) | | | |
| Design / freelancers | | | |
| Infrastructure / hosting | | | |
| Marketing / ads | | | |
| Software / tools | | | |
| Legal / admin | | | |
| **Total** | **$X** | **$X/mo** | **$X** |

## Year 1 Revenue Projection
- **Target customers (Year 1):** [from SOM]
- **Price per customer:** $[X]/year
- **Projected revenue:** $[X]
- **Year 1 P&L:** $[revenue - costs] = $[X]

## Unit Economics
- **CAC:** $[marketing spend / new customers]
- **LTV:** $[monthly revenue per customer / monthly churn rate]
- **LTV:CAC Ratio:** [X]:1
- **Health assessment:** [healthy ≥3:1 / warning 1-3:1 / unsustainable <1:1]
- **Payback period:** [months to recover CAC]

## Sensitivity Analysis
| Scenario | Change | Impact on LTV:CAC |
|---|---|---|
| Price +50% | $X → $Y | [ratio] |
| Price -25% | $X → $Y | [ratio] |
| Churn halved | X% → Y% | [ratio] |
| CAC doubled | $X → $Y | [ratio] |

## Year 2 Outlook
- **Projected growth:** [customer count, revenue]
- **Path to profitability:** [when does revenue exceed costs?]
- **Key lever:** [what single change most improves the model?]

## Confidence: [1-5]
## Kill Signals: [list, or "none"]
## Executive Summary: [≤120 words]
```

### Success Criteria (PASS)
- Cost and revenue estimates documented with assumptions
- LTV:CAC ≥ 3:1 (or a clear path to it within 12 months)
- Sensitivity analysis shows the model isn't fragile (survives 1-2 adverse changes)
- Year 2 shows meaningful improvement

### Kill Signals
- LTV:CAC < 1:1 even with optimistic assumptions
- Year 1 costs exceed available funding/runway with no revenue path
- Sensitivity analysis shows model breaks under any single adverse change
- Unit economics require unrealistic churn rates (< 1%) to work

### Confidence Rubric
| Score | Criteria |
|---|---|
| 5 | Strong unit economics, robust under sensitivity, clear profitability path |
| 4 | Good economics, some sensitivity risk, profitability within 18 months |
| 3 | Marginal economics, sensitive to assumptions, profitability uncertain |
| 2 | Weak economics, model fragile, requires significant optimism |
| 1 | Math doesn't work under any reasonable scenario |

---

## Stage 9: Go/No-Go Decision

**Agent:** `biv-decision-gate`
**Inputs:** All prior artifacts (stages 0-8), `pipeline-state.json`
**Deliverable:** `09-go-no-go-decision.md`

### What the agent does
- Reads all 8 stage artifacts and the pipeline state
- Scores the idea across 8 dimensions (each 1-5)
- Accounts for stages that passed with risk (confidence penalties)
- Produces a total score and verdict
- Writes a clear recommendation with specific next steps

### Deliverable structure
```markdown
## Decision Scorecard

### Problem-Solution Fit (Desirability)
| Dimension | Score (1-5) | Evidence Source | Notes |
|---|---|---|---|
| Pain Level | | Stage 1 | |
| Market Size | | Stage 3 | |
| Competitive Edge | | Stage 4 | |
| Customer Signal | | Stage 5 | |

### Go-To-Market Fit (Feasibility)
| Dimension | Score (1-5) | Evidence Source | Notes |
|---|---|---|---|
| Channel Clarity | | Stage 7 | |
| Acquisition Cost | | Stage 8 | |

### Business Model Fit (Viability)
| Dimension | Score (1-5) | Evidence Source | Notes |
|---|---|---|---|
| Profitability Path | | Stage 8 | |
| Founder Conviction | | Brief + overall | |

### Total Score: [X] / 40

## Verdict
- **GO** (30-40): Strong evidence across all three pillars.
- **PIVOT** (18-29): Positive signals exist but significant weaknesses in [areas].
- **NO-GO** (8-17): Evidence does not support this idea in its current form.

**Verdict: [GO / PIVOT / NO-GO]**

## Pipeline Health
- Stages passed clean: [list]
- Stages passed with risk: [list + what the risk was]
- Strongest dimension: [which + why]
- Weakest dimension: [which + why]

## Recommendation
[2-3 paragraphs: what to do next, specific and actionable]

## If PIVOT — Where to Re-enter
[Which stage to re-run and what to change]

## Executive Summary: [≤150 words]
```

### Kill Signals
Stage 9 does not define its own kill signals. It aggregates evidence from
stages 1-8. The verdict thresholds (NO-GO at 8-17) serve as the final gate.
Any kill signals from prior stages that were overridden via "weak_proceed"
are reflected as -1 scoring penalties, not as independent kill triggers here.

### Scoring Notes
- If Stage 5 (Customer Validation) was AI-simulated, cap its "Customer Signal"
  dimension at 3 regardless of the simulated score
- If any stage passed with risk ("weak_proceed"), apply a -1 penalty to its
  corresponding dimension score
- "Founder Conviction" is assessed from the user's original brief — how
  specific, passionate, and knowledgeable they were about the domain
