/**
 * The share gate (paylasilan-app-ler plan r2 K1, r3): a mechanical check of the exact tree a
 * publish would send, or an install would check out. Pure: no git, no network, no disk.
 *
 *  - ALLOW list: what a published app is made of. Anything else is listed as "not sent" and does
 *    not stop a publish; at install it is refused (a published app holds nothing else).
 *  - NEVER list: app data, keys, other tools' instruction files, dotfiles, links. Refused.
 *  - HARD identity (never passable): keys and tokens, `.env` values, setting values, e-mails,
 *    phone numbers, people's names, home paths, account ids.
 *  - APPROVABLE identity: the owner's own generic words (vault, project, insight, objective, AI
 *    Team, MCP and linked repo names, long numbers). Each match is one line the owner approves.
 *
 * The report names the rule, the file and the line. It never writes a hard value.
 */

import { createHash } from 'node:crypto';
import { scrubContent } from '../../git-sync/scrub.js';
import { INSTRUCTION_NAMES } from '../data-dir.js';

export type GateMode = 'normal' | 'strict' | 'install';

export interface GateFile {
  path: string;
  /** git mode: 100644 / 100755 file, 120000 symlink, 160000 submodule. */
  mode: string;
  data: Buffer;
  /** Hard links of the source file (publish only). */
  nlink?: number;
}

export interface GateTerm {
  /** What the term is, shown in the report (never the value of a hard term). */
  label: string;
  value: string;
}

export interface GateTerms {
  hard: GateTerm[];
  approvable: GateTerm[];
}

export interface GateFinding {
  id: string;
  rule: string;
  file: string;
  line?: number;
  label: string;
  /** Approvable findings only: the generic word, so the owner can judge it. */
  term?: string;
}

export interface GateReport {
  ok: boolean;
  mode: GateMode;
  send: Array<{ path: string; size: number }>;
  notSent: Array<{ path: string; why: string }>;
  blocks: GateFinding[];
  approvable: GateFinding[];
  /** Approvable finding ids the owner has not approved yet. */
  unapproved: string[];
  totalBytes: number;
}

export interface GateOptions {
  mode: GateMode;
  terms?: GateTerms;
  approvals?: ReadonlySet<string>;
  /** The manifest's `share.include` (publish) and its icon. */
  include?: readonly string[];
  icon?: string | null;
  /** The SDK text: a `lib/dc.mjs` byte-identical to it is the product's, not the publisher's. */
  sdk?: string;
  /** Files the publish itself wrote (LICENSE, README): no identity scan (they name the account). */
  generated?: ReadonlySet<string>;
}

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

const ROOT_FILES = new Set(['dreamcontext-app.json', 'ASSISTANT.md', 'README.md', 'CHANGES.md', 'LICENSE', 'package.json', 'package-lock.json', 'server.mjs', 'server.js', 'server.cjs', 'server.ts']);
const DIRS = ['public', 'src', 'lib'];
const EXTS = new Set(['.html', '.css', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.json', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.woff2', '.md', '.txt']);
const BINARY = new Set(['.png', '.jpg', '.jpeg', '.webp', '.woff2']);

const ext = (p: string): string => { const i = p.lastIndexOf('.'); const s = p.lastIndexOf('/'); return i > s ? p.slice(i).toLowerCase() : ''; };

/** Is the path on the allow-list? */
export function allowedPath(path: string, include: readonly string[] = [], icon: string | null = null): boolean {
  if (ROOT_FILES.has(path) || (icon && path === icon)) return true;
  const inDir = path.includes('/') && DIRS.includes(path.split('/')[0]);
  const included = include.some((inc) => path === inc || path.startsWith(inc + '/'));
  return (inDir || included) && EXTS.has(ext(path));
}

/** Why a path is on the never list, or null. */
export function neverReason(path: string, mode: GateMode): string | null {
  if (!path || path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.split('/').some((s) => s === '..' || s === '')) return 'outside the app folder';
  const segs = path.split('/');
  const lower = segs.map((s) => s.toLowerCase());
  if (lower.some((s) => s.startsWith('.env'))) return 'a .env file (keys never travel)';
  if (lower[0] === 'data') return 'the app data folder (data never travels)';
  if (lower.includes('node_modules')) return 'node_modules';
  if (lower.includes('.git')) return 'git internals';
  for (const n of INSTRUCTION_NAMES) {
    if (n.endsWith('/') ? lower.includes(n.slice(0, -1)) : lower[lower.length - 1] === n) return "another tool's instruction file";
  }
  if (path === '.gitignore') return null;
  if (segs.some((s) => s.startsWith('.'))) return mode === 'install' ? 'a dotfile' : 'a dotfile (it may hold settings or keys)';
  return null;
}

