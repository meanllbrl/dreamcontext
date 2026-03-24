---
name: guideline-generation
description: >
  This skill generates, creates, or builds brand voice guidelines from source
  materials. It should be used when the user asks to "generate brand guidelines",
  "create a style guide", "extract brand voice", "create guidelines from calls",
  "consolidate brand materials", "analyze my sales calls for brand voice",
  "build a brand playbook from documents", "synthesize a voice and tone guide",
  or uploads brand documents, transcripts, or meeting recordings for brand
  analysis. Also triggers when the user has a discovery report and wants to
  convert it into actionable guidelines.
---

# Guideline Generation

Generate comprehensive, LLM-ready brand voice guidelines from any combination of sources -- brand documents, sales call transcripts, discovery reports, or direct user input. Transform raw materials into structured, enforceable guidelines with confidence scoring and open questions.

## Inputs

Accept any combination of:
- **Discovery report** from the discover-brand sub-skill (structured, pre-triaged)
- **Brand documents** uploaded or from connected MCP platforms (PDF, PPTX, DOCX, MD, TXT)
- **Conversation transcripts** from Gong, Granola, manual uploads, or Notion meeting notes
- **Direct user input** about their brand voice and values

When a discovery report is provided, use it as the primary input -- sources are already triaged and ranked. Supplement with additional analysis as needed.

## Generation Workflow

### 1. Identify and Classify Sources

Determine what the user has provided. If no sources are available:
- Check if a discovery report exists from a previous discover-brand run in this session
- Check `_dream_context/core/` for an existing brand voice core file with source references
- Check connected MCP platforms for existing materials
- Suggest running brand discovery first (read `discover-brand.md`)

### 2. Process Sources

**For documents:** Launch the document-analysis agent for heavy parsing. Extract voice attributes, messaging themes, terminology, tone guidance, and examples.

**For transcripts:** Launch the conversation-analysis agent for pattern recognition. Extract implicit voice attributes, successful language patterns, tone by context, and anti-patterns.

**For discovery reports:** Extract pre-triaged sources, conflicts, and gaps. Use the ranked sources directly.

### 3. Synthesize Into Guidelines

Merge all findings into a unified guideline document following the template in `references/guideline-template.md`. Key sections:

**"We Are / We Are Not" Table** -- The core brand identity anchor:

| We Are | We Are Not |
|--------|------------|
| [Attribute -- e.g., "Confident"] | [Counter -- e.g., "Arrogant"] |
| [Attribute -- e.g., "Approachable"] | [Counter -- e.g., "Casual or sloppy"] |

Derive attributes from the most consistent patterns across sources. Each row should have supporting evidence.

**Voice Constants vs. Tone Flexes** -- Clarify what stays fixed and what adapts:
- **Voice** = personality, values, "We Are / We Are Not" -- constant across all content
- **Tone** = formality, energy, technical depth -- flexes by context

**Tone-by-Context Matrix:**

| Context | Formality | Energy | Technical Depth | Example |
|---------|-----------|--------|-----------------|---------|
| Cold outreach | Medium | High | Low | "[example phrase]" |
| Enterprise proposal | High | Medium | High | "[example phrase]" |
| Social media | Low | High | Low | "[example phrase]" |

### 4. Assign Confidence Scores

Score each section using the methodology in `references/confidence-scoring.md`:
- **High confidence**: 3+ corroborating sources, explicit guidance found
- **Medium confidence**: 1-2 sources, or inferred from patterns
- **Low confidence**: Single source, inferred, or conflicting data

### 5. Surface Open Questions

Generate open questions for any ambiguity that cannot be resolved:

```markdown
## Open Questions for Team Discussion

### High Priority (blocks guideline completion)
1. **[Question Title]**
   - What was found: [conflicting or incomplete info]
   - Agent recommendation: [suggested resolution with reasoning]
   - Need from you: [specific decision or confirmation needed]
```

Every open question MUST include an agent recommendation. Turn ambiguity into "confirm or override" -- never a dead end.

### 6. Quality Check

Before presenting, launch the quality-assurance agent to verify:
- All major sections populated (including Brand Personality and Content Examples if sources support them)
- At least 3 voice attributes with evidence
- "We Are / We Are Not" table has 4+ rows
- Tone matrix covers at least 3 contexts
- Confidence scores assigned per section
- Source attribution for all extracted elements
- No PII exposed
- Open questions include recommendations

### 7. Present and Offer Next Steps

Summarize key findings:
- Total sections generated with confidence breakdown
- Strongest voice attribute and most effective message
- Number of open questions (if any)

### 8. Save as Core File

Save the generated guidelines as a core file in `_dream_context/core/`. Use the next available core file slot (7+).

**File format:**
```markdown
---
name: brand-voice
description: "[Company] brand voice guidelines -- voice attributes, tone matrix, messaging framework, terminology"
type: extended-core
strictness: balanced
always_explain: false
generated_at: [date]
sources_analyzed: [N]
overall_confidence: [High/Medium/Low]
---

[Generated guidelines content]
```

**Steps:**
1. Check if a brand voice core file already exists in `_dream_context/core/`
2. If it exists, confirm with the user before overwriting (offer to archive the old version as a knowledge file)
3. Save new guidelines to `_dream_context/core/` (e.g., `7.brand_voice.md`)
4. Confirm to the user: "Brand voice guidelines saved to `_dream_context/core/7.brand_voice.md`. They'll be auto-loaded in future sessions via the snapshot."

After saving, offer:
1. Walk through the guidelines section by section
2. Start creating content with brand voice enforcement
3. Resolve open questions

## Privacy and Security

Enforce these privacy constraints throughout the entire generation workflow, not only at output time:
- Redact customer names and contact information from all examples
- Anonymize company names in transcript excerpts if requested
- Flag any sensitive information detected during processing

## Reference Files

- **`references/guideline-template.md`** -- Complete output template with all sections, field definitions, and formatting guidance
- **`references/confidence-scoring.md`** -- Confidence scoring methodology, thresholds, and examples
