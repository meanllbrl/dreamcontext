import { api, RequestError, type ApiClient } from '../../api/client';
import { adoptHandsfreeJob, refreshHandsfreeStatus } from './handsfreeStore';
import type { HandsfreeJob } from './handsfreeTypes';

export type ActionOutcome = { ok: true } | { ok: false; code: string; message: string };

/**
 * Start a hands-free job (`go`, `return`, `resume`, `rollback`, `abandon`, `devices/revoke-all`).
 * 202 adopts the new job; 409 `busy` adopts the one already running (another window or the
 * CLI started it). Either way the shared poller follows it from here.
 */
export async function startHandsfreeJob(path: string, body: Record<string, unknown> = {}, client: ApiClient = api): Promise<ActionOutcome> {
  try {
    const r = await client.post<{ job: HandsfreeJob }>(`/handsfree/${path}`, body);
    adoptHandsfreeJob(r.job);
    void refreshHandsfreeStatus();
    return { ok: true };
  } catch (err) {
    if (err instanceof RequestError) {
      if (err.code === 'busy') adoptHandsfreeJob(null);
      return { ok: false, code: err.code || String(err.status), message: err.message };
    }
    return { ok: false, code: 'network', message: err instanceof Error ? err.message : String(err) };
  }
}

/** Ask the waiting go/return to cut its running work now (409 `not_waiting` once it moved on). */
export async function cutCurrentJob(): Promise<ActionOutcome> {
  try {
    const r = await api.post<{ job: HandsfreeJob }>('/handsfree/jobs/current/cut', {});
    adoptHandsfreeJob(r.job);
    return { ok: true };
  } catch (err) {
    adoptHandsfreeJob(null);
    return err instanceof RequestError
      ? { ok: false, code: err.code || String(err.status), message: err.message }
      : { ok: false, code: 'network', message: String(err) };
  }
}