// ─── Content rules ───────────────────────────────────────────────────────────────────

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const EMAIL_OK = /@(?:users\.noreply\.github\.com|example\.(?:com|org|net))$/i;
const PHONE_RES = [
  /(?<![\w.+])\+\d{1,3}[\s-]?\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}(?!\d)/,
  /(?<![\w.])0\d{3}[\s-]\d{3}[\s-]\d{2}[\s-]\d{2}(?!\d)/,
  /(?<![\w.])\+\d{11,14}(?!\d)/,
];
const ACCOUNT_RE = /\b(?:act_\d{6,}|acct_[A-Za-z0-9]{8,})\b/;
const LONG_NUMBER_RE = /(?<![\w.#-])\d{10,}(?![\w.])/;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function termRe(value: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(value)}(?![\\p{L}\\p{N}_])`, 'iu');
}

const PRODUCT_WORDS = new Set(['dreamcontext', 'dream', 'context', 'app', 'apps', 'main', 'default', 'test', 'data', 'config']);

export function findingId(rule: string, file: string, line: number | undefined, term = ''): string {
  return createHash('sha256').update(`${rule}\0${file}\0${line ?? 0}\0${term.toLowerCase()}`).digest('hex').slice(0, 12);
}

/** Image metadata that can carry a name, a place or a path: refused (security Minor). */
export function imageMetadata(path: string, data: Buffer): string | null {
  const e = ext(path);
  if (e === '.png') {
    let i = 8;
    while (i + 8 <= data.length) {
      const len = data.readUInt32BE(i);
      const type = data.subarray(i + 4, i + 8).toString('latin1');
      if (['tEXt', 'iTXt', 'zTXt', 'eXIf', 'iCCP'].includes(type)) return `PNG ${type} chunk`;
      if (type === 'IEND') break;
      i += 12 + len;
    }
    return null;
  }
  if (e === '.jpg' || e === '.jpeg') {
    let i = 2;
    while (i + 4 <= data.length && data[i] === 0xff) {
      const marker = data[i + 1];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0xfe) return 'JPEG comment';
      if (marker === 0xe1) return 'JPEG EXIF/XMP';
      if (marker === 0xed) return 'JPEG IPTC';
      i += 2 + data.readUInt16BE(i + 2);
    }
    return null;
  }
  if (e === '.webp') {
    const s = data.toString('latin1');
    if (s.includes('EXIF') || s.includes('XMP ')) return 'WebP EXIF/XMP';
    return null;
  }
  if (e === '.svg') {
    const s = data.toString('utf-8');
    if (/<metadata[\s>]/i.test(s) || /sodipodi:docname/i.test(s)) return 'SVG metadata';
  }
  return null;
}

/** Scan one text file's lines: secrets, hard identity, approvable words. */
function scanText(file: string, text: string, terms: GateTerms, out: { blocks: GateFinding[]; approvable: GateFinding[] }): void {
  // Secrets and home paths: every scrub rule blocks in a publish (warn included).
  for (const h of scrubContent(file, text)) {
    out.blocks.push({ id: findingId(h.rule, file, h.line), rule: h.rule, file, line: h.line, label: h.rule === 'home-path' || h.rule === 'windows-home-path' ? 'a home folder path' : 'a key or token' });
  }
  const hard = terms.hard.filter((t) => t.value.trim().length >= 3).map((t) => ({ ...t, re: termRe(t.value.trim()) }));
  const soft = terms.approvable
    .filter((t) => t.value.trim().length >= 4 && !PRODUCT_WORDS.has(t.value.trim().toLowerCase()))
    .map((t) => ({ ...t, re: termRe(t.value.trim()) }));
  const lines = text.split('\n');
  lines.forEach((ln, idx) => {
    const line = idx + 1;
    for (const m of ln.matchAll(EMAIL_RE)) {
      if (!EMAIL_OK.test(m[0])) { out.blocks.push({ id: findingId('email', file, line), rule: 'email', file, line, label: 'an e-mail address' }); break; }
    }
    if (PHONE_RES.some((re) => re.test(ln))) out.blocks.push({ id: findingId('phone', file, line), rule: 'phone', file, line, label: 'a phone number' });
    if (ACCOUNT_RE.test(ln)) out.blocks.push({ id: findingId('account-id', file, line), rule: 'account-id', file, line, label: 'an account id' });
    for (const t of hard) if (t.re.test(ln)) out.blocks.push({ id: findingId('identity', file, line, t.label), rule: 'identity', file, line, label: t.label });
    for (const t of soft) {
      if (t.re.test(ln)) {
        const term = t.value.trim();
        out.approvable.push({ id: findingId('generic-word', file, line, term), rule: 'generic-word', file, line, label: t.label, term });
      }
    }
    const n = LONG_NUMBER_RE.exec(ln);
    if (n) out.approvable.push({ id: findingId('long-number', file, line, n[0]), rule: 'long-number', file, line, label: 'a long number (an account or customer id?)', term: n[0] });
  });
}

