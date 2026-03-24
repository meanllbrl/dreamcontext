# Triggers, Deployment & Runtime

## All Trigger Types (2nd Gen)

```js
// HTTP
const { onRequest, onCall } = require("firebase-functions/v2/https");

// Firestore
const { onDocumentCreated, onDocumentUpdated, onDocumentDeleted, onDocumentWritten } = require("firebase-functions/v2/firestore");

// Auth
const { onAuthUserCreated, onAuthUserDeleted } = require("firebase-functions/v2/identity");

// Storage
const { onObjectFinalized, onObjectDeleted } = require("firebase-functions/v2/storage");

// Pub/Sub
const { onMessagePublished } = require("firebase-functions/v2/pubsub");

// Scheduler (cron)
const { onSchedule } = require("firebase-functions/v2/scheduler");

// Task Queue
const { onTaskDispatched } = require("firebase-functions/v2/tasks");

// Eventarc (custom events — 90+ sources)
const { onCustomEventPublished } = require("firebase-functions/v2/eventarc");
```

## Trigger Examples

### HTTP (onRequest)
```js
exports.api = onRequest({
  timeoutSeconds: 60,
  memory: "512MiB",
  concurrency: 500,
}, async (req, res) => {
  res.json({ status: "ok" });
});
```

### HTTP Callable (onCall)
```js
exports.addMessage = onCall({
  enforceAppCheck: true,
}, async (request) => {
  const text = request.data.text;
  const uid = request.auth?.uid;
  // ...
  return { result: "ok" };
});
```

### Firestore Trigger
```js
exports.userUpdated = onDocumentUpdated(
  { document: "users/{userId}", retry: true, concurrency: 200 },
  async (event) => {
    const before = event.data.before.data();
    const after = event.data.after.data();
    // Always compare before/after — see idempotency.md
  }
);
```

### Scheduled (Cron)
```js
exports.dailyCleanup = onSchedule("every day 02:00", async (event) => {
  // Runs daily at 2 AM
});
```

### Storage Trigger
```js
exports.onUpload = onObjectFinalized(
  { bucket: "my-bucket" },
  async (event) => {
    const filePath = event.data.name;
    const contentType = event.data.contentType;
  }
);
```

## Deployment

```bash
# Deploy all functions
firebase deploy --only functions

# Deploy specific function
firebase deploy --only functions:myFunc

# Deploy multiple
firebase deploy --only functions:funcA,functions:funcB

# Delete a function
firebase functions:delete myFunc --force

# List deployed functions
firebase functions:list
```

## Renaming / Changing Trigger or Region

Changing a function's name, trigger type, or region requires the **rename + deploy + delete** pattern to avoid downtime:

1. Rename the function in code (new name)
2. Deploy → both old and new functions run
3. Delete old function: `firebase functions:delete oldName --force`

**NEVER** change trigger/region in-place — it causes downtime.

## Testing with Emulator

```bash
firebase emulators:start --only functions

# With Firestore emulator (for trigger testing)
firebase emulators:start --only functions,firestore
```

Test idempotency: trigger the same event 3–5 times and verify no duplicates or loops.

## Project Structure (Recommended)

```
functions/
├── package.json
├── index.js          # or index.ts
├── .env              # non-sensitive defaults
├── .env.local        # emulator secrets (gitignored)
└── src/
    ├── http/         # HTTP + Callable functions
    ├── triggers/     # Firestore, Auth, Storage triggers
    ├── scheduled/    # Cron jobs
    └── shared/       # Shared utilities, clients
```
