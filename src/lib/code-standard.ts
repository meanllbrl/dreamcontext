/**
 * The engineering rules dreamcontext's code agents carry themselves.
 *
 * Until 0.40.x these lived in the optional `engineering` skill pack, and every
 * build and review agent preloaded it (`skills: [engineering]`). A project that never
 * installed the pack got agents that named a skill they could not open, and silently
 * worked without the rules. Owner, 2026-11-04: "ajanlar yutsun onu", so the pack is
 * retired and its rules live in the agents.
 *
 * One copy per block, here. The agent files under `agents/` carry a verbatim
 * copy (a sub-agent file cannot import TypeScript), and `tests/unit/code-standard.test.ts`
 * holds every copy equal. The goal-skill planner and builders run as `claude -p` sessions
 * that never read an agent file, so their briefs (planner-brief.ts, builder-brief.ts)
 * interpolate these constants directly.
 *
 * The retirement ran behind a nothing-lost ledger: every rule of the old pack is in one of
 * these blocks, in a specialist's own section (review-security, review-edge-cases,
 * review-frontend, review-cloud-functions, goal-validator), or was dropped with a reason
 * (how-to reference, vendor preference, style a reviewer is told not to flag). A rule added
 * here is added once; the drift test carries it to every copy.
 */

/** The shared bar for every agent that builds or judges code. */
export const CODE_STANDARD = `## The code standard

Built in: there is no skill to load for it. A change that breaks one of these is what a review fails.

- **Input is hostile.** Validate type and content at every boundary (API, form, file, webhook,
  data read back from outside) with a schema. Queries are parameterised and commands take
  argument arrays: never string-built SQL or shell. Escape output; no raw HTML sink
  (\`innerHTML\`, \`dangerouslySetInnerHTML\`, \`v-html\`) with user content.
- **Secrets** never sit in code, git, logs or a client bundle: \`.env\` is gitignored, production
  reads a secret manager, and a missing required variable stops the boot instead of falling
  back to a default. A leaked key is revoked and rotated now, not later.
- **Access** is checked on the server for every protected request (a hidden button is not
  security), with least privilege. Standard auth (OAuth2/OIDC), bcrypt or argon2 for
  passwords, never home-made crypto, HTTPS only, no default passwords or debug mode in
  production. No tokens or needless PII in logs.
- **Errors fail loudly.** Never swallow one (\`catch (e) { console.log(e) }\` is banned): add what
  failed and with which input, then rethrow or return a real error of a specific type.
  Expected failures (validation, auth, rate limit) get a proper status; unexpected ones are
  logged and alerted; a client never sees a stack trace.
- **Writes survive retries and partial failure.** Work that can run twice is idempotent (an
  idempotency key on payments and other critical writes); steps that must land together share
  a transaction; transient failures retry with backoff and jitter, at most 3 times; every
  outbound call has a timeout.
- **Tests** are deterministic and pass in isolation: unit tests for logic, integration tests for
  flows, end-to-end only for critical paths. Side effects are injected so logic can be tested.
  Nothing ships on a red test, and a test is never weakened to pass.
- **Keep it simple.** KISS and YAGNI (build for now, no speculative scaffolding); reuse what
  exists before writing new (DRY); one job per function; typed inputs and outputs, no \`any\`;
  named constants, not magic strings. Measure before optimising. A new dependency is
  pinned in the lock file and checked (owner, upkeep, audit) before it goes in.`;

/** What a plan owes the code standard before any code exists. Planner and plan reviewer. */
export const PLAN_STANDARD = `## What a plan owes the code standard

- **Threat-model it.** For each new surface ask how someone could abuse it, and plan the guard
  (auth, validation, rate limit) as a step of its own.
- **Infrastructure** choices name their cost at today's load and at 10x; managed or serverless
  before self-managed, and say why when not. A first production deploy plans its error
  alerting.
- **Data changes:** a migration is a new file (an old one is never edited), reversible, and
  expand-then-contract (no column dropped in the same deploy as the code that stops using it).
- **The test plan** names a level per criterion (unit, integration, emulator, end-to-end).
  Firebase work is tested against the Emulator Suite, never production.`;

/** Domain rules for the agents that build or review code of every kind. Implementer and reviewer. */
export const DOMAIN_RULES = `## When the change is one of these

- **A backend endpoint:** every public one is rate limited (429 with \`Retry-After\`); CORS
  allows named origins, never \`*\` in production; every incoming webhook's signature is
  verified; session cookies are HttpOnly, Secure and SameSite; no N+1 queries; business logic
  sits in a service, not in a long handler.
- **A web UI:** every async action shows loading, success, error (a specific message and a way
  to retry) and empty states; animate \`transform\` and \`opacity\` only and honour
  \`prefers-reduced-motion\`; server data goes through a query cache (TanStack Query), not
  hand-rolled global state; sensitive tokens live in httpOnly cookies, never \`localStorage\`;
  TypeScript strict. Layout, tokens and accessibility are the \`design\` skill's.
- **A Cloud Function:** 2nd gen (\`firebase-functions/v2\`), never \`functions.config()\`; a trigger
  that writes to its own source compares before and after first; a retried trigger records its
  event id in the same transaction as its writes; secrets come through \`defineSecret\` and are
  read inside the handler; \`maxInstances\` is set; no work after the response is sent.
- **Firestore:** rules start from deny and check owner and fields on create and update (nobody
  sets or changes another user's uid), with rule tests in the emulator; counts and sums run on
  the server (aggregation queries), pagination uses cursors, never offsets; a compound query
  has its composite index (equality fields, then the one range field, then \`orderBy\`).`;
