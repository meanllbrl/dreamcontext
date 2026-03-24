# Secrets & Environment Configuration

## functions.config() is DEPRECATED

`functions.config()` is deprecated and will be **removed March 2027**. Agent MUST NOT use it.

## Correct Approach: Parameterized Config + Secret Manager

### Secrets (API keys, credentials)

```js
const { defineSecret } = require("firebase-functions/params");
const apiKey = defineSecret("API_KEY");
const stripeKey = defineSecret("STRIPE_SECRET_KEY");

exports.myFunc = onRequest(
  { secrets: [apiKey, stripeKey] },  // Declare which secrets this function needs
  (req, res) => {
    const key = apiKey.value();      // Access at runtime
    const stripe = require("stripe")(stripeKey.value());
  }
);
```

### CLI Commands

```bash
firebase functions:secrets:set API_KEY          # Set a secret
firebase functions:secrets:access API_KEY       # Read current value
firebase functions:secrets:destroy API_KEY      # Delete
firebase functions:secrets:prune                # Remove unused secrets
```

### Environment Variables (non-sensitive config)

```js
const { defineString, defineInt } = require("firebase-functions/params");

const region = defineString("REGION", { default: "us-central1" });
const maxRetries = defineInt("MAX_RETRIES", { default: 3 });
```

### .env Files (development only)

```
# .env (all environments)
REGION=us-central1

# .env.local (emulator only — gitignored)
API_KEY=test-key-123
```

**NEVER commit `.env` files with real secrets to version control.**

## Secret Access Scope

- Secrets are only available to functions that declare them in `secrets: [...]`.
- Undeclared access → runtime error (value is empty).
- Security rules do NOT apply to secrets — they are Cloud-level access control.

## Service Account

2nd gen uses **Compute Engine default service account** (more restrictive than 1st gen's App Engine default).

Override per function:
```js
{
  serviceAccount: "custom-sa@project.iam.gserviceaccount.com"
}
```
