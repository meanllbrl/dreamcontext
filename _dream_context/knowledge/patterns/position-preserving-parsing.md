---
name: position-preserving-parsing
description: >-
  When a surface briefing asks the agent to write prose AROUND an object, the parser
  must preserve position, not just content — a flat body cannot express it. The Chat
  block felt disconnected because of a RENDER ORDER bug, not stream pacing.
type: knowledge
tags:
  - kind:pattern
  - architecture
  - frontend
  - topic:agents
date: '2026-08-27'
---

# Position-Preserving Parsing Pattern

## Why This Exists

The Chat block felt disconnected because of a **RENDER ORDER** bug, not stream pacing: `chatActions` collapsed all prose into one body and `TranscriptItem` printed body THEN blocks, so a sentence written *under* a card rendered *above* it.

The general lesson: **when a surface briefing asks the agent to write prose AROUND an object, the parser must preserve position, not just content — a flat body cannot express it.**

## The Problem

Consider this agent response:

```markdown
Here's the summary:

<dream-view type="chart">...</dream-view>

The chart shows revenue peaked in Q3.
```

A **content-only** parser extracts:
- `body: "Here's the summary:\n\nThe chart shows revenue peaked in Q3."`
- `blocks: [{ type: 'chart', ... }]`

When rendered as `<prose>{body}</prose><blocks>{blocks}</blocks>`, the output is:

```
Here's the summary:

The chart shows revenue peaked in Q3.

[chart appears here]
```

The chart is **under** the sentence that refers to it, even though the agent wrote it **above**.

## The Solution — Ordered Segments

**DO THIS:**  
Parse the response into an **ordered list of segments**, where each segment is either `{type: 'prose', text: '...'}` or `{type: 'block', block: {...}}`. Render them in order.

```typescript
interface ProseSegment {
  type: 'prose';
  text: string;
}

interface BlockSegment {
  type: 'block';
  block: DreamViewBlock | DreamActionsBlock | ...;
}

type Segment = ProseSegment | BlockSegment;

function parseChatActions(text: string): Segment[] {
  const segments: Segment[] = [];
  let lastIndex = 0;

  // Find each block (e.g., <dream-view>...</dream-view>)
  for (const match of text.matchAll(/<dream-view[^>]*>.*?<\/dream-view>/gs)) {
    // Prose before this block
    if (match.index! > lastIndex) {
      segments.push({
        type: 'prose',
        text: text.slice(lastIndex, match.index!),
      });
    }

    // The block itself
    segments.push({
      type: 'block',
      block: parseViewBlock(match[0]),
    });

    lastIndex = match.index! + match[0].length;
  }

  // Prose after the last block
  if (lastIndex < text.length) {
    segments.push({
      type: 'prose',
      text: text.slice(lastIndex),
    });
  }

  return segments;
}
```

**Render:**
```tsx
{segments.map((seg, i) =>
  seg.type === 'prose' ? (
    <Prose key={i}>{seg.text}</Prose>
  ) : (
    <BlockView key={i} block={seg.block} />
  )
)}
```

Now the chart appears exactly where the agent wrote it.

## When to Use This Pattern

**Use ordered segments when:**
- The surface briefing teaches the agent to write prose around objects (e.g., "Place the chart where it's most relevant in your response")
- The object's position is meaningful (e.g., a chart illustrating a specific sentence, a checklist embedded in a procedure)
- The agent can place multiple objects in one response

**Don't use ordered segments when:**
- All objects always go at the end (a flat `{body, blocks}` is simpler and sufficient)
- Objects are metadata (e.g., a status chip at the top of every message)
- Position doesn't matter (e.g., a set of filters that apply to the whole response)

## Evidence

- Bookmark `bm_ZVh6P4eL` (salience 2, 2026-08-27) — the Chat block felt disconnected
- Fixed by: `parseChatActions` returning ordered segments (commit 98378ee)
- The bug was **render order**, not stream pacing — a static response had the same problem

## Related Patterns

- `surface-briefing-pattern.md` — when teaching the agent to place objects, also teach the parser to preserve that placement
- The briefing may say "place the chart above the paragraph that explains it" — the parser is what makes that instruction actionable

## Changelog

### 2026-08-27 - Created
- Pattern created from the Chat block position bug (98378ee)
- Documents the ordered-segment parser shape and when to use it
