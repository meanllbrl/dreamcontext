---
description: "Load when writing emails, proposals, presentations, LinkedIn posts, sales content, pitch decks, Slack messages, or any brand-aligned content. Also triggers on 'brand voice', 'on-brand', 'enforce voice', 'write in our voice', 'make this sound like us', 'rewrite in our tone', 'discover brand materials', 'generate brand guidelines', 'brand content audit', 'style guide', 'find brand docs'. Sub-skills: discover-brand (search platforms for brand materials), guideline-generation (create structured guidelines from sources). Agents: discover-brand, document-analysis, conversation-analysis, content-generation, quality-assurance."
alwaysApply: false
ruleType: "Brand Voice System"
version: "1.0"
---

## Sub-Skills (Read Before Specific Work)

| When you are about to... | Read first |
|--------------------------|------------|
| Search connected platforms for brand materials, run a brand content audit | `discover-brand.md` |
| Generate, create, or synthesize brand voice guidelines from documents or transcripts | `guideline-generation.md` |

## Agents (Delegate Heavy Work)

These agents are installed separately via `dreamcontext install-skill --agents`. Launch them via the Agent tool.

| When you need to... | Agent name |
|---------------------|------------|
| Autonomously search enterprise platforms for brand materials | `discover-brand` |
| Parse and analyze brand documents to extract voice attributes | `document-analysis` |
| Analyze sales call transcripts for voice patterns | `conversation-analysis` |
| Generate long-form or batch brand-aligned content | `content-generation` |
| Validate content or guidelines against brand standards | `quality-assurance` |

---

# Brand Voice Enforcement

Apply existing brand guidelines to all sales and marketing content generation. Load the project's brand guidelines, apply voice constants and tone flexes to the content request, validate output, and explain brand choices.

## Loading Brand Guidelines

Find the project's brand guidelines using this sequence. Stop as soon as you find them:

1. **Core file** -- Check `_dream_context/core/` for a brand voice core file (e.g., `brand_voice.md`). This is the primary location. If found, the guidelines are already part of the project context and may be auto-loaded in the snapshot.

2. **Session context** -- Check if brand guidelines were generated earlier in this session via the guideline-generation sub-skill. If so, they are already in the conversation. Use them directly.

3. **Ask the user** -- If none of the above found guidelines, tell the user:
   "I couldn't find brand guidelines in `_dream_context/core/`. You can:
   - Have me discover brand materials across your connected platforms (read `discover-brand.md`)
   - Have me generate guidelines from documents or transcripts (read `guideline-generation.md`)
   - Paste guidelines directly into this chat or point me to a file"

   Wait for the user to provide guidelines before proceeding.

Also check the brand voice core file frontmatter for enforcement settings:
- `strictness`: strict | balanced | flexible (default: balanced)
- `always_explain`: whether to always explain brand choices (default: false)

## Enforcement Workflow

### 1. Analyze the Content Request

Before writing, identify:
- **Content type**: email, presentation, proposal, social post, message, etc.
- **Target audience**: role, seniority, industry, company stage
- **Key messages needed**: which message pillars apply
- **Specific requirements**: length, format, tone overrides

### 2. Apply Voice Constants

Voice is the brand's personality -- it stays constant across all content:
- Apply "We Are / We Are Not" attributes from guidelines
- Use brand personality consistently
- Incorporate approved terminology; reject prohibited terms
- Follow messaging framework and value propositions

Refer to `references/voice-constant-tone-flexes.md` for the "voice constant, tone flexes" model.

### 3. Flex Tone for Context

Tone adapts by content type and audience. Use the tone-by-context matrix from guidelines to set:
- **Formality**: How formal or casual should this be?
- **Energy**: How much urgency or enthusiasm?
- **Technical depth**: How detailed or accessible?

### 4. Generate Content

Create content that:
- Matches brand voice attributes throughout
- Follows tone guidelines for this specific content type
- Incorporates key messages naturally (not forced)
- Uses preferred terminology
- Mirrors the quality and style of guideline examples

For complex or long-form content, launch the content-generation agent via the Agent tool.
For high-stakes content, launch the quality-assurance agent for validation.

### 5. Validate and Explain

After generating content:
- Briefly highlight which brand guidelines were applied
- Explain key voice and tone decisions
- Note any areas where guidelines were adapted for context
- Offer to refine based on feedback

When `always_explain` is true in the core file frontmatter, include brand application notes with every response.

## Handling Conflicts

When the user's request conflicts with brand guidelines:
1. Explain the conflict clearly
2. Provide a recommendation
3. Offer options: follow guidelines strictly, adapt for context, or override

Default to adapting guidelines with an explanation of the tradeoff.

## Open Questions Awareness

Open questions are unresolved brand positioning decisions flagged during guideline generation, stored in the guidelines under an "Open Questions" section. When generating content, check if the brand guidelines contain open questions:
- If content touches an unresolved open question, note it
- Apply the agent's recommendation from the open question unless the user specifies otherwise
- Suggest resolving the question if it significantly impacts the content

## Reference Files

- **`references/voice-constant-tone-flexes.md`** -- The "voice constant, tone flexes" mental model, "We Are / We Are Not" table structure, and tone-by-context matrix explanation
- **`references/before-after-examples.md`** -- Before/after content examples per content type showing enforcement in practice
