/**
 * In-process route calls for the C5 server tests (plan r3 § W4): a fake request with a
 * JSON body and chosen headers, and a response that records the status and the JSON.
 */
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { markPhoneSocket } from '../../src/server/phone-origin.js';

/** The loopback dashboard origin a real browser write carries. */
export const DASHBOARD_ORIGIN = 'http://127.0.0.1:4173';

export interface FakeRequestOptions {
  method?: string;
  url?: string;
  body?: unknown;
  /** Set to null to send no Origin header at all (a scripted call). */
  origin?: string | null;
  /** Mark the request as arriving on the phone listener. */
  phone?: boolean;
}

export function fakeRequest(opts: FakeRequestOptions = {}): IncomingMessage {
  const chunks = opts.body === undefined ? [] : [Buffer.from(JSON.stringify(opts.body))];
  const req = Readable.from(chunks) as unknown as IncomingMessage;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const origin = opts.origin === undefined ? DASHBOARD_ORIGIN : opts.origin;
  if (origin !== null) headers.origin = origin;
  const socket = {};
  if (opts.phone) markPhoneSocket(socket);
  Object.assign(req, { method: opts.method ?? 'POST', url: opts.url ?? '/', headers, socket });
  return req;
}

export interface RecordedResponse {
  res: ServerResponse;
  code: () => number;
  json: () => Record<string, unknown>;
}

export function fakeResponse(): RecordedResponse {
  let code = 0;
  let out = '';
  const res = {
    writeHead(c: number) { code = c; return res; },
    end(d?: string) { out = d ?? ''; return res; },
    setHeader() { return res; },
  } as unknown as ServerResponse;
  return {
    res,
    code: () => code,
    json: () => (out ? JSON.parse(out) as Record<string, unknown> : {}),
  };
}

type Handler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, contextRoot: string) => Promise<void>;

/** Call a route handler; returns its status and JSON body. */
export async function call(
  handler: Handler,
  contextRoot: string,
  params: Record<string, string> = {},
  opts: FakeRequestOptions = {},
): Promise<{ code: number; body: Record<string, unknown> }> {
  const r = fakeResponse();
  await handler(fakeRequest(opts), r.res, params, contextRoot);
  return { code: r.code(), body: r.json() };
}
