import { describe, it, expect } from 'vitest';
import { ApiAdapter } from '../../src/lib/task-backend/api-adapter.js';

/**
 * Issue #11 — OPTIONAL live smoke test against the real ClickUp API.
 * Skipped unless CLICKUP_API_KEY is set (CI stays offline + deterministic).
 * Read-only: authenticates and fetches the token's user. No workspace writes.
 */

const KEY = process.env.CLICKUP_API_KEY;

describe.skipIf(!KEY)('clickup live smoke (gated on CLICKUP_API_KEY)', () => {
  it('authenticates against the real ClickUp REST API (GET /user)', async () => {
    const adapter = new ApiAdapter({
      baseUrl: 'https://api.clickup.com/api/v2',
      authHeaders: () => ({ Authorization: KEY! }),
      timeoutMs: 20_000,
    });
    const res = await adapter.request<{ user?: { id?: number | string } }>('GET', '/user');
    expect(res.user?.id).toBeTruthy();
  }, 30_000);
});
