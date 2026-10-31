/**
 * What a model costs on the Stats screen: the owner's own price first, then dreamcontext's list
 * (model-facts.ts), else nothing. A model with no known price stays "Unpriced": its tokens count
 * and its cost does not, because a guessed price is a made-up number on a money screen.
 *
 * `~/.dreamcontext/usage-prices.json`: `{ prices: { model: [in, out, cacheRead, cacheWrite] },
 * alias: { model: model } }`, USD per million tokens. T3's "Set price" and "Count as".
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { priceForModelId } from './model-facts.js';

export type Price = [input: number, output: number, cacheRead: number, cacheWrite: number];

export interface PriceBook { prices: Record<string, Price>; alias: Record<string, string> }

export function pricesPath(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'usage-prices.json');
}

const isPrice = (v: unknown): v is Price =>
  Array.isArray(v) && v.length === 4 && v.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0);

export function readPrices(home: string = homedir()): PriceBook {
  try {
    const raw = JSON.parse(readFileSync(pricesPath(home), 'utf-8')) as Partial<PriceBook>;
    const prices: Record<string, Price> = {};
    for (const [m, p] of Object.entries(raw.prices ?? {})) if (isPrice(p)) prices[m] = p;
    const alias: Record<string, string> = {};
    for (const [m, a] of Object.entries(raw.alias ?? {})) if (typeof a === 'string' && a) alias[m] = a;
    return { prices, alias };
  } catch {
    return { prices: {}, alias: {} };
  }
}

export function writePrices(book: PriceBook, home: string = homedir()): void {
  const file = pricesPath(home);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(book, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
}

/** One model's change. A null price clears it, a null alias clears "Count as". */
export function setPrice(model: string, change: { price?: unknown; alias?: unknown }, home: string = homedir()): PriceBook {
  const book = readPrices(home);
  if (change.price === null) delete book.prices[model];
  else if (isPrice(change.price)) book.prices[model] = change.price;
  if (change.alias === null || change.alias === '') delete book.alias[model];
  else if (typeof change.alias === 'string') book.alias[model] = change.alias;
  writePrices(book, home);
  return book;
}

const CLAUDE_MODEL = /claude|opus|sonnet|haiku|fable|mythos/i;

function listPrice(model: string): Price | null {
  if (!CLAUDE_MODEL.test(model)) return null;
  const p = priceForModelId(model);
  return [p.in, p.out, p.cacheRead, p.cacheWrite];
}

export type PriceSource = 'yours' | 'list' | 'none';

/** Follows "Count as" (a loop stops where it closes), then the owner's price, then the list. */
export function resolvePrice(model: string, book: PriceBook): { price: Price | null; source: PriceSource } {
  const own = book.prices[model];
  if (own) return { price: own, source: 'yours' };
  let target = model;
  const seen = new Set([model]);
  while (book.alias[target] && !seen.has(book.alias[target])) {
    target = book.alias[target];
    seen.add(target);
    if (book.prices[target]) return { price: book.prices[target], source: 'yours' };
  }
  const list = listPrice(target);
  return list ? { price: list, source: target === model ? 'list' : 'yours' } : { price: null, source: 'none' };
}

/** Input, cache read, cache write, output, in USD. */
export function costParts(price: Price, t: { input: number; cacheRead: number; cacheWrite: number; output: number }): [number, number, number, number] {
  return [t.input * price[0] / 1e6, t.cacheRead * price[2] / 1e6, t.cacheWrite * price[3] / 1e6, t.output * price[1] / 1e6];
}
