/**
 * Parser for a subset of Obsidian's search query syntax, scoped to what makes
 * sense for a graph view (file/path/tag/content + boolean + regex + quotes + negation).
 *
 * Examples:
 *   foo bar                   → both foo AND bar
 *   foo OR bar                → foo OR bar
 *   -foo                      → not foo
 *   "exact phrase"            → substring match
 *   /regex/                   → regex
 *   tag:#architecture         → has tag architecture
 *   path:features             → path contains features
 *   file:web-dashboard        → filename contains web-dashboard
 *   (foo OR bar) -baz         → grouping + negation
 */

import type { GraphNode } from '../hooks/useGraph';

type Token =
  | { type: 'WORD'; value: string }
  | { type: 'PHRASE'; value: string }
  | { type: 'REGEX'; value: string }
  | { type: 'OP'; value: string; arg: string } // tag:, path:, file:, content:
  | { type: 'NOT' }
  | { type: 'OR' }
  | { type: 'LPAREN' }
  | { type: 'RPAREN' };

type Node =
  | { type: 'word'; value: string; negated: boolean }
  | { type: 'phrase'; value: string; negated: boolean }
  | { type: 'regex'; value: RegExp; negated: boolean }
  | { type: 'op'; op: string; arg: string; negated: boolean }
  | { type: 'and'; children: Node[] }
  | { type: 'or'; children: Node[] };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '(') {
      tokens.push({ type: 'LPAREN' });
      i++;
      continue;
    }
    if (c === ')') {
      tokens.push({ type: 'RPAREN' });
      i++;
      continue;
    }
    if (c === '-' && i + 1 < input.length && !/\s/.test(input[i + 1])) {
      tokens.push({ type: 'NOT' });
      i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let buf = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          buf += input[j + 1];
          j += 2;
        } else {
          buf += input[j];
          j++;
        }
      }
      tokens.push({ type: 'PHRASE', value: buf });
      i = j + 1;
      continue;
    }
    if (c === '/') {
      // regex: /pattern/
      let j = i + 1;
      let buf = '';
      while (j < input.length && input[j] !== '/') {
        if (input[j] === '\\' && j + 1 < input.length) {
          buf += input[j] + input[j + 1];
          j += 2;
        } else {
          buf += input[j];
          j++;
        }
      }
      if (j < input.length) {
        tokens.push({ type: 'REGEX', value: buf });
        i = j + 1;
        continue;
      }
      // not a regex — treat as word
    }
    // word or operator
    let j = i;
    while (j < input.length && !/[\s()]/.test(input[j])) {
      if (input[j] === '"') break;
      j++;
    }
    const raw = input.slice(i, j);
    // detect op:arg
    const opMatch = raw.match(/^(tag|path|file|content):(.*)$/i);
    if (opMatch) {
      tokens.push({ type: 'OP', value: opMatch[1].toLowerCase(), arg: opMatch[2] });
    } else if (raw.toUpperCase() === 'OR') {
      tokens.push({ type: 'OR' });
    } else if (raw.toUpperCase() === 'AND') {
      // implicit AND; ignore explicit keyword
    } else if (raw.length > 0) {
      tokens.push({ type: 'WORD', value: raw });
    }
    i = j;
  }
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  parse(): Node {
    const node = this.parseOr();
    return node;
  }

  private parseOr(): Node {
    let left = this.parseAnd();
    while (this.peek()?.type === 'OR') {
      this.pos++;
      const right = this.parseAnd();
      if (left.type === 'or') {
        left.children.push(right);
      } else {
        left = { type: 'or', children: [left, right] };
      }
    }
    return left;
  }

  private parseAnd(): Node {
    const parts: Node[] = [];
    while (this.pos < this.tokens.length && this.peek()?.type !== 'RPAREN' && this.peek()?.type !== 'OR') {
      const n = this.parseTerm();
      if (n) parts.push(n);
    }
    if (parts.length === 0) return { type: 'and', children: [] };
    if (parts.length === 1) return parts[0];
    return { type: 'and', children: parts };
  }

  private parseTerm(): Node | null {
    const t = this.peek();
    if (!t) return null;
    let negated = false;
    if (t.type === 'NOT') {
      negated = true;
      this.pos++;
    }
    const next = this.peek();
    if (!next) return null;
    if (next.type === 'LPAREN') {
      this.pos++;
      const inner = this.parseOr();
      if (this.peek()?.type === 'RPAREN') this.pos++;
      return negated ? negate(inner) : inner;
    }
    if (next.type === 'WORD') {
      this.pos++;
      return { type: 'word', value: next.value.toLowerCase(), negated };
    }
    if (next.type === 'PHRASE') {
      this.pos++;
      return { type: 'phrase', value: next.value.toLowerCase(), negated };
    }
    if (next.type === 'REGEX') {
      this.pos++;
      try {
        return { type: 'regex', value: new RegExp(next.value, 'i'), negated };
      } catch {
        return null;
      }
    }
    if (next.type === 'OP') {
      this.pos++;
      return { type: 'op', op: next.value, arg: next.arg.toLowerCase(), negated };
    }
    this.pos++;
    return null;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
}

