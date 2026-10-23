import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import matter from 'gray-matter';

/**
 * task-filing-rules — what sleep learned from the owner's objections, as ONE pattern file.
 *
 * The owner objects to a task an agent opened ("this was a criterion of X", "not a task"); the
 * objection is recorded (task-objection.ts) and the next sleep distils objections into a rule
 * here: "Don't … / Do …". Every sleep reads the rules before it files anything (`sleep start`
 * prints them), and the objected task shows "Sleep learned: R2" once a rule rests on it.
 *
 * ONE SOURCE. Which objection became which rule lives only here, in each rule's `rests_on`; the
 * objection ledger has no rule field, so the two files can never disagree. An objection is
 * "unlearned" when it is applied and no rule rests on it and it was not dismissed.
 *
 * WRITTEN ONLY BY `tasks rules set|merge|revert`. The owner may edit the prose by hand; a file
 * that no longer parses (or outgrew {@link MAX_RULES_CHARS}) is refused LOUDLY by every write and
 * by the `sleep start` brief, and never overwritten: the owner's hand edit wins until fixed.
 * Deleting a rule section by hand makes its objections unlearned again; `rules revert` is the way
 * to drop a rule for good (its objections move to `dismissed`).
 */

export const RULES_REL_PATH = 'knowledge/patterns/task-filing-rules.md';
/** The whole file, frontmatter included. A rule list that outgrows this needs merging, not more rules. */
export const MAX_RULES_CHARS = 8000;

export interface FilingRule {
  /** `R<n>`, stable for the rule's life. */
  id: string;
  title: string;
  dont: string;
  do: string;
  /** The applied objections (`obj_…`) this rule was learned from. */
  rests_on: string[];
}

export interface RulesDoc {
  rules: FilingRule[];
  /** Objections whose rule was reverted: never learned again. */
  dismissed: string[];
}

export type RulesRead =
  | { state: 'absent'; doc: RulesDoc }
  | { state: 'ok'; doc: RulesDoc }
  | { state: 'unreadable'; reason: string };

export function rulesPath(contextRoot: string): string {
  return join(contextRoot, RULES_REL_PATH);
}

const RULE_HEADING = /^##\s+(R\d+)\s+·\s+(.+?)\s*$/;
const RULE_META = /^<!--\s*rule:\s*(\{.*\})\s*-->\s*$/;
const DISMISSED_META = /^<!--\s*dismissed:\s*(\[.*\])\s*-->\s*$/;
const DONT_LINE = /^-\s+\*\*Don't:\*\*\s*(.*)$/;
const DO_LINE = /^-\s+\*\*Do:\*\*\s*(.*)$/;

function emptyDoc(): RulesDoc {
  return { rules: [], dismissed: [] };
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** Parse the file body. Throws a message naming the first thing that does not parse. */
function parseBody(body: string): RulesDoc {
  const doc = emptyDoc();
  const lines = body.split('\n');
  let current: FilingRule | null = null;
  const finish = (): void => {
    if (!current) return;
    if (!current.dont || !current.do) {
      throw new Error(`${current.id} needs both a "- **Don't:**" and a "- **Do:**" line`);
    }
    doc.rules.push(current);
    current = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = RULE_HEADING.exec(line);
    if (heading) {
      finish();
      const meta = RULE_META.exec(lines[i + 1] ?? '');
      if (!meta) throw new Error(`${heading[1]} has no "<!-- rule: {…} -->" line under its heading`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(meta[1]);
      } catch {
        throw new Error(`${heading[1]}: its rule meta line is not JSON`);
      }
      const m = parsed as { id?: unknown; rests_on?: unknown };
      if (m.id !== heading[1] || !isStringArray(m.rests_on)) {
        throw new Error(`${heading[1]}: its meta line must carry {"id":"${heading[1]}","rests_on":[…]}`);
      }
      current = { id: heading[1], title: heading[2], dont: '', do: '', rests_on: m.rests_on };
      i++;
      continue;
    }
    if (/^##\s/.test(line)) {
      throw new Error(`"${line.trim()}" is not a rule heading ("## R<n> · <title>")`);
    }
    const dismissed = DISMISSED_META.exec(line);
    if (dismissed) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(dismissed[1]);
      } catch {
        throw new Error('the dismissed meta line is not JSON');
      }
      if (!isStringArray(parsed)) throw new Error('the dismissed meta line must be a list of objection ids');
      doc.dismissed = parsed;
      continue;
    }
    if (current) {
      const dont = DONT_LINE.exec(line);
      if (dont) { current.dont = dont[1].trim(); continue; }
      const d = DO_LINE.exec(line);
      if (d) { current.do = d[1].trim(); continue; }
    }
  }
  finish();
  const ids = doc.rules.map((r) => r.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new Error(`${dup} appears twice`);
  return doc;
}

