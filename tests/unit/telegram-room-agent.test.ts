/**
 * A group's room agent (tg-grup C3, G5, G6): its argv and working folder, its parse, and what it can
 * read. The leak fixture plants a marker in every private place of a brain (a member's profile,
 * drafts, automations, agents, the inbox, secrets, the Super's handoff, session digests, lab
 * credentials, the MCP config, the knowledge archive, a JSON beside the pages, a linked repo) and
 * proves the room's allow rules open none of them, while a knowledge page and a task file are open.
 * Fictional people and project only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import fg from 'fast-glob';
import { parseRoomOutput, roomAgentArgs, roomRecallBlock } from '../../src/server/telegram/room-agent.js';
import { QUICK_DOT_DENY_GLOBS, QUICK_READABLE_GLOBS, quickReadable } from '../../src/lib/whiteboards/quick-readable.js';
import { QUICK_SECRET_FILES } from '../../src/lib/whiteboards/quick-memory.js';

const MARK = 'ZEBERCET-GIZLI-ISARET';
let tmp: string;
let root: string;
let brainReal: string;

/** Every private place the plan names (G6), relative to the brain. */
const PRIVATE = [
  'tmp/super/x.html', 'tmp/x.md', 'people/x.md', 'automations/x.md', 'agents/x.md', 'inbox/x.md',
  'state/.secrets.json', 'state/.super/handoff.md', 'state/.session-digests/x.md', 'lab/credentials.json', '.mcp.json',
  'knowledge/.archive/x.md', 'knowledge/x.json',
];

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dc-room-agent-'));
  root = join(tmp, 'acme', '_dream_context');
  for (const p of PRIVATE) {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), p.endsWith('.json') ? JSON.stringify({ note: MARK }) : `---\nname: x\n---\n\n${MARK} Deniz'in özel notu.\n`);
  }
  // A linked repo beside the brain.
  mkdirSync(join(tmp, 'acme-code', 'src'), { recursive: true });
  writeFileSync(join(tmp, 'acme-code', 'src', 'secret.ts'), `// ${MARK}\n`);
  // What a room may read.
  mkdirSync(join(root, 'knowledge'), { recursive: true });
  writeFileSync(join(root, 'knowledge', 'yeni-ekran.md'), '---\nname: yeni-ekran\ndescription: Yeni ekranın durumu\n---\n\nYeni ekran tasarımda, Lacivert Kuğu adıyla bu hafta bitiyor.\n');
  // A few unrelated pages, so the recall scores are those of a real corpus.
  for (const [slug, body] of Object.entries({
    'odeme-sistemi': 'Ödeme sistemi faturayı her ayın başında keser.',
    'giris-ekrani': 'Giriş ekranı e-posta ve şifre ister.',
    'bildirimler': 'Bildirimler sabah dokuzda gider.',
    'raporlar': 'Haftalık rapor pazartesi hazırlanır.',
    'takvim': 'Takvim dersleri haftalık gösterir.',
  })) writeFileSync(join(root, 'knowledge', `${slug}.md`), `---\nname: ${slug}\ndescription: ${body.slice(0, 30)}\n---\n\n${body}\n`);
  writeFileSync(join(root, 'state', 'yeni-ekran-isi.md'), '---\nname: yeni-ekran-isi\nstatus: in_progress\n---\n\nYeni ekran işi.\n');
  brainReal = realpathSync(root);
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('the room envelope (G5)', () => {
  it('pins the argv: read-only search, no settings, no MCP, no slash commands, the schema, resume', () => {
    const args = roomAgentArgs({ system: 'S', user: 'U', brainReal: '/v/acme/_dream_context', resume: '33333333-2222-4333-8444-555555555555', home: '/h' });
    const at = (f: string) => args[args.indexOf(f) + 1];
    expect(at('-p')).toBe('U');
    expect(at('--model')).toBe('opus');
    expect(at('--effort')).toBe('medium');
    expect(at('--output-format')).toBe('json');
    expect(at('--permission-mode')).toBe('dontAsk');
    expect(at('--tools')).toBe('Read,Grep,Glob,Bash');
    // Kept by name: an empty value keeps any CLAUDE.md above the room folder out.
    expect(args.indexOf('--setting-sources')).toBeGreaterThan(-1);
    expect(at('--setting-sources')).toBe('');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--disable-slash-commands');
    expect(at('--system-prompt')).toBe('S');
    expect(JSON.parse(at('--json-schema'))).toMatchObject({ required: ['say'] });
    expect(at('--resume')).toBe('33333333-2222-4333-8444-555555555555');
    for (const never of ['--no-session-persistence', '--permission-prompt-tool', '--dangerously-skip-permissions', '--add-dir']) expect(args).not.toContain(never);
    expect(args.filter((a) => a === '--allowedTools')).toHaveLength(1);
    const allowed = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools'));
    expect(allowed.filter((a) => a.startsWith('Bash('))).toEqual(['Bash(dreamcontext memory recall:*)']);
    expect(args.join(' ')).not.toContain('dreamcontext super');
    expect(roomAgentArgs({ system: 'S', user: 'U', brainReal: '/v', resume: null })).not.toContain('--resume');
  });
});

