# Scaling, Concurrency & Cold Start

## Concurrency (2nd Gen's Biggest Advantage)

A single 2nd gen instance can handle **1–1000 concurrent requests** (default: 80).

```js
exports.myFunc = onRequest({
  concurrency: 500,      // 500 simultaneous requests per instance
  minInstances: 5,       // 5 warm instances always ready
  maxInstances: 100,     // cap to prevent runaway scaling
  memory: "1GiB",
  cpu: 2,
}, (req, res) => { ... });
```

### Recommended Concurrency Values

| Function Type | Concurrency | Rationale |
|---|---|---|
| HTTP / Callable | >= 200 | High throughput, shared instance state |
| Firestore background trigger | >= 80 | Moderate parallelism |
| CPU-intensive (image processing) | 1–10 | Avoid resource contention |
| External API calls (rate-limited) | 10–50 | Respect downstream limits |

## Cold Start Prevention

Cold start = new instance spin-up. Can add 500ms–5s latency.

### minInstances (primary solution)
```js
{ minInstances: 1 }  // At least 1 warm instance → cold start eliminated for most traffic
```
- `minInstances: 1` reduces cold starts by ~90%.
- `minInstances: 5` for high-traffic production functions.
- Cost: warm instances bill for idle time. Trade-off: latency vs cost.

### Global Variable Caching
```js
// Initialize ONCE, reuse across invocations on same instance
const admin = require("firebase-admin");
admin.initializeApp();
const db = admin.firestore();

// Heavy clients: cache at module level
let aiClient;
function getAiClient() {
  if (!aiClient) aiClient = new SomeAiClient();
  return aiClient;
}
```

### onInit() for Heavy Initialization (2nd gen)
```js
const { onInit } = require("firebase-functions/v2/core");

onInit(() => {
  // Runs once per instance, before any request
  // Use for GenAI client init, connection pools, etc.
});
```

## Background Activity — FORBIDDEN

NEVER start background work after sending a response:

```js
// WRONG — background activity breaks instance reuse
exports.bad = onRequest((req, res) => {
  res.send("OK");
  setTimeout(() => doSomething(), 5000); // ← NEVER DO THIS
});

// CORRECT — finish all work before responding
exports.good = onRequest(async (req, res) => {
  await doSomething();
  res.send("OK");
});
```

## Runtime Options (Full Template)

```js
const { setGlobalOptions } = require("firebase-functions/v2");

setGlobalOptions({
  region: "us-central1",
  memory: "512MiB",
  cpu: 1,
  concurrency: 200,
  minInstances: 1,
  maxInstances: 50,
});
```

Per-function override:
```js
exports.heavyFunc = onRequest({
  timeoutSeconds: 300,
  memory: "4GiB",
  cpu: 4,
  concurrency: 10,
  minInstances: 2,
  maxInstances: 20,
  serviceAccount: "my-sa@project.iam.gserviceaccount.com"
}, handler);
```

## CPU Scaling Option

```js
// Use 1st gen CPU behavior (scales with memory)
setGlobalOptions({ cpu: "gcf_gen1" });
```

## Quotas & Limits (March 2026)

| Limit | 2nd Gen |
|---|---|
| Max memory | 32 GiB |
| Max vCPU | 4 |
| HTTP timeout | 60 minutes |
| Event timeout | 540s (scheduled: 1800s) |
| Concurrency per instance | 1000 |
| Function count | ~1000 (minus Cloud Run services) |
| Max deployment size | 100 MiB (compressed) |

Quota exceeded = HTTP 500 + function stops. Always set `maxInstances` to cap costs.