/** Read the rules file. Absent = no rules yet; unreadable = say so, never "no rules". */
export function readRules(contextRoot: string): RulesRead {
  const path = rulesPath(contextRoot);
  if (!existsSync(path)) return { state: 'absent', doc: emptyDoc() };
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    return { state: 'unreadable', reason: `cannot read ${RULES_REL_PATH}: ${(err as Error).message}` };
  }
  if (raw.length > MAX_RULES_CHARS) {
    return { state: 'unreadable', reason: `${RULES_REL_PATH} is ${raw.length} characters, over the ${MAX_RULES_CHARS} limit: merge rules (dreamcontext tasks rules merge)` };
  }
  try {
    return { state: 'ok', doc: parseBody(matter(raw).content) };
  } catch (err) {
    return { state: 'unreadable', reason: `${RULES_REL_PATH} does not parse: ${(err as Error).message}` };
  }
}

/** The file as written by the CLI. */
export function renderRules(doc: RulesDoc): string {
  const fm = {
    name: 'patterns/task-filing-rules',
    description: 'What sleep learned from the owner\'s objections to tasks it opened: before filing a task, '
      + 'check each Don\'t / Do. Written only by `dreamcontext tasks rules set|merge|revert`.',
    triggers: ['task filing', 'open a task', 'görev aç', 'itiraz'],
  };
  const parts: string[] = [
    '# Task filing rules',
    '',
    'Learned from objections (`dreamcontext tasks objections`). Each rule names the objections it rests on.',
    '',
  ];
  for (const r of doc.rules) {
    parts.push(`## ${r.id} · ${r.title}`);
    parts.push(`<!-- rule: ${JSON.stringify({ id: r.id, rests_on: r.rests_on })} -->`);
    parts.push(`- **Don't:** ${r.dont}`);
    parts.push(`- **Do:** ${r.do}`);
    parts.push('');
  }
  if (doc.dismissed.length > 0) parts.push(`<!-- dismissed: ${JSON.stringify(doc.dismissed)} -->`, '');
  return matter.stringify(parts.join('\n'), fm);
}

/** One line of prose: rules are read in a brief, not as documents. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Title comparison form: case, accents and punctuation do not make a rule new. */
export function normalizeRuleTitle(title: string): string {
  return title
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('tr')
    .replace(/ı/g, 'i')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export type RulesWrite = { ok: true; rule: FilingRule; doc: RulesDoc } | { ok: false; message: string };

function writeAtomic(contextRoot: string, doc: RulesDoc): string | null {
  const text = renderRules(doc);
  if (text.length > MAX_RULES_CHARS) {
    return `The rules file would be ${text.length} characters, over the ${MAX_RULES_CHARS} limit. Merge rules that say the same thing (dreamcontext tasks rules merge).`;
  }
  const path = rulesPath(contextRoot);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, 'utf-8');
  renameSync(tmp, path);
  return null;
}

function loadForWrite(contextRoot: string): { ok: true; doc: RulesDoc } | { ok: false; message: string } {
  const read = readRules(contextRoot);
  if (read.state === 'unreadable') {
    return { ok: false, message: `${read.reason}. Fix the file by hand first; it is never overwritten.` };
  }
  return { ok: true, doc: read.doc };
}

/** Every `rests_on` id must be an applied objection. */
function checkRestsOn(restsOn: readonly string[], applied: ReadonlySet<string>): string | null {
  if (restsOn.length === 0) return 'A rule must rest on at least one applied objection (--rests-on obj_…).';
  const bad = restsOn.filter((id) => !applied.has(id));
  return bad.length > 0 ? `Not applied objections: ${bad.join(', ')} (see dreamcontext tasks objections).` : null;
}

