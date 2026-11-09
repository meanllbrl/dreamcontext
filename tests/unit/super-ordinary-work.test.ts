import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ordinaryWorkAllows, ordinaryWorkMode } from '../../src/lib/super/ordinary-work.js';
import { SUPER_CHILD_BRIEFING } from '../../src/server/chat-surface.js';

// A fictional machine: a home, a project in it, a linked repo, and a temp folder outside the home.
const base = realpathSync(mkdtempSync(join(tmpdir(), 'dc-ordinary-')));
const home = join(base, 'home', 'ada');
const project = join(home, 'projects', 'orbit');
const linked = join(home, 'projects', 'orbit-app');
const tmp = join(base, 'tmp');
for (const d of [project, linked, tmp, join(home, '.ssh'), join(home, 'Documents')]) mkdirSync(d, { recursive: true });
const ctx = { cwd: project, roots: [linked], home, tmpRoots: [tmp] };
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('ordinary work a member job does without a card', () => {
  it('a scratch script in the temp folder is written without asking (the Galileo case)', () => {
    expect(ordinaryWorkAllows('Write', { file_path: join(tmp, 'gal', 'peek.py'), content: 'print(1)' }, ctx)).toBe(true);
    expect(ordinaryWorkAllows('Edit', { file_path: join(tmp, 'gal', 'clean_new.json'), old_string: 'a', new_string: 'b' }, ctx)).toBe(true);
  });

  it('writes inside the project and a linked repo pass', () => {
    expect(ordinaryWorkAllows('Write', { file_path: join(project, 'boards', 'leads.md') }, ctx)).toBe(true);
    expect(ordinaryWorkAllows('Write', { file_path: 'notes/today.md' }, ctx)).toBe(true);
    expect(ordinaryWorkAllows('MultiEdit', { file_path: join(linked, 'src', 'a.ts') }, ctx)).toBe(true);
  });

  it('reads pass anywhere but a secret place', () => {
    expect(ordinaryWorkAllows('Read', { file_path: join(home, 'Documents', 'brief.pdf') }, ctx)).toBe(true);
    expect(ordinaryWorkAllows('Grep', { pattern: 'x', path: join(home, 'Documents') }, ctx)).toBe(true);
    expect(ordinaryWorkAllows('Glob', { pattern: '**/*.md' }, ctx)).toBe(true);
    expect(ordinaryWorkAllows('Read', { file_path: join(home, '.ssh', 'id_ed25519') }, ctx)).toBe(false);
    expect(ordinaryWorkAllows('Read', { file_path: join(project, '.env') }, ctx)).toBe(false);
    expect(ordinaryWorkAllows('Read', { file_path: join(home, '.dreamcontext', 'telegram', 'bot.json') }, ctx)).toBe(false);
  });
});

describe('what still asks the owner', () => {
  it('a write elsewhere in the home', () => {
    expect(ordinaryWorkAllows('Write', { file_path: join(home, 'Documents', 'x.txt') }, ctx)).toBe(false);
    expect(ordinaryWorkAllows('Write', { file_path: join(home, '.zshrc') }, ctx)).toBe(false);
  });

  it('a secret or a control file, even inside the project', () => {
    expect(ordinaryWorkAllows('Write', { file_path: join(project, '.env.local') }, ctx)).toBe(false);
    expect(ordinaryWorkAllows('Write', { file_path: join(project, '.git', 'hooks', 'pre-commit') }, ctx)).toBe(false);
    expect(ordinaryWorkAllows('Write', { file_path: join(project, '.claude', 'settings.json') }, ctx)).toBe(false);
    expect(ordinaryWorkAllows('Edit', { file_path: join(project, '.mcp.json') }, ctx)).toBe(false);
  });

  it('a link planted in the temp folder is judged by where it really lands', () => {
    symlinkSync(join(home, 'Documents'), join(tmp, 'trap'));
    expect(ordinaryWorkAllows('Write', { file_path: join(tmp, 'trap', 'x.txt') }, ctx)).toBe(false);
  });

  it('commands, MCP, web and questions are never answered here', () => {
    expect(ordinaryWorkAllows('Bash', { command: `python3 ${join(tmp, 'gal', 'peek.py')}` }, ctx)).toBe(false);
    expect(ordinaryWorkAllows('mcp__gmail__send', { to: 'x' }, ctx)).toBe(false);
    expect(ordinaryWorkAllows('WebFetch', { url: 'https://example.com' }, ctx)).toBe(false);
    expect(ordinaryWorkAllows('AskUserQuestion', {}, ctx)).toBe(false);
  });

  it('a temp root that is the home or the disk is no temp folder', () => {
    expect(ordinaryWorkAllows('Write', { file_path: join(home, 'Documents', 'x') }, { ...ctx, tmpRoots: [home] })).toBe(false);
    expect(ordinaryWorkAllows('Write', { file_path: join(home, 'Documents', 'x') }, { ...ctx, tmpRoots: ['/'] })).toBe(false);
  });

  it('only modes that already work alone qualify', () => {
    expect(ordinaryWorkMode('auto')).toBe(true);
    expect(ordinaryWorkMode('bypassPermissions')).toBe(true);
    expect(ordinaryWorkMode('default')).toBe(false);
    expect(ordinaryWorkMode('plan')).toBe(false);
    expect(ordinaryWorkMode('dontAsk')).toBe(false);
  });
});

describe('wiring', () => {
  it('the chat server answers a crew session\'s ordinary requests before any card is relayed', () => {
    const src = readFileSync(join(__dirname, '../../src/server/routes/agent-chat.ts'), 'utf-8');
    expect(src).toMatch(/const ordinaryWork = superCrewEnv === '1'/);
    expect(src).toMatch(/ordinaryWork && o\.type === 'control_request'[\s\S]{0,400}ordinaryWorkAllows\(/);
  });

  it('children are told where scratch files go', () => {
    expect(SUPER_CHILD_BRIEFING).toMatch(/Scratch files[\s\S]*\$TMPDIR/);
  });
});
