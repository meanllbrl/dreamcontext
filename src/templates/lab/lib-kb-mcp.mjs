/**
 * lib-kb-mcp.mjs — KB MCP client for dreamcontext Lab insight scripts.
 * neonbi-data-api v2.3 · copy to `_dream_context/lab/scripts/lib-kb-mcp.mjs`, unchanged.
 *
 * The insight script calls the KB's `/mcp` itself, on every sync, with the
 * member's own SCRIPT KEY (installed by their agent: kb_script_key). It reads exactly what the
 * member can read, every call is audited under their name, and among the
 * provider tools it reaches only the read-only ones (NeonBI, Kreatif API) —
 * never one that spends. No NeonBI token, no snapshot file.
 *
 * Key: `KB_MCP_KEY` — from the Lab context (`ctx.credentials`, what the
 * command `kb_script_key` returns writes into lab credentials), else the
 * environment, else `lab/credentials.json` next to this folder. Never in
 * code, never in a manifest, never in a chat.
 *
 *   import { chartQuery, freshnessOf } from "./lib-kb-mcp.mjs";
 *   const r = await chartQuery(ctx, { vault: "kitup", chart: "cht_…",
 *     dimensions: ["date"], metrics: ["total_spend_web"],
 *     filters: [F.eq("product", "Kitup"), F.between("date", from, to)], granularity: "day" });
 *   r.rows.map((row) => valueOf(r, row, "total_spend_web"));
 *
 * Every failure THROWS with a readable message, so the Lab card shows the
 * error and keeps the previous series — a failed call never becomes a zero.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const KB_MCP_URL =
  process.env.KB_MCP_URL || "https://nativeminds-kb-backend-561248800637.europe-west1.run.app/mcp";
const PROTOCOL_VERSION = "2026-07-28";
const CLIENT = { name: "dreamcontext-lab", version: "2.3" };
const CRED_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "credentials.json");

// NeonBI allows 120 requests a minute per data-source token, and that token is
// shared by every script and person on the vault. This process stays well under
// it: at most 3 calls in flight and 60 a minute. Do not add parallelism on top.
// A script that already paces itself machine-wide (a multi-query explorer with
// its own ledger) may raise both with configurePacing().
let MAX_IN_FLIGHT = 3;
let MAX_PER_MINUTE = 60;
const RETRY_WAITS_MS = [15_000, 30_000, 60_000];
const REQUEST_TIMEOUT_MS = 60_000;

export class KbMcpError extends Error {
  constructor(message, { status = null, kind = "tool" } = {}) {
    super(message);
    this.name = "KbMcpError";
    this.status = status;
    this.kind = kind; // auth | forbidden | rate_limit | protocol | tool | network
  }
}

/* ── key ─────────────────────────────────────────────────────────────── */

function keyFrom(ctx) {
  const fromCtx = ctx?.credentials?.KB_MCP_KEY;
  if (fromCtx) return String(fromCtx).trim();
  if (process.env.KB_MCP_KEY) return process.env.KB_MCP_KEY.trim();
  try {
    const file = JSON.parse(readFileSync(CRED_FILE, "utf8"));
    if (file.KB_MCP_KEY) return String(file.KB_MCP_KEY).trim();
  } catch {
    // no file: fall through to the error below
  }
  return "";
}

function requireKey(ctx) {
  const key = keyFrom(ctx);
  if (!key.startsWith("nmk_")) {
    throw new KbMcpError(
      "KB_MCP_KEY yok. Claude'a \"KB script key'imi kur\" de: Claude kb_script_key ile " +
        "key'i kurar ve değeri görmeden lab/credentials.json'a yazar.",
      { kind: "auth" },
    );
  }
  return key;
}

/* ── pacing: in-flight cap + per-minute budget + one shared cool-down ── */

/** Raise or lower this process's pacing. Only for a script that enforces its own
 *  machine-wide budget; the NeonBI ceiling (120/min per token) still applies. */
export function configurePacing({ maxInFlight, perMinute } = {}) {
  if (Number.isInteger(maxInFlight) && maxInFlight > 0) MAX_IN_FLIGHT = Math.min(maxInFlight, 16);
  if (Number.isInteger(perMinute) && perMinute > 0) MAX_PER_MINUTE = Math.min(perMinute, 110);
}

let inFlight = 0;
const waiting = [];
const startedAt = [];
let coolUntil = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function acquire() {
  if (inFlight >= MAX_IN_FLIGHT) await new Promise((resolve) => waiting.push(resolve));
  inFlight++;
  for (;;) {
    const now = Date.now();
    while (startedAt.length && now - startedAt[0] > 60_000) startedAt.shift();
    const wait = Math.max(coolUntil - now, startedAt.length >= MAX_PER_MINUTE ? 60_000 - (now - startedAt[0]) : 0);
    if (wait <= 0) break;
    await sleep(wait);
  }
  startedAt.push(Date.now());
}

