import { existsSync, statSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname, basename, extname, isAbsolute, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { featuresDir } from './features-path.js';

/**
 * Initializer auto-detection.
 *
 * The dreamcontext hooks (SessionStart / UserPromptSubmit) call into this module
 * to recognise — deterministically — the conditions that should proactively offer
 * the `initializer` skill, instead of relying on the agent noticing. The four
 * conditions, and where each is surfaced:
 *
 *  - `no-brain`            (SessionStart): no `_dream_context/` at all, but cwd is
 *                          a real project worth bootstrapping.
 *  - `sparse-brain`        (SessionStart): a `_dream_context/` exists but is the
 *                          empty init shell — empty knowledge/, zero features, and
 *                          core files still template stubs.
 *  - `migrate-from-folder` (UserPromptSubmit): the prompt points at an EXISTING
 *                          brain (`_dream_context/`) or notes/Obsidian/Notion
 *                          corpus elsewhere, with migration/ingest intent.
 *  - `mass-new-source`     (UserPromptSubmit): an already-initialized (healthy)
 *                          brain, and the prompt points at a sizable NEW external
 *                          source folder (docs / export / wiki dump) to ingest.
 *
 * Everything here is PURE and TOTAL: every function is wrapped so it returns a
 * safe value rather than throwing — the hooks add their own try/catch on top, so
 * a detection bug can never break sleep-debt, recall, or any existing behaviour.
 * The offer text the hooks emit reuses the `initializer` skill; this module never
 * duplicates the orchestration — it only recognises the condition and frames the
 * offer.
 */

export type BrainState = 'missing' | 'sparse' | 'healthy';

export type InitTriggerCondition =
  | 'no-brain'
  | 'sparse-brain'
  | 'migrate-from-folder'
  | 'mass-new-source';

export interface InitTrigger {
  condition: InitTriggerCondition;
  /** Absolute path of the source folder (migrate/mass only). */
  path?: string;
  /** Count of doc files discovered in the source (mass only). */
  docCount?: number;
}

// ─── Brain classification ─────────────────────────────────────────────────────

// Sentinel substrings that ship in the freshly-`init`ed core templates
// (src/templates/init/*.md) and get replaced once the brain is genuinely
// initialized. Their continued presence is the "untouched template stub" signal.
const TEMPLATE_PLACEHOLDERS = [
  "(Add your project's guiding principles",
  '(Add known constraints',
  '(Project-specific behaviors',
  '(Things that must never happen',
  '(Decision-making patterns',
  '(How the user prefers to interact',
  '(Key project facts',
  '(Naming conventions, branching strategy',
  '(Key technical choices and their rationale',
  '(Open issues and their status',
];

// An unreplaced `{{TOKEN}}` means init never ran to completion — definitely a stub.
const UNREPLACED_TOKEN_RE = /\{\{[A-Z_]+\}\}/;

// Top-level knowledge subfolders that `init` seeds with stubs (or that hold
// non-authored material) — they don't count as "real" knowledge for sparseness.
const KNOWLEDGE_STUB_DIRS = new Set([
  'data-structures', 'products', 'diagrams', '.archive', '.trash', '.cache', '.obsidian',
]);

/**
 * True when the always-loaded core files (soul/user/memory) are still the
 * untouched init template — i.e. ≥2 of the present files still carry template
 * placeholder prose, or any carries an unreplaced `{{TOKEN}}`. Conservative on
 * purpose: a single edited file is enough to NOT classify as untouched.
 */
export function isUntouchedTemplateCore(root: string): boolean {
  try {
    const files = ['0.soul.md', '1.user.md', '2.memory.md'];
    let present = 0;
    let templateCount = 0;
    for (const f of files) {
      const p = join(root, 'core', f);
      if (!existsSync(p)) continue;
      let content: string;
      try {
        content = readFileSync(p, 'utf-8');
      } catch {
        continue;
      }
      present++;
      if (UNREPLACED_TOKEN_RE.test(content)) return true;
      if (TEMPLATE_PLACEHOLDERS.some((s) => content.includes(s))) templateCount++;
    }
    if (present === 0) return false;
    return templateCount >= 2;
  } catch {
    return false;
  }
}

/**
 * True when `knowledge/` holds no authored knowledge file — only the init stubs
 * (data-structures/products/diagrams) and hidden housekeeping dirs count as empty.
 */
export function knowledgeIsEmpty(root: string): boolean {
  try {
    const kdir = join(root, 'knowledge');
    if (!existsSync(kdir)) return true;
    const stack: Array<{ dir: string; top: boolean }> = [{ dir: kdir, top: true }];
    while (stack.length) {
      const { dir, top } = stack.pop()!;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        if (e.isDirectory()) {
          if (top && KNOWLEDGE_STUB_DIRS.has(e.name)) continue;
          stack.push({ dir: join(dir, e.name), top: false });
        } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
          return false; // a real, authored knowledge file
        }
      }
    }
    return true;
  } catch {
    return true;
  }
}

