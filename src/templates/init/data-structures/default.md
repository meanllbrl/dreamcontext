---
name: {{PRODUCT_NAME}}
description: Data structures for {{PRODUCT_NAME}}
type: data-structures
product: {{PRODUCT_NAME}}
tags:
  - data-structures
  - database
  - schema
updated: {{DATE}}
---
```sql
-- Data Structures — {{PRODUCT_NAME}}
-- Updated: {{DATE}}
--
-- Document all tables, models, and key JSON shapes here.
-- One observation gate: a schema change in a session MUST be reflected here
-- in the same sleep cycle. No pattern repetition required.
--
-- Convention:
--   - Single-product projects use default.md.
--   - Multi-product monorepos use <product>.md per product.
--   - The body should always be a ```sql fenced block for dashboard highlighting.
--   - Use SQL comments (-- ...) for documentation and guidance.

-- ============================================================
-- EXAMPLE — replace or extend with your actual schema
-- ============================================================

CREATE TABLE users (
  id          UUID         PRIMARY KEY,
  email       VARCHAR(255) NOT NULL UNIQUE,
  created_at  TIMESTAMP    NOT NULL DEFAULT NOW()
);

-- Add additional tables, indexes, and JSON model shapes below.
```
