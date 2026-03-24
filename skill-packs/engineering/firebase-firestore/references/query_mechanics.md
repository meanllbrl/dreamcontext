# Firestore Query Mechanics – Deep Dive

How Firestore processes queries under the hood. Agent MUST internalize these rules before generating any query.

## 1. Edition Check (FIRST STEP — Always)

```js
// Agent must determine edition before writing any query
// Check firebase.json → "edition": "enterprise" or absence = Standard
```

| Capability | Standard | Enterprise (Pipeline) |
|---|---|---|
| Aggregation | count/sum/avg only | + min/max/countDistinct/groupBy |
| Index requirement | Mandatory | Optional (but recommended) |
| Pipeline syntax (`db.pipeline()`) | NOT available | Available |
| `query.explain()` | Not available | Available |
| Real-time listeners | Full support | Pipeline queries: NO real-time |
| Disjunction limit | 30 | Higher |

**Rule**: If project is Standard, NEVER suggest Pipeline syntax — it will throw an error.

## 2. Query Execution Model (Full Flow)

Firestore queries are **entirely index-driven**. No query does a full collection scan (Enterprise without indexes will scan but at extreme cost).

### Step 1: Query Parsing & Planning
Client SDK → protobuf → Firestore Frontend.
Query planner evaluates:
- Which collection / collection group?
- Which fields have equality filters? (these become index prefix)
- Inequality/range filters?
- Aggregation or document fetch?

### Step 2: Index Selection
- Planner picks the **narrowest matching index**.
- No match:
  - **Standard**: Error + "Create index" console link.
  - **Enterprise**: Falls back to full scan (slow, expensive).

### Step 3: Index Scan (Most Critical)
Internal structure (on Bigtable):
- **Documents table** + **Indexes table**
- Index row key: `[collection] + [field1 value] + [field2 value] + … + __name__ (doc ID)`
- **Start position**: All equality filters become prefix. First inequality/orderBy field starts the range.
- Executes a **single range scan** across the index.
- Each matching row → document fetch (batched, 1 read = 1000 index entries).
- Scan continues until: limit reached, filter breaks, or collection ends.

### Step 4: Post-processing
- OR/in/array-contains-any → split into multiple index scans (max 30 disjunctions, DNF conversion).
- Results streamed to client, or aggregated server-side into single result.

**Cost rule**: Query cost = number of scanned index entries. This is why aggregation MUST be server-side.

## 3. Composite Index Field Ordering (Critical for Agents)

When creating composite indexes, field order matters:

1. **All equality filters** (any order among themselves)
2. **Inequality/range filter** (only 1 allowed in Standard)
3. **orderBy fields** (must match query direction)

Example:
```js
where("state", "==", "CA")
.where("population", ">=", 1000000)
.orderBy("population", "desc")
```
Required composite index: `(state ASC, population DESC)`

**Why only 1 inequality?**
Index scan is a single range scan. Multiple inequalities would require separate ranges → performance guarantee breaks.

## 4. OR / Disjunction Mechanics

```js
import { or } from "firebase/firestore";
query(coll, or(where("a", "==", 1), where("b", ">", 10)));
```

Internally: 2 separate index scans + merge. Max 30 disjunctions (DNF form).

**Restrictions**:
- `not-in` cannot combine with `in`, `array-contains-any`, or `or`.
- `array-contains` → only 1 per query.
- `!=` and `not-in` exclude documents where the field doesn't exist.

## 5. Aggregation Mechanics

### Standard Edition
```js
import { count, sum, average, getAggregateFromServer } from "firebase/firestore";

const snapshot = await getAggregateFromServer(q, {
  totalCount: count(),
  totalPop: sum("population"),
  avgPop: average("population")
});
console.log(snapshot.data()); // { totalCount: 42, totalPop: 12345678, avgPop: 294420 }
```
- Supported: `count()`, `sum(field)`, `average(field)`
- NOT supported: min, max, groupBy (Enterprise only)
- Reads index only — 1 read per 1000 index entries
- 60-second timeout
- Security rules apply to aggregation queries

### Enterprise Edition (Pipeline)
```js
const result = await db.pipeline()
  .collection("orders")
  .where("status", "==", "shipped")
  .aggregate({
    accumulators: [
      sum("totalAmount").as("revenue"),
      count().as("orderCount"),
      min("totalAmount").as("minOrder"),
      countDistinct("customerId").as("uniqueCustomers")
    ],
    groups: ["productId"]  // GROUP BY
  })
  .sort("totalPop", "desc")
  .limit(10)
  .execute();
```
Pipeline is a true stage-by-stage engine: regex, map, filter-after-aggregate supported.

**CRITICAL RULE**: NEVER fetch all documents and reduce/sum client-side. Cost is 10-1000x higher. Always use server-side aggregation.

## 6. Pagination

**Cursor pagination** (only correct approach):
```js
import { startAfter, limit, orderBy } from "firebase/firestore";

// Page 1
const first = query(citiesRef, orderBy("name"), limit(25));
const snapshot = await getDocs(first);
const lastDoc = snapshot.docs[snapshot.docs.length - 1];

// Page 2
const next = query(citiesRef, orderBy("name"), startAfter(lastDoc), limit(25));
```

- `startAfter(lastDoc)` → resumes from the same index position (most efficient).
- Firestore has NO offset-based pagination. Do not simulate it.
- `startAt` / `startAfter` / `endAt` / `endBefore` — all require matching `orderBy`.

## 7. Real-time Listener Internals

- Listener sets up an **index watcher**.
- On index change → incremental update pushed (no full rescan).
- Pipeline queries (Enterprise) do NOT support real-time listeners — use Core query syntax for real-time.

## 8. Collection Group Queries

```js
import { collectionGroup } from "firebase/firestore";
const q = query(collectionGroup(db, "landmarks"), where("type", "==", "museum"));
```
Queries across ALL subcollections with the same name, regardless of parent document.

## 9. query.explain() (Enterprise Only)

```js
const explained = await query.explain();
// Shows: which index selected, entries scanned, execution plan
```
Use to debug slow queries and verify index selection.

## 10. Agent Pre-Query Checklist

Before generating ANY Firestore query, the agent MUST check:

1. **Edition?** → Standard or Enterprise? Determines available syntax.
2. **Aggregation needed?** → Pipeline (Enterprise) or `getAggregateFromServer` (Standard). NEVER client-side reduce.
3. **Compound query?** → Will it need a composite index? (equality fields → inequality → orderBy)
4. **OR / in present?** → Disjunction count ≤ 30.
5. **Index exists?** → Enterprise: warn about cost without index. Standard: suggest index creation link.
6. **Pagination?** → Cursor-based only (`startAfter`). No offset.
7. **Real-time needed?** → Cannot use Pipeline syntax. Use Core query.
8. **`query.explain()`** → Recommend for Enterprise to verify planner decisions.
