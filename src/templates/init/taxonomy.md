<!--
  core/taxonomy.md — project vocabulary for faceted tags.
  DO NOT rename this file or move it out of core/: a leading-digit prefix
  would pull it into the core-index glob ([3-9]* in core-index.ts and
  graph.ts); keeping it here without a numeric prefix keeps it out of the
  snapshot while remaining parseable by loadProjectVocabulary.
  Recall exclusion is by directory — buildCorpus only loads knowledge/,
  core/features/, state/ and explicit files; core/taxonomy.md is excluded.
  Managed by: dreamcontext taxonomy init / dreamcontext taxonomy vocab
-->

# Taxonomy

## Naming Rules

- Tags are lowercase kebab-case.
- Faceted tags use the form `facet:value` (e.g. `topic:recall`, `domain:database`).
- Bare tags are plain lowercase words (e.g. `architecture`, `testing`).
- Prefer the canonical form; add aliases below for common shorthands.
- Run `dreamcontext taxonomy vocab` to see the full resolved vocabulary.

## Facets

```
domain:database
domain:security
domain:knowledge
domain:recall
layer:frontend
layer:backend
layer:devops
kind:architecture
kind:api
kind:testing
kind:design
kind:decisions
kind:onboarding
topic:recall
topic:sleep
topic:taxonomy
topic:domain
```

## Aliases

| alias | canonical |
|-------|-----------|
| search | topic:recall |
| retrieval | topic:recall |
| db | domain:database |
| auth | domain:security |
| consolidation | topic:sleep |

## Domain Vocabulary

- architecture
- api
- frontend
- backend
- database
- devops
- security
- testing
- design
- decisions
- onboarding
- domain