function negate(node: Node): Node {
  if (node.type === 'and' || node.type === 'or') {
    return { ...node, children: node.children.map(negate) };
  }
  return { ...node, negated: !node.negated };
}

export interface ParsedQuery {
  /** Returns true if the node matches. Empty query always returns true. */
  match: (node: GraphNode) => boolean;
  /** Raw query string, useful for group-query identity / dedup. */
  raw: string;
  /** Whether the query is empty / matches all. */
  isEmpty: boolean;
}

export function parseQuery(raw: string): ParsedQuery {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { match: () => true, raw: '', isEmpty: true };
  }
  const tokens = tokenize(trimmed);
  const ast = new Parser(tokens).parse();
  return { match: (n) => evalNode(ast, n), raw: trimmed, isEmpty: false };
}

function evalNode(node: Node, n: GraphNode): boolean {
  switch (node.type) {
    case 'and':
      return node.children.every((c) => evalNode(c, n));
    case 'or':
      return node.children.some((c) => evalNode(c, n));
    case 'word':
      return applyNeg(matchText(n, node.value), node.negated);
    case 'phrase':
      return applyNeg(matchText(n, node.value), node.negated);
    case 'regex':
      return applyNeg(matchRegex(n, node.value), node.negated);
    case 'op':
      return applyNeg(matchOp(n, node.op, node.arg), node.negated);
  }
}

function applyNeg(result: boolean, negated: boolean): boolean {
  return negated ? !result : result;
}

function nodeSearchable(n: GraphNode): string {
  const parts = [n.label, n.path, n.id, n.meta.description ?? '', ...(n.meta.tags ?? [])];
  return parts.join(' ').toLowerCase();
}

function matchText(n: GraphNode, q: string): boolean {
  return nodeSearchable(n).includes(q);
}

function matchRegex(n: GraphNode, re: RegExp): boolean {
  return re.test(nodeSearchable(n));
}

function matchOp(n: GraphNode, op: string, arg: string): boolean {
  const argLower = arg.toLowerCase();
  switch (op) {
    case 'path':
      return n.path.toLowerCase().includes(argLower);
    case 'file': {
      const base = n.path.split('/').pop()?.toLowerCase() ?? n.label.toLowerCase();
      return base.includes(argLower);
    }
    case 'tag': {
      const bareTag = argLower.replace(/^#/, '');
      return (n.meta.tags ?? []).some((t) => t.toLowerCase() === bareTag)
        || (n.group === 'tag' && n.label.toLowerCase().replace(/^#/, '') === bareTag);
    }
    case 'content':
      return (n.meta.description ?? '').toLowerCase().includes(argLower);
    default:
      return false;
  }
}
