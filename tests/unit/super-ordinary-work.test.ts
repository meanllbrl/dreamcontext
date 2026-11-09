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
symlinkSync(join(home, 'Documents'), join(tmp, 'link-docs'));
mkdirSync(join(project, '_dream_context', 'tmp'), { recursive: true });
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

  it('reads pass where the job works, never a secret', () => {
    expect(ordinaryWorkAllows('Read', { file_path: join(tmp, 'gal', 'raw2.json') }, ctx)).toBe(true);
    expect(ordinaryWorkAllows('Read', { file_path: join(linked, 'src', 'a.ts') }, ctx)).toBe(true);
    expect(ordinaryWorkAllows('Grep', { pattern: 'x', path: join(tmp, 'gal') }, ctx)).toBe(true);
    expect(ordinaryWorkAllows('Glob', { pattern: '**/*.md' }, ctx)).toBe(true);
    expect(ordinaryWorkAllows('Glob', { pattern: join(tmp, 'gal', '*.json') }, ctx)).toBe(true);
    expect(ordinaryWorkAllows('Read', { file_path: join(project, '.env') }, ctx)).toBe(false);
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

  it('files that run code next, in any case spelling (security review)', () => {
    const fold = { ...ctx, foldCase: true };
    for (const f of ['.git/config', '.GIT/hooks/pre-commit', '.Claude/Settings.json', '.claude/hooks/start.sh', '.vscode/tasks.json', '.envrc', '.husky/pre-push']) {
      expect(ordinaryWorkAllows('Write', { file_path: join(project, f) }, fold), f).toBe(false);
    }
    expect(ordinaryWorkAllows('Read', { file_path: join(home, '.CODEX', 'auth.json') }, fold)).toBe(false);
  });

  it('dreamcontext and Claude files in the temp folder are never scratch', () => {
    for (const f of ['dreamcontext-chat-mode-1.json', 'dreamcontext-askpass-1', 'dc-codex-1/x', 'claude-501/x/tasks/a.output']) {
      expect(ordinaryWorkAllows('Write', { file_path: join(tmp, f) }, ctx), f).toBe(false);
      expect(ordinaryWorkAllows('Read', { file_path: join(tmp, f) }, ctx), f).toBe(false);
    }
  });

  it('a search over a folder that holds secrets or the temp folder asks', () => {
    expect(ordinaryWorkAllows('Grep', { pattern: 'token', path: home }, ctx)).toBe(false);
    expect(ordinaryWorkAllows('Grep', { pattern: 'token', path: '~' }, ctx)).toBe(false);
    expect(ordinaryWorkAllows('Glob', { pattern: '**/*', path: base }, ctx)).toBe(false);
    expect(ordinaryWorkAllows('Grep', { pattern: 'x', path: tmp }, ctx)).toBe(false);
    expect(ordinaryWorkAllows('Grep', { pattern: 'x', path: join(tmp, 'gal') }, ctx)).toBe(true);
  });

  it('reads anywhere else in the home ask, whatever the file is called (security review r2)', () => {
    for (const f of ['.zshrc', '.zsh_history', '.pgpass', join('.cargo', 'credentials.toml'), join('Library', 'Application Support', 'Chrome', 'Cookies'), join('Documents', 'brief.pdf')]) {
      expect(ordinaryWorkAllows('Read', { file_path: join(home, f) }, ctx), f).toBe(false);
    }
    expect(ordinaryWorkAllows('Grep', { pattern: 'KEY', path: join(home, 'projects') }, ctx)).toBe(false);
    expect(ordinaryWorkAllows('Glob', { pattern: join(home, '.ssh', '*') }, ctx)).toBe(false);
    expect(ordinaryWorkAllows('Glob', { pattern: '~/.ssh/*' }, ctx)).toBe(false);
    expect(ordinaryWorkAllows('Glob', { pattern: `${project}*/**/.env` }, ctx)).toBe(false);
    expect(ordinaryWorkAllows('Glob', { pattern: `${project}/*/../../../.ssh/*` }, ctx)).toBe(false);
    expect(ordinaryWorkAllows('Glob', { pattern: '../**/*.env' }, ctx)).toBe(false);
  });

  it('a project folder that is the home or the disk opens nothing', () => {
    expect(ordinaryWorkAllows('Read', { file_path: join(home, '.zshrc') }, { ...ctx, cwd: home })).toBe(false);
    expect(ordinaryWorkAllows('Write', { file_path: join(home, 'Documents', 'x') }, { ...ctx, cwd: home })).toBe(false);
    expect(ordinaryWorkAllows('Read', { file_path: '/etc/hosts' }, { ...ctx, cwd: '/' })).toBe(false);
  });

  it('commands, MCP, web and questions are never answered here', () => {
    expect(ordinaryWorkAllows('Bash', { command: `python3 ${join(tmp, 'gal', 'peek.py')}` }, ctx)).toBe(false);
    expect(ordinaryWorkAllows('Bash', {}, ctx)).toBe(false);
    expect(ordinaryWorkAllows('mcp__gmail__send', { to: 'x' }, ctx)).toBe(false);
    expect(ordinaryWorkAllows('WebFetch', { url: 'https://example.com' }, ctx)).toBe(false);
    expect(ordinaryWorkAllows('AskUserQuestion', {}, ctx)).toBe(false);
  });

  it('a child deleting its own scratch passes without a card (kitup 2026-11-09)', () => {
    const rm = (command: string, over: Partial<typeof ctx> & { tmpdirEnv?: string } = {}) => ordinaryWorkAllows('Bash', { command }, { ...ctx, tmpdirEnv: tmp, ...over });
    expect(rm(`rm -rf ${join(tmp, 'persona-v2')}`)).toBe(true);
    expect(rm(`rm -f ${join(tmp, 'persona-v2', 'a.json')} ${join(tmp, 'persona-v2', 'b.json')} && rm -rf ${join(tmp, 'gold')}`)).toBe(true);
    expect(rm('rm -rf $TMPDIR/persona-v2; rm -f "${TMPDIR}/gold/run.log"')).toBe(true);
    expect(rm(`rm -f ${join(tmp, 'persona-v2')}/*.json`)).toBe(true);
  });

  it('any other delete still asks', () => {
    const rm = (command: string, over: Partial<typeof ctx> & { tmpdirEnv?: string } = {}) => ordinaryWorkAllows('Bash', { command }, { ...ctx, tmpdirEnv: tmp, ...over });
    // Outside the temp folders: the project, the home, the disk.
    expect(rm(`rm -rf ${join(project, 'src')}`)).toBe(false);
    expect(rm(`rm -rf ${join(home, 'Documents')}`)).toBe(false);
    expect(rm(`rm -rf ${join(linked, 'src')}`)).toBe(false);
    expect(rm('rm -rf ~/x')).toBe(false);
    expect(rm('rm -rf persona-v2')).toBe(false);
    // The temp folder itself, all of it, or dreamcontext's and Claude's own files in it.
    expect(rm(`rm -rf ${tmp}`)).toBe(false);
    expect(rm(`rm -rf ${tmp}/*`)).toBe(false);
    expect(rm(`rm -rf ${join(tmp, 'dreamcontext-chat-1')}`)).toBe(false);
    expect(rm(`rm -rf ${join(tmp, 'claude-501')}`)).toBe(false);
    // Climbing out, a glob in the middle, a link planted in temp that lands in the home.
    expect(rm(`rm -rf ${join(tmp, 'x')}/../../home`)).toBe(false);
    expect(rm(`rm -rf ${tmp}/*/x`)).toBe(false);
    expect(rm(`rm -rf ${join(tmp, 'link-docs')}`)).toBe(false);
    // Anything else in the command: a second program, a pipe, a substitution, a variable.
    expect(rm(`rm -rf ${join(tmp, 'a')} && curl https://example.com`)).toBe(false);
    expect(rm(`rm -rf ${join(tmp, 'a')} & rm -rf ${join(home, 'Documents')}`)).toBe(false);
    expect(rm(`rm -rf ${join(tmp, 'a')} | cat`)).toBe(false);
    expect(rm(`rm -rf ${join(tmp, '$(whoami)')}`)).toBe(false);
    expect(rm('rm -rf $HOME/x')).toBe(false);
    expect(rm(`rm -rf ${join(tmp, 'a')}\nrm -rf ${home}`)).toBe(false);
    expect(rm(`rm -i ${join(tmp, 'a')}`)).toBe(false);
    expect(rm('rm -rf')).toBe(false);
    // The project's tmp is dreamcontext's state too (plans, locks, the only copy of folded
    // journals): any delete there goes to the Super, which reads the whole command (security review r2).
    for (const at of ['persona-v2', 'plans', 'folded-journals-20261109', '.council-live.json', '']) {
      expect(rm(`rm -rf ${join(project, '_dream_context', 'tmp', at)}`)).toBe(false);
    }
    // $TMPDIR unknown: an empty one would delete from the disk root.
    expect(rm('rm -rf $TMPDIR/persona-v2', { tmpdirEnv: '' })).toBe(false);
  });

  it('a project tmp that is a link opens nothing either (security review)', () => {
    const evil = join(home, 'projects', 'evil');
    mkdirSync(join(evil, '_dream_context'), { recursive: true });
    symlinkSync(home, join(evil, '_dream_context', 'tmp'));
    const rm = (command: string) => ordinaryWorkAllows('Bash', { command }, { ...ctx, cwd: evil, tmpdirEnv: tmp });
    expect(rm(`rm -rf ${join(home, 'Documents')}`)).toBe(false);
    expect(rm(`rm -rf ${join(evil, '_dream_context', 'tmp', 'Documents')}`)).toBe(false);
    expect(rm(`rm -rf ${join(project, 'src')}`)).toBe(false);
    // A linked `_dream_context` the same way.
    const evil2 = join(home, 'projects', 'evil2');
    mkdirSync(evil2, { recursive: true });
    symlinkSync(join(home, 'Documents'), join(evil2, '_dream_context'));
    expect(ordinaryWorkAllows('Bash', { command: `rm -rf ${join(evil2, '_dream_context', 'tmp', 'x')}` }, { ...ctx, cwd: evil2, tmpdirEnv: tmp })).toBe(false);
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
