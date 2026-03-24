# 1st Gen vs 2nd Gen Comparison

**2nd gen is mandatory for all new functions.** 1st gen is legacy only.

## Comparison Table

| Feature | 1st Gen | 2nd Gen (Cloud Run) |
|---|---|---|
| Infrastructure | Legacy Firebase Runtime | Cloud Run + Eventarc (90+ event sources) |
| HTTP Timeout | 9 minutes | **60 minutes** |
| Event Timeout | 540s | 540s (scheduled/task queue: 1800s) |
| Max Instance Size | 8 GiB RAM / 2 vCPU | **32 GiB RAM / 4 vCPU** (16 GiB recommended) |
| Concurrency per instance | 1 request | **1–1000** (default 80) |
| Min Instances | Available | Available + **CPU scaling** |
| Service Account | App Engine default | Compute Engine default (more secure) |
| Trigger Support | Limited Firebase events | **All Eventarc** + Pub/Sub + custom |
| Image Registry | Container/Artifact Registry | **Artifact Registry only** |
| Traffic Splitting | No | Yes (revision rollback) |
| Retry Window | 7 days | **24 hours** |

## Supported Runtimes (March 2026)

- **Node.js**: 22 (recommended), 20, 18 (deprecated)
- **Python**: 3.11+ (`firebase-functions` Python SDK)
- **TypeScript**: Native (ESM/CommonJS)

## Import Pattern

```js
// 2nd gen (CORRECT)
const { onRequest, onCall } = require("firebase-functions/v2/https");
const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");

// 1st gen (LEGACY — do not use in new code)
const functions = require("firebase-functions");
```

## Migration Rule

If agent encounters 1st gen code:
1. Replace `functions.https.onRequest` → `onRequest` from `firebase-functions/v2/https`
2. Replace `functions.firestore.document().onUpdate` → `onDocumentUpdated` from `firebase-functions/v2/firestore`
3. Replace `.runWith({ failurePolicy: true })` → `{ retry: true }` in options
4. Replace `functions.config()` → `defineSecret()` / `defineString()`
5. Add `concurrency` and `minInstances` to options
