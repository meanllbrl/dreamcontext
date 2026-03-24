---
name: firebase-firestore-basics
description: Comprehensive Firestore skill covering provisioning, security rules, SDK usage, query mechanics, aggregation, and indexing. Use when writing Firestore queries, security rules, or setting up Firestore.
compatibility: Best used with Firebase CLI (`npm install -g firebase-tools`). Supports Standard and Enterprise editions.
---

# Firestore Basics

Complete guide for Cloud Firestore — provisioning, securing, querying, and optimizing.

## Edition Awareness (Check First)

Before writing ANY Firestore code, determine the edition:
- **Standard**: Classic rules + limits. Most projects use this.
- **Enterprise (Pipeline)**: 100+ features — groupBy, min/max, countDistinct, optional indexes, `query.explain()`. Available since Jan 2026.

Agent MUST NOT suggest Pipeline syntax for Standard projects — it will error.

## Provisioning

Set up Cloud Firestore in your Firebase project and local environment: [provisioning.md](references/provisioning.md)

## Security Rules

Write and deploy Firestore Security Rules to protect your data: [security_rules.md](references/security_rules.md)

## SDK Usage

CRUD operations, real-time listeners, queries, aggregation, pagination: [web_sdk_usage.md](references/web_sdk_usage.md)

## Query Mechanics (Deep Dive)

**How Firestore processes queries internally** — execution model, index selection, cost model, aggregation mechanics, and the agent pre-query checklist: [query_mechanics.md](references/query_mechanics.md)

## Indexes

Index types, composite index ordering rules, Enterprise differences, and management: [indexes.md](references/indexes.md)

## Agent Pre-Query Checklist

Before generating ANY Firestore query:

1. **Edition?** → Standard or Enterprise? Determines available syntax.
2. **Aggregation?** → `getAggregateFromServer` (Standard) or `db.pipeline().aggregate()` (Enterprise). **NEVER** client-side reduce/sum/count.
3. **Compound query?** → Composite index needed? Field order: equality → inequality → orderBy.
4. **OR / in?** → Disjunction count ≤ 30.
5. **Index exists?** → Standard: error + create link. Enterprise: warn about scan cost.
6. **Pagination?** → Cursor-based only (`startAfter`). No offset.
7. **Real-time?** → Cannot use Pipeline syntax. Use Core query.
8. **Explain?** → Use `query.explain()` on Enterprise to verify planner decisions.
