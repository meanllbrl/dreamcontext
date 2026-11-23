import { describe, expect, it } from 'vitest';
import { HOOK_SPECS } from '../../src/cli/commands/install-skill.js';
import { directHeavy, heavyRefusalLead, heavySuggestion } from '../../src/lib/run-budget.js';

describe('the heavy-step gate', () => {
  it('is installed on Bash', () => {
    expect(HOOK_SPECS.some((h) => h.event === 'PreToolUse' && h.name === 'pre-tool-use' && h.matcher === 'Bash')).toBe(true);
  });
  it('lets ordinary commands through', () => {
    for (const c of ['git status', 'ls -la', 'dreamcontext tasks log s "npm run build green"']) expect(directHeavy(c)).toBeNull();
  });
  // A pipe to tail hides the check's exit code, so that run could never keep a receipt
  // (lib/check-receipt.ts): the gate offers --tail on the check alone (2026-11-07).
  it('offers --tail N instead of a pipe to tail, and leaves anything else as it was', () => {
    expect(heavySuggestion('npx vitest run tests/a.test.ts 2>&1 | tail -40')).toBe("dreamcontext builder heavy --tail 40 -- 'npx vitest run tests/a.test.ts'");
    expect(heavySuggestion('cd app && npx tsc --noEmit | tail -n 5')).toBe("dreamcontext builder heavy --tail 5 -- 'cd app && npx tsc --noEmit'");
    expect(heavySuggestion('npx vitest run tests/a.test.ts | grep FAIL | tail -5')).toBe(`dreamcontext builder heavy -- 'npx vitest run tests/a.test.ts | grep FAIL | tail -5'`);
    expect(heavySuggestion('npm run build')).toBe("dreamcontext builder heavy -- 'npm run build'");
  });
  // A full suite starts detached, its command alone (so its exit is its own and its record can
  // be red); while a red record is open, only its files rerun (plan C2, 2026-11-08).
  it('starts a full suite detached, alone, and offers --failed while a red is open', () => {
    expect(heavySuggestion('npx vitest run | grep FAIL | tail -5')).toBe("dreamcontext builder heavy --detach -- 'npx vitest run', then dreamcontext builder heavy --wait <id> (it prints the id)");
    expect(heavySuggestion('npx tsc --noEmit; npm test 2>&1 | tail -5')).toBe("dreamcontext builder heavy --detach -- 'npm test', then dreamcontext builder heavy --wait <id> (it prints the id)");
    expect(heavySuggestion('npm test', { redOpen: true })).toBe('dreamcontext builder test --failed');
    // A build in the chain runs first, on its own line; a leading cd is where the suite runs.
    expect(heavySuggestion('npm run build && npm test')).toBe("dreamcontext builder heavy -- 'npm run build', then dreamcontext builder heavy --detach -- 'npm test', then dreamcontext builder heavy --wait <id> (it prints the id)");
    expect(heavySuggestion('cd packages/api && npx vitest run')).toBe("dreamcontext builder heavy --detach -- 'cd packages/api && npx vitest run', then dreamcontext builder heavy --wait <id> (it prints the id)");
    expect(heavySuggestion('npx tsc --noEmit', { redOpen: true })).toBe("dreamcontext builder heavy -- 'npx tsc --noEmit'");
  });
  // Eco pilot: `append to test file && npm test` was refused whole, the agent believed the
  // append had happened. The refusal must say NO part ran and name the heavy part; what it says
  // about the other parts is read from the suggested form itself, never guessed per kind.
  describe('the refusal lead', () => {
    const lead = (cmd: string, ctx: { redOpen?: boolean } = {}): string => {
      const kind = directHeavy(cmd);
      expect(kind).not.toBeNull();
      return heavyRefusalLead(cmd, kind!, heavySuggestion(cmd, ctx));
    };
    it('says no part ran, names the heavy part, and hands the write back', () => {
      const l = lead("echo 'it(1)' >> tests/a.test.ts && npm test");
      expect(l).toContain('NO part of this command ran');
      expect(l).toContain('`npm test`');
      expect(l).toContain('does NOT show did not run');
      expect(l).toContain("Your command was: echo 'it(1)' >> tests/a.test.ts && npm test");
    });
    it('a lone heavy step says nothing ran', () => {
      expect(lead('npm test')).toContain('nothing ran');
      expect(lead('npm test')).not.toContain('Your command was');
    });
    it('a form that quotes the whole command says every part runs', () => {
      for (const cmd of ['echo x >> src/a.ts && npx tsc --noEmit', 'echo x >> f && npx vitest run --dir tests/unit', 'npx tsc --noEmit || git checkout -- .']) {
        const l = lead(cmd);
        expect(l).toContain('runs the whole command');
        expect(l).not.toContain('does NOT show did not run');
      }
    });
    it('never classifies or relabels the other parts: build+suite, after-parts, ||, tee, heredoc, red record, mid cd', () => {
      const cases = [
        'echo x >> f && npm run build && npm test',
        "npm test && git commit -am 'green'",
        'npm run build && npm test || git checkout -- .',
        'npm test 2>&1 | tee out.log && grep FAIL out.log',
        "cat >> tests/a.test.ts <<'EOF2'\nit('x', () => {})\nEOF2\nnpm test",
        'echo x >> f && cd pkg && npm test',
      ];
      for (const cmd of cases) {
        const l = lead(cmd);
        expect(l).toContain('NO part of this command ran');
        expect(l).not.toMatch(/only after the heavy form is green|first, as a plain command|also not covered/);
        // Whatever the form leaves out, the whole original command comes back verbatim.
        if (!l.includes('runs the whole command')) expect(l).toContain(`Your command was: ${cmd.trim()}`);
      }
      // The heredoc body survives in what is handed back.
      expect(lead("cat >> tests/a.test.ts <<'EOF2'\nit('x', () => {})\nEOF2\nnpm test")).toContain("it('x', () => {})");
      // A red record's form (`--failed`) is no whole command: the write is handed back, the suite is not asked for again.
      const red = lead("echo 'it(1)' >> tests/a.test.ts && npm test", { redOpen: true });
      expect(red).toContain('does NOT show did not run');
      expect(red).not.toMatch(/also not covered/);
    });
    it('never says the suite or a leading cd "never runs": the form shows them, so the agent is told not to repeat them', () => {
      for (const cmd of ['npm run build && npm test', 'cd pkg && npm test 2>&1', 'cd pkg && npm run build | tail -20']) {
        const l = lead(cmd);
        expect(l).toContain('never repeat that');
        expect(l).not.toMatch(/runs only the heavy step|the rest never runs/);
      }
    });
    it('a cd the form shows does not carry over to the parts the agent re-issues', () => {
      for (const cmd of ['cd a && echo x >> f && npm test', 'cd pkg && echo x >> f && npm run build && npm test']) {
        const l = lead(cmd);
        expect(l).toContain('applies only inside the form');
        expect(l).toContain('(cd <dir> && <part>)');
        expect(l).toContain(`Your command was: ${cmd} [end of your command].`);
      }
    });
    it('a cd the suite form cannot keep (mid-chain, before ;, quoted folder) makes the form quote the whole command', () => {
      for (const cmd of ['echo x >> f && cd pkg && npm test', 'cd pkg; npm test', 'cd "my dir" && echo x >> f && npm test']) {
        const s = heavySuggestion(cmd);
        expect(s.startsWith('dreamcontext builder heavy -- ')).toBe(true);
        expect(s).not.toContain('--detach');
        expect(s.replace(/'\\''/g, "'")).toContain(cmd);
      }
      expect(heavySuggestion('cd pkg && npm test')).toContain("--detach -- 'cd pkg && npm test'");
    });
    it('class: any folder change the suite form cannot keep quotes the whole command, red record or not', () => {
      const cmds = ['{ cd pkg && npm test; }', '{ cd pkg && npm run build && npm test; }', 'pushd pkg && npm test', 'pushd "a b" && npm test', 'builtin cd pkg && npm test', 'command cd pkg && npm test',
        'cd a && cd b && npm test', 'cd $(git rev-parse --show-toplevel) && npm test', 'cd "a b" && npm test', 'cd pkg ; npm test', 'npm ci && cd pkg && npm test',
        '\\cd sub && npm test', 'eval "cd sub"; npm test', "cd pkg && eval 'cd sub' && npm test", 'cd pkg && \\cd sub && npm test', "'cd' sub && npm test",
        'chdir pkg && npm test', 'builtin chdir pkg && npm test', "c''d pkg && npm test", 'c\\d pkg && npm test', '"c"d pkg && npm test'];
      for (const cmd of cmds) for (const redOpen of [false, true]) {
        const s = heavySuggestion(cmd, { redOpen });
        expect(s, cmd).toBe(`dreamcontext builder heavy -- '${cmd.replace(/'/g, `'\\''`)}'`);
      }
      // A red record with a leading cd belongs to the session folder, not the cd target.
      expect(heavySuggestion('cd ../other && npm test', { redOpen: true })).toBe("dreamcontext builder heavy -- 'cd ../other && npm test'");
      // No folder change: the suite form and the red shortcut stay.
      expect(heavySuggestion('npm test', { redOpen: true })).toBe('dreamcontext builder test --failed');
      expect(heavySuggestion('cd pkg && npm run build && npm test')).toContain("--detach -- 'cd pkg && npm test'");
    });
    it('names the part of the reported kind', () => {
      expect(lead('npx tsc --noEmit && npm run build')).toContain('`npm run build` (build)');
    });
  });
});