/** `tasks rules set`: a NEW rule. A rule with the same title is refused: merge into it instead. */
export function setRule(
  contextRoot: string,
  input: { title: string; dont: string; do: string; restsOn: string[] },
  applied: ReadonlySet<string>,
): RulesWrite {
  const loaded = loadForWrite(contextRoot);
  if (!loaded.ok) return loaded;
  const doc = loaded.doc;
  const title = oneLine(input.title);
  const dont = oneLine(input.dont);
  const doText = oneLine(input.do);
  if (!title || !dont || !doText) return { ok: false, message: 'A rule needs --title, --dont and --do.' };
  const bad = checkRestsOn(input.restsOn, applied);
  if (bad) return { ok: false, message: bad };
  const same = doc.rules.find((r) => normalizeRuleTitle(r.title) === normalizeRuleTitle(title));
  if (same) {
    return { ok: false, message: `${same.id} already says "${same.title}". Add the objection to it: dreamcontext tasks rules merge ${same.id} --rests-on ${input.restsOn.join(',')}` };
  }
  const next = doc.rules.reduce((n, r) => Math.max(n, Number(r.id.slice(1)) || 0), 0) + 1;
  const rule: FilingRule = { id: `R${next}`, title, dont, do: doText, rests_on: [...new Set(input.restsOn)] };
  const out: RulesDoc = { rules: [...doc.rules, rule], dismissed: doc.dismissed };
  const err = writeAtomic(contextRoot, out);
  return err ? { ok: false, message: err } : { ok: true, rule, doc: out };
}

/** `tasks rules merge R<n>`: more objections for an existing rule, optionally new wording. */
export function mergeRule(
  contextRoot: string,
  id: string,
  input: { restsOn: string[]; title?: string; dont?: string; do?: string },
  applied: ReadonlySet<string>,
): RulesWrite {
  const loaded = loadForWrite(contextRoot);
  if (!loaded.ok) return loaded;
  const doc = loaded.doc;
  const found = doc.rules.find((r) => r.id === id);
  if (!found) return { ok: false, message: `No rule ${id} (see ${RULES_REL_PATH}).` };
  const bad = checkRestsOn(input.restsOn, applied);
  if (bad) return { ok: false, message: bad };
  const rule: FilingRule = {
    ...found,
    ...(input.title ? { title: oneLine(input.title) } : {}),
    ...(input.dont ? { dont: oneLine(input.dont) } : {}),
    ...(input.do ? { do: oneLine(input.do) } : {}),
    rests_on: [...new Set([...found.rests_on, ...input.restsOn])],
  };
  const out: RulesDoc = { rules: doc.rules.map((r) => (r.id === id ? rule : r)), dismissed: doc.dismissed };
  const err = writeAtomic(contextRoot, out);
  return err ? { ok: false, message: err } : { ok: true, rule, doc: out };
}

/** `tasks rules revert R<n>`: drop the rule; its objections are dismissed (never learned again). */
export function revertRule(contextRoot: string, id: string): RulesWrite {
  const loaded = loadForWrite(contextRoot);
  if (!loaded.ok) return loaded;
  const doc = loaded.doc;
  const found = doc.rules.find((r) => r.id === id);
  if (!found) return { ok: false, message: `No rule ${id} (see ${RULES_REL_PATH}).` };
  const out: RulesDoc = {
    rules: doc.rules.filter((r) => r.id !== id),
    dismissed: [...new Set([...doc.dismissed, ...found.rests_on])],
  };
  const err = writeAtomic(contextRoot, out);
  return err ? { ok: false, message: err } : { ok: true, rule: found, doc: out };
}

/** The rule resting on this objection, or null (a rule deleted by hand → null). */
export function ruleFor(doc: RulesDoc, objectionId: string): FilingRule | null {
  return doc.rules.find((r) => r.rests_on.includes(objectionId)) ?? null;
}

/** Applied objection ids no rule rests on and none was dismissed. */
export function unlearnedIds(doc: RulesDoc, appliedIds: readonly string[]): string[] {
  const learned = new Set(doc.rules.flatMap((r) => r.rests_on));
  const dismissed = new Set(doc.dismissed);
  return appliedIds.filter((id) => !learned.has(id) && !dismissed.has(id));
}
