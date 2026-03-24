---
name: firebase-cloud-functions
description: Complete Cloud Functions for Firebase skill — 2nd gen (Cloud Run) mandatory, idempotency, infinite loop prevention, scaling, secrets, and deployment. Use when writing or reviewing any Cloud Function.
compatibility: Requires Firebase CLI (`npm install -g firebase-tools`). 2nd gen (Cloud Run + Eventarc) is the standard. 1st gen is legacy only.
---

# Cloud Functions for Firebase

Serverless backend functions triggered by Firebase events (Firestore, Auth, Storage, HTTP, Pub/Sub, Scheduler, etc.). **2nd gen (Cloud Run)** is mandatory for all new code.

## Critical Rule: 2nd Gen Only

Agent MUST use `firebase-functions/v2` imports. If 1st gen syntax is detected, convert to 2nd gen. See [gen_comparison.md](references/gen_comparison.md).

## References

- **1st vs 2nd Gen Comparison**: [gen_comparison.md](references/gen_comparison.md)
- **Idempotency & Infinite Loop Prevention**: [idempotency.md](references/idempotency.md) — THE most critical reference. Read before writing any triggered function.
- **Scaling, Concurrency & Cold Start**: [scaling.md](references/scaling.md)
- **Secrets & Environment Config**: [secrets.md](references/secrets.md)
- **Triggers, Deployment & Runtime**: [triggers_and_deployment.md](references/triggers_and_deployment.md)
- **Local Testing & Emulator Suite**: [local_testing.md](references/local_testing.md) — emulator setup, debugging, idempotency testing protocol, CI/CD integration.

## Agent Pre-Function Checklist

Before generating ANY Cloud Function:

1. **2nd gen?** → `firebase-functions/v2` import. 1st gen = reject.
2. **Trigger type?** → Firestore onUpdate/onWrite = high loop risk.
3. **Idempotency guards?** → Event age check + before/after guard + transaction. ALL THREE for retry-enabled functions.
4. **Same document write?** → Guard is MANDATORY. No unconditional `update()` in Firestore triggers.
5. **Retry enabled?** → Without idempotency = REJECT the function. Never ship retry + non-idempotent.
6. **Concurrency + minInstances?** → HTTP: concurrency >= 200. Background: >= 80. Set minInstances to avoid cold start.
7. **Secrets?** → `defineSecret()` + Secret Manager. NEVER `functions.config()` (deprecated, removed March 2027).
8. **Timeout/memory/CPU?** → Set realistic values in options.
9. **Quota risk?** → Loop + retry = potential $1000s bill. Always cap with maxInstances.

### Prohibitions

- Unconditional `update()` / `set()` inside Firestore `onUpdate`/`onWrite`
- `retry: true` without idempotency guards
- `functions.config()` (deprecated)
- 1st gen syntax in new code
- `setTimeout` / background activity after response sent