/**
 * True when `knowledge/features/` holds no feature `.md` file — recursing into
 * topical/product subfolders, so a brain whose only features live under
 * `features/<product>/` still reads as non-zero.
 */
export function featuresAreZero(root: string): boolean {
  try {
    const fdir = featuresDir(root);
    if (!existsSync(fdir)) return true;
    return !hasMarkdownFile(fdir);
  } catch {
    return true;
  }
}

/** Recursively: does `dir` (or any descendant) contain a non-dotfile `.md`? */
function hasMarkdownFile(dir: string): boolean {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.isFile() && e.name.toLowerCase().endsWith('.md')) return true;
    if (e.isDirectory() && hasMarkdownFile(join(dir, e.name))) return true;
  }
  return false;
}

/**
 * Classify the brain at `root` (the `_dream_context/` path, or null when absent).
 * `sparse` requires ALL THREE stub signals (zero features AND empty knowledge AND
 * untouched template core) so a brain that has been started in any meaningful way
 * reads as `healthy` — the no-false-positive discipline.
 */
export function classifyBrain(root: string | null): BrainState {
  if (!root) return 'missing';
  try {
    if (featuresAreZero(root) && knowledgeIsEmpty(root) && isUntouchedTemplateCore(root)) {
      return 'sparse';
    }
  } catch {
    // any failure → treat as healthy (never nag on uncertainty)
  }
  return 'healthy';
}

// ─── Project signal (no-brain gate) ───────────────────────────────────────────

const PROJECT_MARKERS = [
  '.git', 'package.json', 'tsconfig.json', 'deno.json', 'pyproject.toml', 'setup.py',
  'requirements.txt', 'Pipfile', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle',
  'build.gradle.kts', 'Gemfile', 'composer.json', 'Package.swift', 'CMakeLists.txt',
  'Makefile', 'README.md', 'README.rst', 'README.txt', 'README',
];

const PROJECT_DIRS = ['src', 'lib', 'app', 'docs', 'doc', 'notes', 'wiki'];

/**
 * True when `cwd` looks like a real project worth bootstrapping — used to gate the
 * `no-brain` offer so a throwaway/empty directory stays silent.
 */
export function hasProjectSignal(cwd: string): boolean {
  try {
    for (const m of PROJECT_MARKERS) {
      if (existsSync(join(cwd, m))) return true;
    }
    for (const d of PROJECT_DIRS) {
      try {
        if (statSync(join(cwd, d)).isDirectory()) return true;
      } catch {
        // not present — keep scanning
      }
    }
    return false;
  } catch {
    return false;
  }
}

// ─── Prompt intent + path extraction ──────────────────────────────────────────

const MIGRATE_RE =
  /\b(migrat\w*|moving (over|my|the|this)|move (over|my|the|this|everything|it)|bring(?:ing)? (?:it|this|my|the|everything) ?(?:over|across|into)|port(?:ing)? (?:over|my|the|this)|switch(?:ing)? (?:from|over)|coming from|from my (?:old|other|previous|existing)|my (?:old|previous|existing) (?:project|brain|notes|vault|setup)|transfer\w*)\b/i;

const INGEST_RE =
  /\b(ingest\w*|onboard\w*|absorb\w*|digest\w*|import\w*|load\w*|index (?:these|the|my|this|all)|pull in|bring in|feed (?:in|me|it|this|these)|read (?:in )?(?:all|these|the) (?:docs|notes|files)|set up (?:dreamcontext|the brain|context) from|bootstrap\w* (?:from|the))\b/i;

/** Doc extensions that count toward a "mass" external source. */
const DOC_EXTENSIONS = new Set(['.md', '.markdown', '.mdx', '.txt', '.rst', '.adoc', '.org']);

/** Bare words that name a likely source folder (resolved against cwd if present). */
const KNOWN_SOURCE_WORDS = new Set([
  'docs', 'doc', 'notes', 'note', 'wiki', 'export', 'exports', 'dump',
  'vault', 'obsidian', 'notion', 'adrs', 'knowledge', 'kb',
]);

/** Folder basename pattern that reads as a notes/knowledge corpus. */
const NOTES_DIR_RE =
  /(?:^|[-_ ])(notes?|obsidian|notion|wiki|vault|zettel|second.?brain|knowledge.?base|kb)(?:[-_ ]|$)/i;

/** Minimum doc count for a generic folder to qualify as a "mass" new source. */
export const MASS_SOURCE_MIN_DOCS = 5;

const WALK_MAX_ENTRIES = 4000;
const WALK_MAX_DEPTH = 4;
const WALK_SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', 'dist', 'build', '.next', 'target']);

