/**
 * The PreToolUse gate on a member's file (`member-file-guard.ts`). The Python case is the real
 * accident, renamed: a session appended to `agents/doctor.md` from a heredoc with a relative path.
 */
import { describe, it, expect } from 'vitest';
import { memberFileRefusal, memberFileWriteTarget } from '../../src/lib/agents/member-file-guard.js';

const HOME = '/Users/robin';
const BRAIN = '/Users/robin/projects/acme/_dream_context';
const bash = (command: string, cwd = '/Users/robin/projects/acme') => memberFileWriteTarget('Bash', { command }, cwd, HOME);

describe('Edit, Write, MultiEdit', () => {
  it.each(['Edit', 'Write', 'MultiEdit'])('%s stops at an agent and an automation file', (tool) => {
    expect(memberFileWriteTarget(tool, { file_path: `${BRAIN}/agents/doctor.md` }, '/', HOME)).toBe(`${BRAIN}/agents/doctor.md`);
    expect(memberFileWriteTarget(tool, { file_path: `${BRAIN}/automations/doctor.md` }, '/', HOME)).toBe(`${BRAIN}/automations/doctor.md`);
  });
  it('resolves a relative path, and a global agent', () => {
    expect(memberFileWriteTarget('Edit', { file_path: 'agents/doctor.md' }, BRAIN, HOME)).toBe(`${BRAIN}/agents/doctor.md`);
    expect(memberFileWriteTarget('Write', { file_path: '~/.dreamcontext/agents/roamer.md' }, '/', HOME)).toBe('/Users/robin/.dreamcontext/agents/roamer.md');
  });
  it('leaves everything else free', () => {
    for (const p of [
      `${BRAIN}/automations/output/doctor/2026-10-30.md`,
      `${BRAIN}/automations/threads/doctor/2026-10-30.md`,
      `${BRAIN}/knowledge/agents/doctor.md`,
      '/Users/robin/projects/acme/.claude/agents/reviewer.md',
      '/Users/robin/projects/dreamcontext/agents/reviewer.md',
      '/Users/robin/.dreamcontext/agents/roamer/memory.md',
    ]) expect(memberFileWriteTarget('Write', { file_path: p }, '/', HOME), p).toBeNull();
  });
});