function release() {
  inFlight--;
  const next = waiting.shift();
  if (next) next();
}

/* ── the call ────────────────────────────────────────────────────────── */

// Mcp-Name must be plain printable ASCII or the spec's base64 sentinel.
const headerValue = (v) =>
  /^[\x20-\x7e]*$/.test(v) ? v : `=?base64?${Buffer.from(v, "utf8").toString("base64")}?=`;

function parseBody(text) {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const frames = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
  if (!frames.length) throw new KbMcpError("KB returned an empty response", { kind: "protocol" });
  return JSON.parse(frames[frames.length - 1]);
}

const isRateLimit = (msg) => /rate limit|CAPPED|429/i.test(msg);

async function postOnce(key, name, args) {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name,
      arguments: args,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
        "io.modelcontextprotocol/clientInfo": CLIENT,
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  };
  let res;
  try {
    res = await fetch(KB_MCP_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": PROTOCOL_VERSION,
        "Mcp-Method": "tools/call",
        "Mcp-Name": headerValue(name),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new KbMcpError(`KB'ye ulaşılamadı: ${err?.message ?? err}`, { kind: "network" });
  }
  const text = await res.text();

  if (res.status === 401) {
    throw new KbMcpError(
      "KB script key'i reddetti (401): key iptal edilmiş, bağlı olduğu uygulamanın bağlantısı " +
        "kesilmiş ya da KB üyeliğin kalkmış. Claude'a \"KB script key'imi yeniden kur\" de.",
      { status: 401, kind: "auth" },
    );
  }
  if (res.status === 403) {
    throw new KbMcpError(`KB bu çağrıyı reddetti (403): ${text.slice(0, 300)}`, { status: 403, kind: "forbidden" });
  }
  if (res.status === 429) {
    const after = Number(res.headers.get("retry-after"));
    const err = new KbMcpError("KB rate limit (429)", { status: 429, kind: "rate_limit" });
    err.retryAfterMs = Number.isFinite(after) && after > 0 ? after * 1000 : null;
    throw err;
  }

  let reply;
  try {
    reply = parseBody(text);
  } catch (err) {
    if (err instanceof KbMcpError) throw err;
    throw new KbMcpError(`KB cevabı okunamadı (HTTP ${res.status}): ${text.slice(0, 200)}`, {
      status: res.status, kind: "protocol",
    });
  }
  if (reply.error) {
    throw new KbMcpError(`KB protokol hatası: ${reply.error.message ?? JSON.stringify(reply.error)}`, {
      status: res.status, kind: "protocol",
    });
  }
  const result = reply.result ?? {};
  const message = (result.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  if (result.isError) {
    throw new KbMcpError(`${name}: ${message || "tool error"}`, {
      kind: isRateLimit(message) ? "rate_limit" : "tool",
    });
  }
  return { text: message, structured: result.structuredContent ?? null };
}

/**
 * Call one KB tool. Returns `{ text, structured }`. Rate limits wait and retry
 * (15 s, 30 s, 60 s, every other call in this process waits too); anything
 * else throws a KbMcpError at once.
 */
export async function callTool(ctx, name, args = {}) {
  const key = requireKey(ctx);
  for (let attempt = 0; ; attempt++) {
    await acquire();
    try {
      return await postOnce(key, name, args);
    } catch (err) {
      if (!(err instanceof KbMcpError) || err.kind !== "rate_limit" || attempt >= RETRY_WAITS_MS.length) {
        if (err instanceof KbMcpError && err.kind === "rate_limit") {
          err.message = `${err.message} — ${RETRY_WAITS_MS.length + 1} denemeden sonra hâlâ limitte; daha sonra yeniden sync et.`;
        }
        throw err;
      }
      const wait = err.retryAfterMs ?? RETRY_WAITS_MS[attempt];
      coolUntil = Math.max(coolUntil, Date.now() + wait);
    } finally {
      release();
    }
  }
}

/* ── NeonBI charts through the vault door ────────────────────────────── */

/** Filter builders in the provider's grammar (`value` for one, `values` for many). */
export const F = {
  eq: (field, value) => ({ field, op: "=", value }),
  ne: (field, value) => ({ field, op: "!=", value }),
  gt: (field, value) => ({ field, op: ">", value }),
  gte: (field, value) => ({ field, op: ">=", value }),
  lt: (field, value) => ({ field, op: "<", value }),
  lte: (field, value) => ({ field, op: "<=", value }),
  in: (field, values) => ({ field, op: "in", values }),
  notIn: (field, values) => ({ field, op: "not_in", values }),
  between: (field, from, to) => ({ field, op: "between", values: [from, to] }),
  contains: (field, value) => ({ field, op: "contains", value }),
  isNull: (field) => ({ field, op: "is_null" }),
  isNotNull: (field) => ({ field, op: "is_not_null" }),
};

/**
 * One chart query, through whichever door you hold:
 *   - vault door:  `{ vault: "kitup", chart, … }`            → kb_chart_query
 *   - UA door:     `{ product: "kitup", chart, … }` (no vault) → neonbi_chart_query
 *     (`product` is the KB slug the call is audited under; it is NOT a filter)
 * Requires a product filter and an explicit date window — a query without either
 * is the wrong number (all products / the dashboard's moving window). Returns the
 * KB's structured answer:
 * `{ rows, columns, key_map, applied_filters, dropped_filters, overridden,
 *    data_age: {known, iso, hours, note}, cached, row_count, undocumented }`.
 */
export async function chartQuery(ctx, { vault, product, chart, dimensions, metrics, filters = [], sort, limit = 500, offset, granularity, productField = "product" }) {
  if (!chart) throw new KbMcpError("chartQuery: `chart` zorunlu", { kind: "tool" });
  if (!filters.some((f) => f.field === productField)) {
    throw new KbMcpError(`chartQuery(${chart}): ürün filtresi yok (${productField}) — sayı birden fazla ürünün toplamı olurdu`, { kind: "tool" });
  }
  if (!filters.some((f) => f.op === "between" || f.op === ">=" || f.op === "in")) {
    throw new KbMcpError(`chartQuery(${chart}): açık tarih penceresi yok — dashboard'un kayan penceresi sessizce uygulanır`, { kind: "tool" });
  }
  const tool = vault ? "kb_chart_query" : "neonbi_chart_query";
  const args = vault ? { vault_slug: vault, chart_id: chart, filters, limit } : { chart_id: chart, filters, limit };
  if (!vault && product) args.product = product;
  if (dimensions !== undefined) args.dimensions = dimensions; // [] = one total row
  if (metrics?.length) args.metrics = metrics;
  if (sort) args.sort = sort;
  if (offset != null) args.offset = offset;
  if (granularity) args.granularity = granularity;

  const { structured } = await callTool(ctx, tool, args);
  if (!structured || !Array.isArray(structured.rows)) {
    throw new KbMcpError(
      `${tool}(${chart}) yapılandırılmış cevap döndürmedi — KB backend'i bu helper sürümünden eski`,
      { kind: "protocol" },
    );
  }
  return structured;
}

/** The row key for a field you ASKED for. NeonBI's keyMap is nested —
 *  `{metrics: {purchase: "sum_purchase"}, dimensions: {…}, note}` — and a raw
 *  column comes back prefixed (`purchase` → `sum_purchase`). */
export function rowKey(result, name) {
  const km = result?.key_map ?? {};
  return km.metrics?.[name] ?? km.dimensions?.[name] ?? name;
}

/** A row's value for the field you ASKED for (see rowKey). Missing stays
 *  `null`, never 0: a missing number is not a zero. */
export function valueOf(result, row, name) {
  const key = rowKey(result, name);
  const v = row?.[key];
  if (v === undefined || v === null) return null;
  if (typeof v === "object" && "value" in v) return v.value; // BigQuery date wrapper
  return v;
}

/** `freshness()` for a Lab script, from a query result: the source table's
 *  last change is the marker, so a sync skips when NeonBI has not moved. */
export function freshnessOf(result, label = "NeonBI") {
  const age = result?.data_age ?? {};
  const pulledAt = new Date().toISOString();
  return {
    marker: age.known ? age.iso : null,
    asOf: age.known ? age.iso : pulledAt,
    note: age.known ? `${label} · veri ${age.hours} sa önce güncellendi` : `${label} · veri yaşı bilinmiyor`,
  };
}

/** Yesterday-inclusive window of `days` full days, ISO dates (UTC). */
export function lastFullDays(days, today = new Date()) {
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1));
  const start = new Date(end.getTime() - (days - 1) * 86_400_000);
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

/** The window the card's date picker resolved, else the last `fallbackDays` full days. */
export function windowFrom(ctx, fallbackDays = 30) {
  const r = ctx?.resolvedTweaks?.range;
  if (r?.fromISO && r?.toISO) return { from: r.fromISO.slice(0, 10), to: r.toISO.slice(0, 10) };
  return lastFullDays(fallbackDays);
}
