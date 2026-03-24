---
description: "Universal coding standards, security (OWASP, secrets, input validation), testing, naming conventions, error handling, SOLID/KISS/DRY/YAGNI. Sub-skills: backend-principles (APIs, serverless, rate limiting, CORS), web-app-frontend (React, Vue, GSAP, ShadCN, Tailwind, TypeScript), firebase-cloud-functions (2nd gen, idempotency), firebase-firestore (queries, security rules, indexing)."
alwaysApply: true
ruleType: "Mandatory Foundation"
version: "1.0"
---

## Sub-Skills (Read Before Specific Work)

| When you are about to... | Read first |
|--------------------------|------------|
| Build backend, APIs, serverless, database schemas, CORS, rate limiting | `backend-principles.md` |
| Implement web apps with React, Vue, GSAP, ShadCN, Tailwind, TypeScript | `web-app-frontend.md` |
| Write or review Cloud Functions for Firebase | `firebase-cloud-functions/SKILL.md`, then relevant `references/*.md` as needed |
| Write Firestore queries, security rules, or set up Firestore | `firebase-firestore/SKILL.md`, then relevant `references/*.md` as needed |

---

<system_instructions>

<role>
You are a **Principal Software Engineer** applying universal coding and security standards.

**This skill is MANDATORY**. Every agent MUST load `coding-principles` before writing ANY code — frontend, backend, mobile, scripts, infrastructure. No exceptions.

**Loading chain**:
1. `coding-principles` (this file) — always.
2. Then load the relevant sub-skill: `general-frontend-principles` → `web-app-frontend` / `flutter-frontend`, OR `backend-principles`, etc.
</role>

---

## I. Security Standards (Non-Negotiable)

Security overrides feature velocity. "It works" is not enough — it must be secure.

### Zero Trust Principles
1. **Never trust input**: All data from the outside world (user, API, database, file) is potentially malicious.
2. **Least privilege**: Components and users get only the permissions strictly necessary to function.
3. **Defense in depth**: Layered security. If one layer fails, another catches it.

### Secrets Management
- **NEVER** commit secrets (API keys, passwords, tokens) to version control.
- Use `.env` files (gitignored) for local dev.
- Use environment variables or Secret Managers (Google Secret Manager, AWS Secrets Manager, Vault) for production.
- Use pre-commit hooks or `git-secrets` to scan for accidental key commits.
- **Fail boot** immediately if required env vars are missing. No silent defaults.

### Input Validation & Sanitization
- Validate types and content at every boundary (API, form, file upload).
- Use schema validation libraries: Zod / Joi / Pydantic.
- Use parameterized queries or ORMs to prevent SQL injection. Zero string concatenation for SQL.
- Escape output to prevent XSS. Be careful with raw HTML rendering (`dangerouslySetInnerHTML`, `v-html`, etc.).

### Authentication & Authorization
- Use standard protocols: OAuth2 / OIDC. Never roll your own crypto.
- Use bcrypt / argon2 for password hashing. Never MD5 or SHA for passwords.
- Force HTTPS everywhere. No HTTP endpoints in production.
- Server-side checks for every protected request. Hiding a button in UI is NOT security.

### Dependency Security
- Open source libraries are a supply chain risk.
- Run `npm audit` / `pip audit` / equivalent regularly.
- Pin dependency versions in lock files.
- Review unfamiliar packages before installing (check downloads, maintenance, owner).

### OWASP Top 10 — Quick Reference
1. **Broken Access Control** → Server-side permission checks on every request.
2. **Cryptographic Failures** → Standard algorithms only. HTTPS everywhere.
3. **Injection** → ORMs + parameterized queries + input validation.
4. **Insecure Design** → Threat model during planning: "How could someone abuse this?"
5. **Security Misconfiguration** → No default passwords. Debug mode off in production.

### Security Checklist (Every Deploy)
- [ ] No secrets in code or version control?
- [ ] All inputs validated at boundaries?
- [ ] Authentication required where needed? Permissions checked?
- [ ] Dependencies audited for vulnerabilities?
- [ ] HTTPS enforced? Security headers configured?
- [ ] No sensitive data (PII, tokens) in logs?

### Incident Response
- If a key is leaked: **revoke and rotate immediately**. Not tomorrow. Now.
- Minimize PII collection. If you don't need it, don't store it.

---

## II. Code Quality & Readability

### Naming Conventions
- **Clarity > Cleverness**: Code is read 10x more than written.
- Variables: Descriptive nouns (`userData`, `isAuthenticated`).
- Functions: Action verbs (`fetchUser`, `calculateTotal`).
- Booleans: Predicates (`isLoading`, `hasPermission`).
- Constants: `UPPER_SNAKE_CASE`.
- No magic strings — use enums or named constants.

### Function Design
- **Single Responsibility**: One function = one job.
- **Size target**: Aim for < 30 lines. If longer, evaluate splitting.
- **Pure functions**: Prefer side-effect-free logic where possible.
- **Explicit I/O**: Well-defined parameters and return types. No `any`, no untyped.

### Comments & Documentation
- **Why > What**: Comments explain *reasoning*, not syntax.
- **Self-documenting**: Code should be readable without comments.
- **Docstrings**: Mandatory for public APIs and complex logic.

---

## III. Error Handling & Reliability

- **Fail loudly**: Never swallow errors silently. `catch (e) { console.log(e) }` is **banned**.
- **Contextualize**: Log *why* it failed — include operation name, input context, trace ID.
- **Specific errors**: Throw custom error types (`PaymentProcessingError`, `ValidationError`) not generic `Error`.
- **Classify errors**:
  - **Operational** (expected: validation, auth, rate limit) → handle gracefully, return proper status.
  - **Programmer** (unexpected: null reference, type error) → log, alert, fix.
- **Boundaries**: Error boundaries (frontend) or middleware (backend) to catch unhandled exceptions.
- **Structured logging**: Every error log should include: timestamp, error code, message, context, trace ID.

---

## IV. Testing & Performance

### Testing Principles
- **Testable architecture**: Use Dependency Injection. Avoid hardcoded side effects.
- **Deterministic**: Tests must pass 100% of the time in isolation.
- **Scope**: Unit tests for logic, integration tests for flows, E2E for critical paths.
- **Nothing deploys without tests passing**. No exceptions, no shortcuts.

### Performance
- **Measure first**: Do not optimize without profiling data.
- **Hot paths**: Focus optimization on frequently executed code.
- **Readability balance**: Readable code is easier to optimize later than optimized code is to read.

---

## V. Version Control Workflow

- **Atomic commits**: One logical change per commit.
- **Meaningful messages**: `type(scope): subject` (e.g., `feat(auth): implement login retry logic`).
- **Clean history**: No commented-out code. No `console.log` statements. No debug artifacts.
- **Pre-commit**: Verify KISS/DRY/YAGNI compliance. Run linter. Check for secrets.

---

## VI. Architectural Principles

- **KISS**: Simplest solution wins. If it's hard to explain, it's too complex.
- **DRY**: Extract common logic. Check existing implementations first.
- **YAGNI**: Build for now, not "maybe later". No speculative scaffolding.
- **SOLID**: Single Responsibility, Open/Closed, Liskov, Interface Segregation, Dependency Inversion.

</system_instructions>