export function detectMigrateIntent(prompt: string): boolean {
  try {
    return typeof prompt === 'string' && MIGRATE_RE.test(prompt);
  } catch {
    return false;
  }
}

export function detectIngestIntent(prompt: string): boolean {
  try {
    return typeof prompt === 'string' && INGEST_RE.test(prompt);
  } catch {
    return false;
  }
}

function stripWrappers(s: string): string {
  return s.replace(/^[("'`<[{]+/, '').replace(/[.,;:!?)\]}>"'`]+$/, '');
}

function looksLikePath(s: string): boolean {
  if (!s || s.length > 400) return false;
  if (s.startsWith('~')) return true;
  if (s.startsWith('/') || s.startsWith('./') || s.startsWith('../')) return true;
  return s.includes('/');
}

/**
 * Pull path-like candidates from a prompt: quoted segments, whitespace tokens that
 * contain a slash or start with `~`/`.`, and bare well-known source words (`docs`,
 * `notes`, …). Returns raw strings — resolution/existence is checked separately.
 */
export function extractCandidatePaths(prompt: string): string[] {
  const out = new Set<string>();
  try {
    if (typeof prompt !== 'string') return [];
    for (const m of prompt.matchAll(/["'`]([^"'`\n]{1,400})["'`]/g)) {
      const s = stripWrappers(m[1].trim());
      if (looksLikePath(s)) out.add(s);
    }
    for (const raw of prompt.split(/\s+/)) {
      const s = stripWrappers(raw.trim());
      if (looksLikePath(s)) out.add(s);
    }
    for (const word of prompt.toLowerCase().split(/[^a-z0-9_./~-]+/)) {
      if (KNOWN_SOURCE_WORDS.has(word)) out.add(word);
    }
  } catch {
    return [...out];
  }
  return [...out];
}

/** Resolve a user-supplied path token (handles `~`, relative, absolute). */
function resolveUserPath(token: string, cwd: string): string | null {
  try {
    let t = token.trim();
    if (!t) return null;
    if (t === '~') t = homedir();
    else if (t.startsWith('~/')) t = join(homedir(), t.slice(2));
    if (!isAbsolute(t)) t = join(cwd, t);
    return resolve(t);
  } catch {
    return null;
  }
}

/** Bounded directory scan: doc count + whether it embeds a brain/Obsidian vault. */
function inspectDir(dir: string): { docCount: number; hasBrain: boolean; hasObsidian: boolean } {
  let docCount = 0;
  let hasBrain = false;
  let hasObsidian = false;
  let visited = 0;
  const stack: Array<{ p: string; depth: number }> = [{ p: dir, depth: 0 }];
  while (stack.length) {
    const { p, depth } = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(p, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (visited++ > WALK_MAX_ENTRIES) return { docCount, hasBrain, hasObsidian };
      if (e.isDirectory()) {
        if (e.name === '_dream_context') hasBrain = true;
        if (e.name === '.obsidian') hasObsidian = true;
        if (WALK_SKIP_DIRS.has(e.name)) continue;
        if (depth < WALK_MAX_DEPTH) stack.push({ p: join(p, e.name), depth: depth + 1 });
      } else if (e.isFile() && DOC_EXTENSIONS.has(extname(e.name).toLowerCase())) {
        docCount++;
      }
    }
  }
  return { docCount, hasBrain, hasObsidian };
}

function isBrainOrNotesSource(
  absPath: string,
  inspected: { hasBrain: boolean; hasObsidian: boolean },
): boolean {
  const base = basename(absPath);
  return (
    inspected.hasBrain ||
    inspected.hasObsidian ||
    base === '_dream_context' ||
    NOTES_DIR_RE.test(base)
  );
}

/** True when `absPath` is the current project / brain (never an external source). */
function isOwnProject(absPath: string, contextRoot: string | null, cwd: string): boolean {
  try {
    const norm = resolve(absPath);
    if (norm === resolve(cwd)) return true;
    if (contextRoot) {
      const cr = resolve(contextRoot);
      const projectRoot = dirname(cr);
      if (norm === cr || norm === projectRoot) return true;
      if (norm.startsWith(cr + sep)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ─── Trigger detection ────────────────────────────────────────────────────────

/**
 * SessionStart detection: `no-brain` (missing brain + real project) or
 * `sparse-brain`. Returns null otherwise (the healthy steady state).
 */
export function detectSessionStartTrigger(cwd: string, root: string | null): InitTrigger | null {
  try {
    const state = classifyBrain(root);
    if (state === 'missing') {
      return hasProjectSignal(cwd) ? { condition: 'no-brain' } : null;
    }
    if (state === 'sparse') {
      return { condition: 'sparse-brain' };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * UserPromptSubmit detection: `migrate-from-folder` (prompt points at an existing
 * brain/notes corpus) or `mass-new-source` (healthy brain + prompt points at a
 * sizable new docs/export folder). Requires BOTH an intent keyword AND an existing
 * on-disk source directory — the conjunction is what keeps it silent on normal
 * prompts. `root` is the current `_dream_context/` (always present when this hook
 * runs; the missing case is handled at SessionStart).
 */
export function detectPromptTrigger(
  prompt: string,
  opts: { cwd: string; root: string | null },
): InitTrigger | null {
  try {
    if (typeof prompt !== 'string' || prompt.trim().length < 8) return null;
    const migrate = detectMigrateIntent(prompt);
    const ingest = detectIngestIntent(prompt);
    if (!migrate && !ingest) return null; // no intent → never fire

    const { cwd, root } = opts;
    const candidates = extractCandidatePaths(prompt);
    if (candidates.length === 0) return null;

    interface Dir {
      path: string;
      docCount: number;
      brainOrNotes: boolean;
    }
    const dirs: Dir[] = [];
    for (const c of candidates) {
      const abs = resolveUserPath(c, cwd);
      if (!abs) continue;
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      if (isOwnProject(abs, root, cwd)) continue;
      const ins = inspectDir(abs);
      dirs.push({ path: abs, docCount: ins.docCount, brainOrNotes: isBrainOrNotesSource(abs, ins) });
    }
    if (dirs.length === 0) return null;

    // migrate takes priority: an existing brain / notes corpus is the strongest signal.
    const m = dirs.find((d) => d.brainOrNotes);
    if (m) return { condition: 'migrate-from-folder', path: m.path };

    // mass-new-source: only into an already-initialized (healthy) brain.
    if (ingest && classifyBrain(root) === 'healthy') {
      const mass = dirs.find((d) => !d.brainOrNotes && d.docCount >= MASS_SOURCE_MIN_DOCS);
      if (mass) {
        return { condition: 'mass-new-source', path: mass.path, docCount: mass.docCount };
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Offer rendering ──────────────────────────────────────────────────────────

const SILENCE_HINT = '(Set DREAMCONTEXT_INITIALIZER_HOOK=0 to silence.)';

/**
 * Render the agent-facing offer for a trigger. Hook stdout becomes agent context,
 * so this is a DIRECTIVE: it tells the agent to offer the user the `initializer`
 * skill and run it on consent — it does not re-implement the orchestration.
 */
export function renderOffer(trigger: InitTrigger): string {
  switch (trigger.condition) {
    case 'no-brain':
      return [
        '🧠 dreamcontext: no brain here yet — `_dream_context/` is missing, but this looks like a real project.',
        'Before doing project work, OFFER to bootstrap it: tell the user you can initialize dreamcontext from',
        'whatever they already have — a docs folder, an Obsidian/Notion export, ADRs, notes — or just from the',
        'codebase, and on their consent INVOKE the `initializer` skill (the interactive, sub-agent-driven',
        "bootstrap). Don't hand-roll context files — the initializer owns scaffold → scout → ingest → verify.",
        SILENCE_HINT,
        '',
      ].join('\n');
    case 'sparse-brain':
      return [
        '🧠 dreamcontext: this brain looks sparse/unstarted — empty knowledge/, zero features, and the core',
        'files are still template stubs. OFFER to finish initializing it: ask the user to point you at their',
        'material (docs / export / wiki / notes) or to bootstrap from the codebase, then INVOKE the',
        '`initializer` skill on consent — it ingests the material into the proper knowledge / feature / task',
        'hierarchy. Want me to ingest it into the brain?',
        SILENCE_HINT,
        '',
      ].join('\n');
    case 'migrate-from-folder':
      return [
        `🧠 dreamcontext: I see an existing brain / notes folder at \`${trigger.path ?? '?'}\`. If you want to`,
        "MIGRATE it into this project's brain, say the word — I can INVOKE the `initializer` skill to ingest it",
        '(an existing _dream_context/ or an Obsidian/Notion/notes corpus) into the proper hierarchy here,',
        'distilling rather than dumping. Want me to ingest it into the brain?',
        SILENCE_HINT,
        '',
      ].join('\n');
    case 'mass-new-source':
      return [
        `🧠 dreamcontext: that looks like a sizable external source — \`${trigger.path ?? '?'}\`` +
          `${typeof trigger.docCount === 'number' ? ` (~${trigger.docCount} docs)` : ''}.`,
        'Want me to ingest it into the brain? I can INVOKE the `initializer` skill to distill it into',
        'knowledge / features / tasks (loading a docs / export / wiki dump into this already-initialized',
        'project — distill, not dump).',
        SILENCE_HINT,
        '',
      ].join('\n');
    default:
      return '';
  }
}
