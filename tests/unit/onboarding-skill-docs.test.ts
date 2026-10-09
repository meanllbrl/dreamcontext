/**
 * Marker lock for the first-run onboarding docs (feature-integration-pattern item 8).
 *
 * A capability the skill does not describe is invisible: the agent cannot route a user who
 * says "claude: command not found" to the machine check if no doc names it. So this pins the
 * doc surfaces to what was actually built:
 *   - every flag the docs name exists on the real command tree (createProgram), so a renamed
 *     flag fails here instead of leaving the docs pointing at nothing;
 *   - the UI words the docs quote are the UI's own copy (I18nContext EN);
 *   - each surface (SKILL.md, the three references, the initializer skill, README) still
 *     names the machine check, the flags and the This Mac / Project / Start flow;
 *   - the new prose carries no em dash.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { createProgram } from '../../src/cli/program.js';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf-8');

const SKILL = read('skill/SKILL.md');
const CLI_REF = read('skill/references/cli-reference.md');
const TROUBLE = read('skill/references/troubleshooting.md');
const INTEGRATIONS = read('skill/references/integrations.md');
const INITIALIZER = read('skill-initializer/SKILL.md');
const README = read('README.md');
const I18N = read('dashboard/src/context/I18nContext.tsx');

/** The text from `heading` up to the next heading of the same or higher level. */
function section(doc: string, heading: string): string {
  const start = doc.indexOf(heading);
  expect(start, `${heading} not found`).toBeGreaterThan(-1);
  const level = heading.match(/^#+/)?.[0].length ?? 2;
  const rest = doc.slice(start + heading.length);
  const next = rest.search(new RegExp(`\\n#{1,${level}} `));
  return heading + (next < 0 ? rest : rest.slice(0, next));
}

/** The one line (or bullet) of `doc` that starts with `prefix`. */
function lineStartingWith(doc: string, prefix: string): string {
  const line = doc.split('\n').find((l) => l.startsWith(prefix));
  expect(line, `no line starting with ${prefix}`).toBeDefined();
  return line ?? '';
}

function optionFlags(program: Command, name: string): string[] {
  const cmd = program.commands.find((c) => c.name() === name);
  expect(cmd, `command ${name} not registered`).toBeDefined();
  return (cmd?.options ?? []).map((o) => o.long ?? '');
}

const MACHINE_HEADING = '### Machine readiness: setup machine phase and `doctor --machine`';

describe('the documented flags exist on the real command tree', () => {
  const program = createProgram();

  it('setup has --skip-machine, --no-start, --yes and --defaults', () => {
    const flags = optionFlags(program, 'setup');
    for (const f of ['--skip-machine', '--no-start', '--yes', '--defaults']) expect(flags).toContain(f);
  });

  it('doctor has --machine and --json', () => {
    const flags = optionFlags(program, 'doctor');
    expect(flags).toContain('--machine');
    expect(flags).toContain('--json');
  });
});

describe('the UI words the docs quote are the UI copy', () => {
  for (const label of ['This Mac', 'Set everything up', 'Start with Claude', 'Finish setting up ({n} left)']) {
    it(`"${label}" is an EN string in I18nContext`, () => {
      expect(I18N).toContain(`'${label}'`);
    });
  }
});

describe('skill/SKILL.md', () => {
  const quickMap = section(SKILL, '## Setup & Maintenance (quick map)');

  it('setup row names the machine phase, its flags and the Launcher onboarding', () => {
    const row = lineStartingWith(quickMap, '- `dreamcontext setup`');
    expect(row).toContain('--skip-machine');
    expect(row).toContain('--no-start');
    expect(row).toMatch(/Launcher's onboarding/);
  });

  it('names doctor --machine', () => {
    expect(quickMap).toContain('`doctor --machine`');
  });

  it('routes "command not found" and "not signed in" to setup / the Launcher checklist', () => {
    const row = lineStartingWith(quickMap, '- **"claude: command not found"');
    expect(row).toContain('not signed in');
    expect(row).toContain('`setup`');
    expect(row).toContain("Launcher's checklist");
    expect(row).toContain('references/troubleshooting.md');
  });
});

describe('skill/references/cli-reference.md', () => {
  const machine = section(CLI_REF, MACHINE_HEADING);

  it('the setup row names the new flags and links the machine section', () => {
    const row = lineStartingWith(CLI_REF, '| `setup` |');
    expect(row).toContain('`--skip-machine`');
    expect(row).toContain('`--no-start`');
    expect(row).toContain('#machine-readiness-setup-machine-phase-and-doctor---machine');
  });

  it('the doctor row names --machine', () => {
    expect(lineStartingWith(CLI_REF, '| `doctor` |')).toContain('`--machine`');
  });

  it('documents the checks, the plan, the modes, the hand-off and the pending git init', () => {
    for (const id of ['`network`', '`node`', '`npm`', '`cli`', '`claude`', '`claude-auth`', '`git`', '`github`', '`gh`', '`terminal`']) {
      expect(machine).toContain(id);
    }
    expect(machine).toContain('`git-install` FIRST');
    expect(machine).toContain('`--yes`');
    expect(machine).toContain('`--defaults`');
    expect(machine).toContain('`--skip-machine`');
    expect(machine).toContain('`--no-start`');
    expect(machine).toContain('Waiting for the macOS developer tools to finish');
    expect(machine).toContain('~/.dreamcontext/onboarding.json');
    expect(machine).toContain('{ version: 1, machine: <report> }');
    expect(machine).toContain('`doctor/machine-<id>`');
  });

  it('documents the installers, the shell-profile markers and the private Node.js layout', () => {
    expect(machine).toContain('https://claude.ai/install.sh');
    expect(machine).toContain('never piped');
    for (const marker of ['# dreamcontext: Node.js on PATH', '# dreamcontext: dreamcontext CLI on PATH', '# dreamcontext: Claude Code CLI on PATH']) {
      expect(machine).toContain(marker);
    }
    expect(machine).toContain('`repo read:org gist`');
    expect(machine).toContain('~/.dreamcontext/node/<version>/');
    expect(machine).toContain('~/.dreamcontext/npm-global');
    expect(machine).toContain('assets/runtime-pins.json');
  });

  it('documents the /api/onboarding endpoints and their guards', () => {
    expect(machine).toContain('GET /api/onboarding/readiness');
    expect(machine).toContain('POST /api/onboarding/fix');
    expect(machine).toContain('POST /api/onboarding/fix/cancel');
    expect(machine).toContain('loopback `Host`');
    expect(machine).toContain('Sec-Fetch-Site: cross-site');
    expect(machine).toContain('/api/agent/install/status');
  });

  it('the setup-commands list names doctor --machine', () => {
    expect(CLI_REF).toContain('- `dreamcontext doctor --machine`');
  });
});

describe('skill/references/troubleshooting.md', () => {
  const sec = section(TROUBLE, '## "command not found" (claude, dreamcontext, node) or Claude not signed in');

  it('sends the user to doctor --machine and setup, and names the Launcher steps', () => {
    expect(sec).toContain('dreamcontext doctor --machine');
    expect(sec).toContain('dreamcontext setup');
    expect(sec).toContain('**This Mac**');
    expect(sec).toContain('**Project**');
    expect(sec).toContain('**Start**');
    expect(sec).toContain('**Set everything up**');
  });
});

describe('skill/references/integrations.md', () => {
  it('describes the onboarding takeover, its three steps and the no-Node setup screen', () => {
    expect(lineStartingWith(INTEGRATIONS, '- **First-run onboarding**')).toContain('Finish setting up (N left)');
    const mac = lineStartingWith(INTEGRATIONS, '  - **This Mac**');
    expect(mac).toContain('GET /api/onboarding/readiness');
    expect(mac).toContain('**Set everything up**');
    expect(lineStartingWith(INTEGRATIONS, '  - **Project**')).toContain('git init');
    expect(lineStartingWith(INTEGRATIONS, '  - **Start**')).toContain('**Start with Claude**');
    const noNode = lineStartingWith(INTEGRATIONS, '- **No Node.js on the Mac**');
    expect(noNode).toContain('~/.dreamcontext/node/<version>');
    expect(noNode).toContain('DREAMCONTEXT_FORCE_NODE_SETUP=1');
  });

  it('no longer describes the retired quiz wizard', () => {
    expect(INTEGRATIONS).not.toContain('quiz-style wizard');
  });
});

describe('skill-initializer/SKILL.md', () => {
  it('names the onboarding hand-off as an entry', () => {
    const line = lineStartingWith(INITIALIZER, '- **Onboarding hand-off**');
    expect(line).toContain('Start with Claude');
    expect(line).toContain('dreamcontext setup');
  });
});

describe('README.md', () => {
  it('Quick Start names the machine check, its flags and the private Node.js', () => {
    expect(README).toContain('dreamcontext doctor --machine');
    expect(README).toContain('`setup --skip-machine`');
    expect(README).toContain('`--no-start`');
    expect(README).toContain('`~/.dreamcontext/node`');
  });

  it('the Desktop App onboarding paragraph describes This Mac, Project and Start with Claude', () => {
    const para = lineStartingWith(README, '**Onboarding without a terminal.**');
    expect(para).toContain('**This Mac**');
    expect(para).toContain('**Set everything up**');
    expect(para).toContain('**Project**');
    expect(para).toContain('**Start with Claude**');
    expect(para).not.toContain('paste into your agent');
  });
});

describe('the new onboarding prose carries no em dash', () => {
  const pieces: Array<[string, string]> = [
    ['SKILL.md setup row', lineStartingWith(section(SKILL, '## Setup & Maintenance (quick map)'), '- `dreamcontext setup`')],
    ['cli-reference machine section', section(CLI_REF, MACHINE_HEADING)],
    ['troubleshooting section', section(TROUBLE, '## "command not found" (claude, dreamcontext, node) or Claude not signed in')],
    ['integrations onboarding bullet', lineStartingWith(INTEGRATIONS, '- **First-run onboarding**')],
    ['integrations This Mac step', lineStartingWith(INTEGRATIONS, '  - **This Mac**')],
    ['integrations Project step', lineStartingWith(INTEGRATIONS, '  - **Project**')],
    ['integrations Start step', lineStartingWith(INTEGRATIONS, '  - **Start**')],
    ['integrations agent panel bullet', lineStartingWith(INTEGRATIONS, '- **Agent panel setup**')],
    ['integrations no-Node bullet', lineStartingWith(INTEGRATIONS, '- **No Node.js on the Mac**')],
    ['initializer hand-off line', lineStartingWith(INITIALIZER, '- **Onboarding hand-off**')],
    ['README onboarding paragraph', lineStartingWith(README, '**Onboarding without a terminal.**')],
  ];
  for (const [name, text] of pieces) {
    it(name, () => {
      expect(text).not.toContain('—');
    });
  }
});