describe('what a room can read (G6, the leak fixture)', () => {
  /** Every file the allow rules open, as Claude matches them (`*` takes dot names too), minus the denies. */
  function openedByRules(): string[] {
    const opened = new Set(fg.sync(QUICK_READABLE_GLOBS.map((g) => g.slice(1)), { cwd: brainReal, dot: true, onlyFiles: true }));
    const dotDenied = new Set(fg.sync(QUICK_DOT_DENY_GLOBS.map((g) => g.slice(1)), { cwd: brainReal, dot: true, onlyFiles: true }));
    const secret = new Set(fg.sync(QUICK_SECRET_FILES.map((g) => g), { cwd: brainReal, dot: true, onlyFiles: true }));
    return [...opened].filter((p) => !dotDenied.has(p) && !secret.has(p)).sort();
  }

  it('no planted private marker is open to the rules or to the recall filter', () => {
    const open = openedByRules();
    for (const p of PRIVATE) {
      expect(open, p).not.toContain(p);
      expect(quickReadable(p), p).toBe(false);
    }
    expect(open.some((p) => p.includes('..'))).toBe(false);
  });

  it('a knowledge page and a task file are open', () => {
    const open = openedByRules();
    expect(open).toContain('knowledge/yeni-ekran.md');
    expect(open).toContain('state/yeni-ekran-isi.md');
  });

  it('a member cannot read the owner\'s personal profile: people/ is outside every rule', () => {
    const args = roomAgentArgs({ system: 'S', user: 'U', brainReal, resume: null });
    const allowed = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools'));
    expect(allowed.some((a) => a.includes('/people/') || a.includes('_dream_context/**)'))).toBe(false);
    expect(quickReadable('people/deniz.md')).toBe(false);
    // The linked repo is outside the brain: no rule names it.
    expect(allowed.some((a) => a.includes('acme-code'))).toBe(false);
    expect(relative(brainReal, join(tmp, 'acme-code')).startsWith('..')).toBe(true);
  });

  it('the recall block names a knowledge page by its absolute path, and never a private one', async () => {
    process.env.DREAMCONTEXT_RECALL_MODE = 'raw';
    try {
      const block = await roomRecallBlock(root, 'yeni ekran Lacivert Kuğu ne durumda', brainReal, 10_000);
      expect(block).toContain(join(brainReal, 'knowledge', 'yeni-ekran.md'));
      const secret = await roomRecallBlock(root, `${MARK} Deniz özel notu`, brainReal, 10_000);
      for (const p of PRIVATE) expect(secret).not.toContain(p);
      expect(secret).not.toContain(MARK);
    } finally { delete process.env.DREAMCONTEXT_RECALL_MODE; }
  });
});

describe('the parse (C3)', () => {
  const env = (o: Record<string, unknown>) => JSON.stringify({ type: 'result', session_id: '33333333-2222-4333-8444-555555555555', ...o });

  it('reads the schema output, else a JSON result; the session id rides along', () => {
    expect(parseRoomOutput(env({ structured_output: { say: 'Merhaba' } }))).toEqual({ answer: { say: 'Merhaba' }, sessionId: '33333333-2222-4333-8444-555555555555', noSession: false });
    expect(parseRoomOutput(env({ result: '```json\n{"say":"Selam"}\n```' })).answer).toEqual({ say: 'Selam' });
  });

  it('anything else is no answer: no JSON, a schema miss, an error, a lost conversation', () => {
    expect(parseRoomOutput('not json').answer).toBeNull();
    expect(parseRoomOutput(env({ result: 'düz metin' })).answer).toBeNull();
    expect(parseRoomOutput(env({ structured_output: { text: 'x' } })).answer).toBeNull();
    expect(parseRoomOutput(env({ is_error: true, result: 'boom' })).answer).toBeNull();
    expect(parseRoomOutput(env({ is_error: true, result: 'No conversation found with session ID x' })).noSession).toBe(true);
  });
});
