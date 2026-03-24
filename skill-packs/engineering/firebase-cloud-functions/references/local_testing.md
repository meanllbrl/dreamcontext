# Cloud Functions Local Testing – Emulator Suite Deep Dive

Test everything locally before deploying. Zero risk, zero cost.

## 1. Setup (One-time)

```bash
npm install -g firebase-tools@latest
firebase login
firebase init emulators
```

Requirements:
- `firebase-admin` >= 8.0.0
- `firebase-functions` >= 3.0.0 (v2 syntax for 2nd gen)
- Java 11+ (Firestore emulator requires JVM)

### firebase.json emulator config
```json
{
  "emulators": {
    "functions": { "port": 5001 },
    "firestore": { "port": 8080 },
    "auth": { "port": 9099 },
    "storage": { "port": 9199 },
    "pubsub": { "port": 8085 },
    "eventarc": { "port": 9299 },
    "ui": { "port": 4000 }
  }
}
```

## 2. Running the Emulator

```bash
# All emulators (recommended)
firebase emulators:start

# Specific emulators
firebase emulators:start --only functions,firestore,auth

# Run tests then auto-shutdown
firebase emulators:exec "npm test" --only functions,firestore

# Debug mode (VS Code / Chrome DevTools breakpoints)
firebase emulators:start --inspect-functions
# → Open chrome://inspect to attach debugger
```

### Demo Project (safest — never touches production)
```bash
firebase use --add demo-myproject   # demo- prefix is mandatory
```

## 3. Supported Function Types in Emulator

| Type | How to Test |
|---|---|
| HTTPS / Callable | `http://localhost:5001/<project>/<region>/<name>` |
| Firestore triggers | Write via Admin SDK or Emulator UI → trigger fires |
| Auth triggers | Create user via Admin SDK or Emulator UI |
| Storage triggers | Upload file via Emulator UI |
| Pub/Sub | Publish message via Admin SDK |
| Eventarc (2nd gen) | `firebase emulators:start --only functions,eventarc` |
| Alerts | Send synthetic alert from Emulator UI (Alerts tab) |
| Scheduled | NO native emulator support → test via manual HTTP trigger |
| Task Queue | Dispatch works, but rate limiting differs from production |

### 2nd Gen + Eventarc Setup
```bash
firebase emulators:start --only functions,eventarc
# EVENTARC_EMULATOR=localhost:9299 is set automatically
# Admin SDK captures events automatically
```

## 4. Connecting Client Apps to Emulator

### Web (Firebase v10+ Modular)
```js
import { getFunctions, connectFunctionsEmulator } from "firebase/functions";
const functions = getFunctions();
connectFunctionsEmulator(functions, "127.0.0.1", 5001);
```

### Android (Kotlin)
```kotlin
Firebase.functions.useEmulator("10.0.2.2", 5001)
```

### iOS (Swift)
```swift
Functions.functions().useEmulator(withHost: "localhost", port: 5001)
```

HTTPS functions: call `http://localhost:5001/...` directly.

## 5. Environment & Secrets in Emulator

### .env.local (highest priority, emulator-only)
```
# .env.local (gitignored, only used in emulator)
API_KEY=local-test-key
AUDIENCE=Local Humans
```

### Secrets
- Create `.secret.local` to override production secrets locally.
- Without `.secret.local`, emulator pulls from Secret Manager via ADC (Application Default Credentials).
- `.secret.local` takes priority.

### Legacy Runtime Config
```bash
firebase functions:config:get > .runtimeconfig.json
# Emulator reads this file automatically
```

## 6. Emulator UI (localhost:4000)

The most powerful debugging tool:
- **Logs** → real-time `console.log` / `console.error` output
- **Functions** → list of active triggers with execution details
- **Firestore / Auth / Storage** → modify data directly, triggers fire automatically
- **Alerts** → send synthetic alert events
- **Execution Details** → input/output payloads, runtime duration, error stacks

## 7. Debugging

### Terminal + Emulator UI
Both show logs simultaneously. `console.error` appears in red.

### VS Code Debugger
```bash
firebase emulators:start --inspect-functions
```
Then attach VS Code debugger or use `chrome://inspect`.

### Breakpoints
With `--inspect-functions`, set breakpoints in VS Code. Step through trigger execution line by line.

## 8. Local vs Production Differences

| Aspect | Local Emulator | Production (Cloud Run) | Test Strategy |
|---|---|---|---|
| Retries | NOT supported | 24-hour window (2nd gen) | Manually trigger same event 3-5x |
| Concurrency | Unlimited (local CPU) | 1–1000 per instance | Cannot test locally |
| Cold Start | None (always warm) | 500ms–5s possible | Test after real deploy |
| Timeout | `timeoutSeconds` honored | Same | Same code works |
| Memory/CPU | Unlimited (local machine) | 32 GiB / 4 vCPU max | Local test is valid |
| OS | Your machine (macOS/Windows) | Linux container | Bundle Linux binaries if needed |
| IAM | ADC (your credentials) | Service account | Test IAM in production |
| Networking | localhost only | Internet + VPC | Mock external APIs locally |

## 9. Idempotency & Loop Testing Protocol

Since retries don't work in the emulator, test idempotency manually:

1. **Trigger the same event 5 times** (via Emulator UI or Admin SDK script)
2. Verify `before/after` guard prevents re-processing
3. Verify `eventAgeMs` check would drop stale events (simulate with old timestamps)
4. Check `processedEvents` collection in emulator Firestore — should have exactly 1 entry per event
5. Verify no infinite loop: watch Emulator UI logs for recursive trigger patterns

```js
// Test script: trigger same Firestore write 5 times
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "demo-test" });
const db = admin.firestore();
db.settings({ host: "localhost:8080", ssl: false });

for (let i = 0; i < 5; i++) {
  await db.doc("users/test-user").set({ name: "Test", iteration: i });
}
// Check: function should process only relevant changes, not loop
```

## 10. Advanced Testing Patterns

### Unit Tests (Firebase Test SDK)
```bash
npm install --save-dev @firebase/rules-unit-testing
```
Use with Mocha or Jest for isolated function testing.

### Integration Tests with Auto-Shutdown
```bash
firebase emulators:exec "npm test" --only functions,firestore
# Starts emulators → runs tests → shuts down automatically
```

### Data Seeding
- Import/export Firestore data via Emulator UI
- Or seed programmatically with Admin SDK in test setup

### CI/CD Pipeline
```bash
# In CI (GitHub Actions, etc.)
firebase emulators:exec "npm test" --only functions,firestore
```
Java 11+ must be available in CI environment.

## 11. Agent Testing Checklist

Before considering any function "tested":

1. `firebase emulators:start --only functions,firestore,eventarc` running?
2. Client SDK has `connectFunctionsEmulator` / `useEmulator` call?
3. 2nd gen functions: Eventarc emulator included?
4. `.env.local` + `.secret.local` configured for local secrets?
5. Idempotency test: same event triggered 3+ times, no duplicates?
6. Loop guard test: `before/after` comparison verified in logs?
7. Emulator UI logs checked for unexpected re-triggers?
8. Production differences documented (retry, scaling, OS)?
9. `emulators:exec` used for CI/automated test runs?

### Prohibitions
- Deploying to production without local emulator testing
- Relying on production retries instead of testing idempotency locally
- Depending on local-only native commands (ImageMagick, etc.) without bundling for Linux
