/**
 * Agents do not write the owner's stores (uye-bildirim K3, gate G3; plan criterion 5).
 *
 * `~/.dreamcontext/grants/` (rules, one-shots, bindings) and `~/.dreamcontext/automations.json`
 * are what let a call run without asking and which member may run at all. A session that wrote
 * either would allow itself. The hook's file guard refuses Edit/Write and a shell write there,
 * compared on real paths (a link in the project pointing into the store is caught), with a reason
 * that says what to do instead; the bridge's `bypassNeedsOwner` names both; ordinary work never
 * answers yes there. The guard reads command text, so an interpreter that builds the path in
 * pieces is the known floor (plan K3 "Trust anchor"), recorded here as such. No CLI verb reaches
 * a grant writer.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { Command } from 'commander';
import { isOwnerStorePath, ownerStoreRefusal, ownerStoreWriteTarget } from '../../src/lib/agents/member-file-guard.js';
import { bypassNeedsOwner } from '../../src/lib/t3-bridge/policy.js';
import { ordinaryWorkAllows } from '../../src/lib/super/ordinary-work.js';
import { createProgram } from '../../src/cli/program.js';

let home: string;
let project: string;
const ROOT = process.cwd();

beforeAll(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'dc-grants-')));
  project = realpathSync(mkdtempSync(join(tmpdir(), 'dc-hook-')));
  mkdirSync(join(home, '.dreamcontext', 'grants', 'once'), { recursive: true });
  // A link inside the project that points into the store.
  symlinkSync(join(home, '.dreamcontext', 'grants'), join(project, 'shortcut'));
});
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

const store = () => join(home, '.dreamcontext');

describe('G3: the hook refuses a write to the owner\'s stores', () => {
  it('names both stores, every part of the grant directory included', () => {
    for (const p of ['grants', 'grants/rules/member-x.json', 'grants/once/once-x.json', 'grants/jobs/j.json', 'grants/bindings/123.json', 'automations.json']) {
      expect(isOwnerStorePath(join(store(), p), home)).toBe(true);
    }
    for (const p of ['automations.json.bak', 'grantsish/x', 'agents/scout.md', 'state.json']) {
      expect(isOwnerStorePath(join(store(), p), home)).toBe(false);
    }
  });

  it('Edit, Write, MultiEdit and NotebookEdit into the store, with the reason', () => {
    for (const tool of ['Edit', 'Write', 'MultiEdit']) {
      expect(ownerStoreWriteTarget(tool, { file_path: join(store(), 'grants', 'once', 'x.json') }, project, home)).toBeTruthy();
    }
    expect(ownerStoreWriteTarget('Write', { file_path: '~/.dreamcontext/automations.json' }, project, home)).toBeTruthy();
    expect(ownerStoreWriteTarget('NotebookEdit', { notebook_path: join(store(), 'grants', 'x.ipynb') }, project, home)).toBeTruthy();
    expect(ownerStoreWriteTarget('Write', { file_path: join(project, 'notes.md') }, project, home)).toBeNull();
    const why = ownerStoreRefusal(join(store(), 'automations.json'));
    expect(why).toMatch(/permission store/);
    expect(why).toMatch(/ask the owner/);
    expect(why).not.toMatch(/—/);
  });

  it('a link inside the project that points into the store is the store (real paths)', () => {
    expect(ownerStoreWriteTarget('Write', { file_path: 'shortcut/once/once-x.json' }, project, home)).toBeTruthy();
    expect(ownerStoreWriteTarget('Bash', { command: 'echo {} > shortcut/rules/member-x.json' }, project, home)).toBeTruthy();
  });

  it('a shell write: redirect, tee, cp, mv, rm, sed -i, a heredoc script', () => {
    const cmds = [
      'echo \'{"scope":"member"}\' > ~/.dreamcontext/grants/rules/member-x.json',
      'cat x | tee ~/.dreamcontext/automations.json',
      'cp /tmp/x.json $HOME/.dreamcontext/grants/once/once-y.json',
      `mv /tmp/b.json ${store()}/grants/bindings/1.json`,
      'rm ~/.dreamcontext/grants/rules/member-x.json',
      'sed -i "" s/a/b/ ~/.dreamcontext/automations.json',
      `python3 - <<'EOF'\nopen('${store()}/grants/once/z.json', 'w').write('{}')\nEOF`,
    ];
    for (const command of cmds) expect(ownerStoreWriteTarget('Bash', { command }, project, home), command).toBeTruthy();
    // Reading it is not writing it.
    expect(ownerStoreWriteTarget('Bash', { command: 'cat ~/.dreamcontext/automations.json' }, project, home)).toBeNull();
  });

  // The known floor (plan K3 "Trust anchor"): the guard reads command TEXT, so a path an
  // interpreter builds from pieces at run time is not seen. The grant store sits on the same
  // anchor as automations.json already did; G3 raises the floor, it is not a wall.
  it('KNOWN FLOOR: an interpreter write with a split path is not caught', () => {
    const command = `python3 -c "import os; open(os.path.join(os.path.expanduser('~'), '.dream' + 'context', 'grants', 'once', 'x.json'), 'w')"`;
    expect(ownerStoreWriteTarget('Bash', { command }, project, home)).toBeNull();
  });
});

describe('G3 at the bridge and in ordinary work', () => {
  it('bypassNeedsOwner names both stores (a tool with no hook brings them to the owner)', () => {
    expect(bypassNeedsOwner('Write', { file_path: join(store(), 'grants', 'once', 'x.json') }, project)).toBe(true);
    expect(bypassNeedsOwner('Edit', { file_path: '/Users/x/.dreamcontext/automations.json' }, project)).toBe(true);
    expect(bypassNeedsOwner('Bash', { command: 'echo {} > ~/.dreamcontext/grants/rules/r.json' }, project)).toBe(true);
    expect(bypassNeedsOwner('Write', { file_path: join(project, 'ok.txt') }, project)).toBe(false);
  });

  it('neither store is ever ordinary work', () => {
    for (const file_path of [join(store(), 'grants', 'once', 'x.json'), join(store(), 'automations.json')]) {
      expect(ordinaryWorkAllows('Write', { file_path }, { cwd: project, home })).toBe(false);
      expect(ordinaryWorkAllows('Edit', { file_path }, { cwd: project, home, roots: [home] })).toBe(false);
    }
  });
});

describe('G2: no CLI verb creates, widens, lists or removes a grant', () => {
  it('no command of createProgram() is about grants', () => {
    const names: string[] = [];
    const walk = (c: Command, path: string[]): void => {
      for (const sub of c.commands) {
        const here = [...path, sub.name()];
        names.push(here.join(' '));
        walk(sub, here);
      }
    };
    walk(createProgram(), []);
    expect(names.length).toBeGreaterThan(50);
    // `apps grant` is the Apps page's one-time publish grant (apps-share.ts), another store: the
    // import walk below shows it never touches this one.
    expect(names.filter((n) => /\bgrants?\b/i.test(n))).toEqual(['apps grant']);
  });

  it('no CLI source imports a grant writer; the hook only reads, and spends a one-shot it enforces', () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    walk(join(ROOT, 'src', 'cli'));
    const writers = /\b(writeGrant|removeGrant|removeMemberGrants|pruneGrants|pruneRecordGrants|dropSessionJobGrants|writeBinding|removeBinding|addConversationId)\b/;
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      const imports = [...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'[^']*grants\/store\.js'/g)].map((m) => m[1]);
      for (const names of imports) expect(writers.test(names), relative(ROOT, f)).toBe(false);
      expect(/routes\/grants\.js/.test(text), relative(ROOT, f)).toBe(false);
    }
  });
});