describe('Bash', () => {
  it('stops the real accident: a heredoc, a variable, a relative path', () => {
    const command = `python3 - <<'EOF'\np='agents/doctor.md'\ns=open(p).read()\ns=s.replace('## Pattern','A new line\\n\\n## Pattern',1)\nopen(p,'w').write(s)\nEOF`;
    expect(bash(command, BRAIN)).toBe(`${BRAIN}/agents/doctor.md`);
  });
  it('reads a Windows path with backslashes as a path, quoted or not', () => {
    for (const c of ['cp x "C:\\p\\_dream_context\\agents\\a.md"', 'cp x C:\\p\\_dream_context\\agents\\a.md', 'rm C:\\p\\_dream_context\\automations\\job.md']) expect([c, bash(c)]).not.toEqual([c, null]);
    expect(bash('cp x C:\\p\\notes\\a.md')).toBeNull();
  });
  it('follows a cd', () => {
    expect(bash(`cd ${BRAIN} && sed -i '' 's/a/b/' agents/doctor.md`)).toBe(`${BRAIN}/agents/doctor.md`);
  });
  it.each([
    [`sed -i 's/a/b/' ${BRAIN}/agents/doctor.md`],
    [`perl -pi -e 's/a/b/' ${BRAIN}/automations/doctor.md`],
    [`echo x >> ${BRAIN}/agents/doctor.md`],
    [`echo x > "${BRAIN}/agents/doctor.md"`],
    [`echo x | tee -a ${BRAIN}/agents/doctor.md`],
    [`rm ${BRAIN}/agents/doctor.md`],
    [`mv /tmp/new.md ${BRAIN}/agents/doctor.md`],
    [`cp /tmp/new.md ${BRAIN}/agents/doctor.md`],
    [`node -e "require('fs').writeFileSync('${BRAIN}/agents/doctor.md','x')"`],
  ])('stops %s', (command) => {
    expect(bash(command)).not.toBeNull();
  });
  it.each([
    [`sed -E -i 's/a/b/' ${BRAIN}/agents/doctor.md`],
    [`dd if=/tmp/x of=${BRAIN}/agents/doctor.md`],
    [`F=${BRAIN}/agents/doctor.md; sed -i '' 's/a/b/' $F`],
    [`cd ${BRAIN}/agents && sed -i '' 's/a/b/' doctor.md`],
    [`python3 -c "from pathlib import Path; Path('${BRAIN}/agents/doctor.md').write_text('x')"`],
    [`python3 -c "open('${BRAIN}/agents/doctor.md','r+').write('x')"`],
    [`cat > ${BRAIN}/agents/doctor.md <<EOF\nhello\nEOF`],
    [`env PYTHONUTF8=1 python3 - <<'E'\nopen('${BRAIN}/agents/doctor.md','w').write('x')\nE`],
    [`uv run python - <<'E'\nopen('${BRAIN}/agents/doctor.md','w').write('x')\nE`],
    [`uv run --with pyyaml python - <<'E'\nopen('${BRAIN}/agents/doctor.md','w').write('x')\nE`],
    [`timeout 30 python3 - <<'E'\nopen('${BRAIN}/agents/doctor.md','w').write('x')\nE`],
    [`/usr/bin/env python3 - <<'E'\nopen('${BRAIN}/agents/doctor.md','w').write('x')\nE`],
    [`env -i python3 -c "open('${BRAIN}/agents/doctor.md','w').write('x')"`],
    [`(python3 - <<'E'\nopen('${BRAIN}/agents/doctor.md','w').write('x')\nE\n)`],
  ])('stops %s too', (command) => {
    expect(bash(command)).not.toBeNull();
  });
  it.each([
    // Reading a member to write a --prompt-file is the door's own first step.
    [`python3 - <<'E'\ns=open('${BRAIN}/agents/doctor.md').read()\nopen('/tmp/new.md','w').write(s+'x')\nE`],
    [`node -e "const s=require('fs').readFileSync('${BRAIN}/agents/doctor.md','utf8');require('fs').writeFileSync('/tmp/n.md',s)"`],
    [`cat ${BRAIN}/agents/doctor.md; python3 -c "open('/tmp/x','w').write('y')"`],
    [`grep "rm -rf" ${BRAIN}/agents/doctor.md`],
    [`grep -c "sed -i" ${BRAIN}/agents/doctor.md`],
    [`echo "see -> ${BRAIN}/agents/doctor.md"`],
    [`git commit -m "rm the line from ${BRAIN}/agents/doctor.md"`],
    [`dreamcontext super team amend doctor --why "agents/doctor.md said rm the cache; a real mistake" --prompt-file /tmp/n.md`],
    [`git commit -F - <<'E'\nrm ${BRAIN}/agents/doctor.md was wrong\nE`],
    [`dreamcontext super team amend doctor --why "a session ran open('${BRAIN}/agents/doctor.md','a') by hand" --prompt-file /tmp/n.md`],
    [`git commit -m "it was open('${BRAIN}/agents/doctor.md','w')"`],
    [`grep -n "writeFileSync('${BRAIN}/agents/doctor.md', x)" a.test.ts`],
    [`cat > /tmp/note.md <<'EOF'\nopen('${BRAIN}/agents/doctor.md','w')\nEOF`],
    [`python3 - <<'E'\nmember='${BRAIN}/agents/doctor.md'\nopen('/tmp/member-size.txt','w').write('1')\nE`],
    [`python3 - <<'E'\nfrom pathlib import Path\np=Path('${BRAIN}/agents/doctor.md')\n(Path('/tmp')/p.name).write_text(p.read_text())\nE`],
    [`python3 - <<'E'\np='${BRAIN}/agents/doctor.md'\nopen(f'/tmp/{p}.txt','w').write('1')\nE`],
    [`perl -Mstrict -ne 'print' ${BRAIN}/agents/doctor.md`],
    [`cat > /tmp/python-note.md <<'EOF'\nopen('${BRAIN}/agents/doctor.md','w')\nEOF`],
    [`cd /tmp/python-svc && cat > n.txt <<'EOF'\nopen('${BRAIN}/agents/doctor.md','w')\nEOF`],
    [`gh pr create --title "guard: python heredoc" --body "$(cat <<'EOF'\nopen('${BRAIN}/agents/doctor.md','w')\nEOF\n)"`],
    [`git commit -m "$(cat <<'EOF'\nfix: python3 -c "open('${BRAIN}/agents/doctor.md','w')" is refused\nEOF\n)"`],
    [`cat > /tmp/n.md <<'E'\npython3 -c "open('${BRAIN}/agents/doctor.md','w')"\nE`],
    [`sed -n 1,20p ${BRAIN}/agents/doctor.md | cut -c1-300`],
    [`cat ${BRAIN}/agents/doctor.md`],
    [`grep -n Prompt ${BRAIN}/agents/doctor.md > /tmp/out.txt`],
    [`cp ${BRAIN}/agents/doctor.md /tmp/doctor-new.md`],
    [`git diff -- ${BRAIN}/agents/doctor.md`],
    [`wc -c ${BRAIN}/agents/doctor.md; sed -i '' 's/a/b/' ${BRAIN}/state/some-task.md`],
    [`sed -i '' 's/a/b/' agents/reviewer.md`],
    [`ls ${BRAIN}/agents/`],
    ['dreamcontext agents show doctor --json'],
  ])('lets %s through', (command) => {
    expect(bash(command)).toBeNull();
  });
  it('is not Bash, Edit or Write: nothing to gate', () => {
    expect(memberFileWriteTarget('Read', { file_path: `${BRAIN}/agents/doctor.md` }, '/', HOME)).toBeNull();
  });
});

describe('odd input', () => {
  it('reads a Windows path', () => {
    expect(memberFileWriteTarget('Edit', { file_path: 'C:\\Users\\robin\\acme\\_dream_context\\agents\\doctor.md' }, 'C:\\Users\\robin', 'C:\\Users\\robin')).not.toBeNull();
  });
  it('stays fast on one huge token, and survives nonsense', () => {
    const at = Date.now();
    expect(bash(`echo ${'a'.repeat(200_000)}agents/x.md`)).toBeNull();
    expect(bash(`${'\n'.repeat(90_000)}x.md`)).toBeNull();
    expect(Date.now() - at).toBeLessThan(2000);
    for (const v of [undefined, null, 5, {}, '']) expect(memberFileWriteTarget('Bash', { command: v }, '/', HOME)).toBeNull();
    expect(memberFileWriteTarget('Edit', {}, '/', HOME)).toBeNull();
  });
});

describe('the refusal', () => {
  it('names the door', () => {
    const text = memberFileRefusal(`${BRAIN}/agents/doctor.md`);
    expect(text).toContain('dreamcontext super team amend');
    expect(text).toContain('AI Team page');
  });
});
