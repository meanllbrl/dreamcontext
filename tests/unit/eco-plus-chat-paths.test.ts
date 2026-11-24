import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { carryChatModelPick, chatModelSourceParam, noteChatModelPick, resetChatModelPicks } from '../../dashboard/src/components/sleepy/chatSession.js';
import { parseModelSource, resolveSpawnModel } from '../../src/lib/eco-plus.js';

/**
 * Plan eco-plus D3, review round 4 (fix the class, knowledge/patterns/fix-the-class-not-the-finding.md):
 * a chat's model is the owner's only when a PICK EVENT wrote it. ONE table walks every way the
 * window gives a chat a named model; a new spawn that names a model and is not in it fails here,
 * so a fourth "inferred" path cannot slip in unclassified.
 */
type Kind = 'pick' | 'carry' | 'saved';
/** Key: `<id argument>|<model argument>` of a `spawn(` call in AgentSurface.tsx. */
const SPAWN_PATHS: Record<string, { kind: Kind; why: string }> = {
  "m.sessionId|launch.model ?? ''": { kind: 'saved', why: 'roster restore: a pick survives in the stored pick record, nothing else does' },
  "meta.claudeId|launch.model ?? ''": { kind: 'saved', why: 'dormant or parked Resume: same' },
  "codexId|onAntigravity ? '' : defaults.codexDefaultModel": { kind: 'saved', why: 'another tool\'s saved default (never lowered: not Claude)' },
  'cs.claudeId|modelForSession(cs)': { kind: 'saved', why: 'respawn of the same conversation (account, permission): its pick record, if any, still holds' },
  'chat.claudeId|modelForSession(chat)': { kind: 'saved', why: 'mode switch respawn: same' },
  "claudeId|sameTool ? modelForSession(chat) : ''": { kind: 'carry', why: 'agent switch: a NEW conversation; the old one\'s pick record is copied, none = saved (r3 + r4)' },
  'claudeId|pickedModel': { kind: 'pick', why: 'the model picker\'s cross-tool pick' },
  'developId|modelForSession(cs)': { kind: 'carry', why: 'Develop hand-off: a new conversation; the plan\'s pick record is copied (r4)' },
  'pickedClaudeId(pick.chosenModel)|pick.chosenModel': { kind: 'pick', why: 'the Chat landing composer: a model the owner chose before the chat existed (left on default = no model named, no pick)' },
  'pickedClaudeId(model)|model': { kind: 'pick', why: 'a board Delegate composer model changed on purpose' },
  'pickedClaudeId(o.model)|o.model': { kind: 'pick', why: '`dreamcontext window new --model`' },
  'session|model': { kind: 'saved', why: 'member Super: the server forces saved' },
  'session|superModel': { kind: 'saved', why: 'main Super: the server forces saved' },
  'childId|d.model': { kind: 'pick', why: 'a delegation\'s explicit --model (escalation to opus)' },
  'child|r.model': { kind: 'pick', why: 'a delegation resume\'s explicit --model' },
};

/** The top-level comma-separated arguments of every `spawn(` call. */
function spawnCalls(src: string): Array<{ args: string[]; before: string }> {
  const out: Array<{ args: string[]; before: string }> = [];
  const re = /[^\w.]spawn\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (src.slice(Math.max(0, m.index - 20), m.index + 1).includes('const spawn')) continue;
    let depth = 1; let i = m.index + m[0].length; let cur = ''; const args: string[] = [];
    let quote = '';
    for (; i < src.length && depth > 0; i++) {
      const ch = src[i];
      if (quote) { cur += ch; if (ch === quote && src[i - 1] !== '\\') quote = ''; continue; }
      if (ch === "'" || ch === '"' || ch === '`') { quote = ch; cur += ch; continue; }
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      if (ch === ')' || ch === ']' || ch === '}') { depth--; if (depth === 0) break; }
      if (ch === ',' && depth === 1) { args.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim()) args.push(cur.trim());
    out.push({ args, before: src.slice(Math.max(0, m.index - 400), m.index) });
  }
  return out;
}

const SURFACE = readFileSync(join(__dirname, '../../dashboard/src/components/sleepy/AgentSurface.tsx'), 'utf8');

