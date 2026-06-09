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

# Data Structures — {{PRODUCT_NAME}}

Document this product's database schema, key models, and API contracts here. This file is the source of truth for data shapes.

## Conventions

- One `data-structures/<product>.md` file per product in a monorepo. `default.md` is the single-product fallback.
- Sleep-state applies the **single-observation gate** to this file: a single session that adds, removes, or changes a schema MUST be reflected here in the same sleep cycle. No pattern repetition required.
- Tasks MAY include `product: <name>` in frontmatter to route data-structure observations to the matching product file.

## Schema

<!-- Example:

```sql
CREATE TABLE users (
  id UUID PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT NOW()
);
```

Or document models in any format that matches the stack — TypeScript interfaces, Prisma schema, Pydantic models, GraphQL SDL. -->

## API Contracts

<!-- Document request/response shapes, route handlers, and external API integrations relevant to this product. -->