export function runGate(files: readonly GateFile[], opts: GateOptions): GateReport {
  const mode = opts.mode;
  const terms = opts.terms ?? { hard: [], approvable: [] };
  const include = opts.include ?? [];
  const send: GateReport['send'] = [];
  const notSent: GateReport['notSent'] = [];
  const out = { blocks: [] as GateFinding[], approvable: [] as GateFinding[] };
  const block = (rule: string, file: string, label: string, line?: number) => out.blocks.push({ id: findingId(rule, file, line), rule, file, ...(line ? { line } : {}), label });
  let total = 0;

  for (const f of files) {
    const never = neverReason(f.path, mode);
    if (f.path === '.gitignore') {
      // The gate writes its own; the publisher's never travels. At install it is harmless text.
      if (mode !== 'install') notSent.push({ path: f.path, why: 'replaced by the publish .gitignore' });
      else send.push({ path: f.path, size: f.data.length });
      continue;
    }
    if (never) { block('never', f.path, never); continue; }
    if (f.mode === '120000') { block('symlink', f.path, 'a symbolic link'); continue; }
    if (f.mode === '160000') { block('submodule', f.path, 'a git submodule'); continue; }
    if (f.mode !== '100644' && f.mode !== '100755') { block('not-a-file', f.path, 'not a plain file'); continue; }
    if ((f.nlink ?? 1) > 1) { block('hardlink', f.path, 'a hard link (its other name may hold anything)'); continue; }
    if (!allowedPath(f.path, include, opts.icon ?? null)) {
      if (mode === 'install') block('not-allowed', f.path, 'not something a published app holds');
      else notSent.push({ path: f.path, why: 'not on the share list' });
      continue;
    }
    if (f.data.length > MAX_FILE_BYTES) { block('too-big', f.path, 'larger than 2 MB'); continue; }
    total += f.data.length;
    send.push({ path: f.path, size: f.data.length });
    if (mode === 'install') continue;
    const meta = BINARY.has(ext(f.path)) || ext(f.path) === '.svg' ? imageMetadata(f.path, f.data) : null;
    if (meta) block('image-metadata', f.path, `${meta} (it can carry a name or a path; save the image without metadata)`);
    if (BINARY.has(ext(f.path))) continue;
    if (f.path === 'lib/dc.mjs' && opts.sdk !== undefined && f.data.toString('utf-8') === opts.sdk) continue;
    if (opts.generated?.has(f.path)) continue;
    scanText(f.path, f.data.toString('utf-8'), terms, out);
  }
  if (total > MAX_TOTAL_BYTES) block('too-big-total', '(all)', 'more than 20 MB in total');
  if (!files.some((f) => f.path === 'dreamcontext-app.json')) block('no-manifest', 'dreamcontext-app.json', 'no app manifest');
  if (mode === 'strict') {
    if (!files.some((f) => f.path === 'LICENSE')) block('no-license', 'LICENSE', 'a public app needs a LICENSE');
    if (!files.some((f) => f.path === 'README.md')) block('no-readme', 'README.md', 'a public app needs a README.md');
  }

  // One finding per id (a term twice on a line is one line to approve).
  const dedupe = (xs: GateFinding[]) => [...new Map(xs.map((x) => [x.id, x])).values()];
  const blocks = dedupe(out.blocks);
  const approvable = dedupe(out.approvable);
  const approvals = opts.approvals ?? new Set<string>();
  const unapproved = approvable.filter((a) => !approvals.has(a.id)).map((a) => a.id);
  return { ok: blocks.length === 0 && unapproved.length === 0, mode, send, notSent, blocks, approvable, unapproved, totalBytes: total };
}

/** The publish line's digest: path + content of every file sent, sorted. */
export function treeDigest(files: ReadonlyArray<{ path: string; data: Buffer }>): string {
  const h = createHash('sha256');
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    h.update(f.path).update('\0').update(createHash('sha256').update(f.data).digest('hex')).update('\n');
  }
  return h.digest('hex');
}

export const PUBLISH_TRAILER = 'Dreamcontext-Publish';