describe('every chat-creation path, one table (review r4)', () => {
  const calls = spawnCalls(SURFACE);
  const named = calls.filter((c) => c.args.length > 5 && c.args[5] !== "''");

  it('finds the spawns it walks', () => {
    expect(calls.length).toBeGreaterThan(25);
    expect(named.length).toBeGreaterThanOrEqual(Object.keys(SPAWN_PATHS).length);
  });

  it('every spawn that names a model is classified, and a pick has its pick event', () => {
    for (const c of named) {
      const key = `${c.args[1]}|${c.args[5]}`;
      const row = SPAWN_PATHS[key];
      expect(row, `unclassified spawn naming a model: ${key}; add it to SPAWN_PATHS as a pick event or saved`).toBeDefined();
      if (row!.kind === 'carry') {
        expect(/carryChatModelPick\([\w.]+, /.test(c.before) && c.before.includes(`, ${c.args[1]});`), `${key} carries a model but not its pick record`).toBe(true);
      } else if (row!.kind === 'pick') {
        const event = c.args[1].startsWith('pickedClaudeId(') || c.before.includes(`noteChatModelPick(${c.args[1]}, ${c.args[5]})`);
        expect(event, `${key} is a pick but writes no pick event`).toBe(true);
      } else {
        expect(c.args[1].startsWith('pickedClaudeId('), `${key} is saved but writes a pick`).toBe(false);
      }
    }
  });

  it('spawn itself never infers a source from its arguments', () => {
    const body = SURFACE.slice(SURFACE.indexOf('const spawn = useCallback('), SURFACE.indexOf('const cs = createChatSession(vault'));
    const code = body.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(code).not.toMatch(/noteChatModelPick|modelSource/);
  });

  it('the only other callers of createChatSession are known, and none writes a pick at spawn', () => {
    const root = join(__dirname, '../../dashboard/src');
    const files: string[] = [];
    const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (/\.tsx?$/.test(n)) files.push(p); } };
    walk(root);
    const callers = files.filter((f) => /[^\w]createChatSession\(/.test(readFileSync(f, 'utf8').replace(/export function createChatSession\(/, ''))).map((f) => f.slice(root.length + 1)).sort();
    expect(callers).toEqual([
      'components/assistant/Notch.tsx', // the Assistant: its saved model; its picker goes through setModel
      'components/embed/appChatStore.ts', // an app chat: the server resolves the app's defaults as saved
      'components/sleepy/AgentSurface.tsx',
      'components/sleepy/chat/PeerSessionCard.tsx', // a peer chat: its chrome's saved default
      'components/whiteboard/boardAgentScratch.ts', // a board card: the saved default; its picker is setModel
    ]);
    for (const f of callers.filter((c) => !c.endsWith('AgentSurface.tsx'))) expect(readFileSync(join(root, f), 'utf8')).not.toMatch(/noteChatModelPick/);
  });
});

describe('what each kind sends and what the server runs under Eco Plus', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
    };
    resetChatModelPicks();
  });
  const runs = (id: string, model: string) => resolveSpawnModel({ model, source: parseModelSource(new URLSearchParams(chatModelSourceParam(id).slice(1)).get('modelSource')), tool: 'claude', on: true }).model;

  it('a path with no pick event runs Sonnet, whatever model it carries', () => {
    expect(chatModelSourceParam('new-tab')).toBe('&modelSource=saved');
    expect(runs('agent-switch', 'opus')).toBe('sonnet');
    expect(runs('restored', 'claude-opus-5-5')).toBe('sonnet');
  });

  it('a pick event keeps the model on every later spawn of that conversation, across a relaunch', () => {
    noteChatModelPick('picked', 'opus');
    expect(chatModelSourceParam('picked')).toBe('');
    expect(runs('picked', 'opus')).toBe('opus');
    resetChatModelPicks(); // the app relaunched: only the stored record remains
    expect(runs('picked', 'opus')).toBe('opus');
    // A NEW conversation carrying that model is no pick.
    expect(runs('picked-switched', 'opus')).toBe('sonnet');
  });

  it('a new conversation carrying a model takes the old one\'s pick record, never more (r4)', () => {
    // Picked Opus, then an agent switch or the Develop hand-off before typing: kept.
    noteChatModelPick('plan-picked', 'opus');
    carryChatModelPick('plan-picked', 'develop-of-picked');
    expect(runs('develop-of-picked', 'opus')).toBe('opus');
    // Never picked (the saved Opus default, the r3 case), then the same switch: lowered.
    carryChatModelPick('fresh-tab', 'agent-of-fresh');
    expect(runs('agent-of-fresh', 'opus')).toBe('sonnet');
  });

  it('an empty model or id writes nothing; an unreadable store means no picks', () => {
    noteChatModelPick('x', '');
    noteChatModelPick('', 'opus');
    expect(store.size).toBe(0);
    store.set('dc.chatModelPicks.v1', '{bad');
    resetChatModelPicks();
    expect(runs('x', 'opus')).toBe('sonnet');
  });
});
