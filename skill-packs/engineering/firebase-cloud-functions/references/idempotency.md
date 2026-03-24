# Idempotency & Infinite Loop Prevention

**THE most critical reference in this skill.** Firestore trigger loops and non-idempotent retries cause billing explosions ($1000s+), quota exhaustion, and data corruption.

## 1. At-Least-Once Delivery

Firebase event triggers (Firestore, Pub/Sub, Storage, etc.) do NOT guarantee exactly-once delivery. The same event CAN fire multiple times (retry, duplicate delivery).

**Idempotency = same input → same output, no extra side effects on repeat calls.**

If a function is NOT idempotent + retry is enabled → duplicated writes, double charges, duplicate emails, infinite loops.

## 2. Infinite Loop — The #1 Danger

**Root cause**: Firestore `onUpdate`/`onWrite` trigger writes to the SAME document → triggers itself → infinite loop.

### NEVER DO THIS
```js
// DANGEROUS — infinite loop!
exports.badFunction = onDocumentUpdated("users/{userId}", (event) => {
  return event.data.after.ref.update({ lastUpdated: new Date() });
  // ↑ This update triggers onDocumentUpdated again → loop forever
});
```

Real-world cost: A developer in 2024 got an **$8,000 bill** from a timestamp update loop.

## 3. Three-Layer Guard System (ALL REQUIRED for retry-enabled functions)

### Layer 1: Event Age Check (drops stale retries)
```js
const eventAgeMs = Date.now() - Date.parse(event.time);
if (eventAgeMs > 10000) { // 10 seconds
  console.log("Stale event dropped");
  return;
}
```

### Layer 2: Before/After Comparison (prevents self-trigger loops)
```js
exports.safeCounter = onDocumentUpdated("users/{userId}", (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();

  // Only run if the field we care about actually changed
  if (before.name === after.name) {
    console.log("No relevant change → loop prevented");
    return;
  }

  return event.data.after.ref.set({
    name_change_count: (after.name_change_count || 0) + 1
  }, { merge: true });
});
```

### Layer 3: Idempotency Key + Transaction (guarantees exactly-once processing)
```js
exports.processOrder = onDocumentCreated(
  { document: "orders/{orderId}", retry: true },
  async (event) => {
    const eventId = event.id;
    const processedRef = db.collection("processedEvents").doc(eventId);

    await db.runTransaction(async (t) => {
      const snap = await t.get(processedRef);
      if (snap.exists) return; // Already processed → idempotent skip

      // Do the work
      await event.data.ref.update({ status: "processed" });
      t.set(processedRef, { done: true, processedAt: FieldValue.serverTimestamp() });
    });
  }
);
```

### Python Example (same guards)
```python
@on_document_updated(document="users/{userId}")
def safe_counter(event):
    before = event.data.before.to_dict()
    after = event.data.after.to_dict()

    if before.get("name") == after.get("name"):
        return  # No change → prevent loop

    event.data.after.reference.update({
        "name_change_count": after.get("name_change_count", 0) + 1
    })
```

## 4. Alternative Loop Prevention Patterns

### Processed Flag / Timestamp
```js
const after = event.data.after.data();
const before = event.data.before.data();
if (after.processedAt && after.processedAt > before.processedAt) return;
await docRef.update({ processedAt: FieldValue.serverTimestamp() });
```

### Separate Collection
Write trigger output to a different collection instead of the same document:
- Trigger on `users/{userId}` → write to `userEvents/{eventId}`
- Or use subcollection: `users/{userId}/processed/{eventId}`

## 5. External API Idempotency

For external services (Stripe, SendGrid, etc.), use `event.id` as the idempotency key:

```js
const stripe = require("stripe")(stripeKey.value());
await stripe.charges.create({
  amount: 1000,
  currency: "usd",
  source: token,
}, {
  idempotencyKey: event.id  // Stripe deduplicates based on this
});
```

## 6. Retry Configuration

### 2nd Gen (recommended)
```js
{ retry: true }  // 24-hour retry window
```

### 1st Gen (legacy)
```js
.runWith({ failurePolicy: true })  // 7-day retry window
```

**RULE**: NEVER enable retry without all three guard layers. Retry + loop = 24 hours (or 7 days in 1st gen) of continuous invocations.

## 7. Decision Matrix

| Scenario | Required Guards |
|---|---|
| Firestore `onUpdate`/`onWrite` + no retry | Layer 2 (before/after) minimum |
| Firestore `onUpdate`/`onWrite` + retry | ALL THREE layers |
| Firestore `onCreate` + retry | Layer 1 (age) + Layer 3 (idempotency key) |
| HTTP / Callable | Standard HTTP idempotency (request dedup) |
| Pub/Sub + retry | Layer 1 + Layer 3 |
| External API call | Layer 3 + API-level idempotency key |
