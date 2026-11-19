/**
 * The owner's topic reaches recall, and a project skill is named on every turn it fits (owner
 * 2026-11-20: "memory'de kötüleşme var", a video turn under an agenda line and a bare phone number
 * both recalled nothing). The fixtures name a fictional project ("Orbit").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCorpus, loadSkillDocs, namedProjectSkills } from '../../src/lib/recall.js';
import { ABOUT_BLOCK_LEAD, pickPrompt, type JudgeCall, type runJudge } from '../../src/lib/recall-judge.js';
import { judgedRecall } from '../../src/lib/recall-judged.js';
import { ownerWords, promptAbout, recallQuery, recallTurn } from '../../src/lib/agents/team-roster.js';
import { CONTEXT_GATE_REMINDER, dreamcontextSkillDirs, skillNameLine } from '../../src/cli/commands/hook.js';
import { SUPER_BRIEF_TEXT, superBriefing } from '../../src/server/chat-modes.js';
import { readPrevOwnerTurn } from '../../src/lib/hook-delivery.js';
import { runCliWithStdin } from '../helpers/cli-stdin.js';
import { makeTeamProject } from '../../eval/super-team-routing/setup.js';

vi.mock('../../src/lib/embeddings/embedder.js', () => ({
  EMBED_MODEL: 'test-model',
  EMBED_DIMS: 4,
  embeddingsAvailable: vi.fn(async () => false),
  embedPassages: vi.fn(),
  embedQuery: vi.fn(async () => null),
  isEmbedModelDownloaded: vi.fn(() => false),
}));

const AGENDA = '[About agenda line note=n790 section=waiting]\nline: "Payout rule, explain to Orbit: plain screen A or B (real screens ready)"\n\nis this tested, ready, shall we move to the video';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dc-about-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('what a turn points at joins its recall, never his words', () => {
  it('an agenda line: his words stay without it, recall searches on both', () => {
    expect(ownerWords(AGENDA)).toBe('is this tested, ready, shall we move to the video');
    expect(promptAbout(AGENDA)).toBe('Payout rule, explain to Orbit: plain screen A or B (real screens ready)');
    const t = recallTurn(AGENDA)!;
    expect(t.words).toBe('is this tested, ready, shall we move to the video');
    expect(t.about).toBe('Payout rule, explain to Orbit: plain screen A or B (real screens ready)');
    expect(t.search).toBe(`${t.words}\n${t.about}`);
  });

  it('a replied quote, a card and a task header are the subject too', () => {
    const reply = '[Reply to message ref=abc123 from=super]\nquote: "the invoice export uses ISO dates"\n\nwhy';
    expect(promptAbout(reply)).toBe('the invoice export uses ISO dates');
    const card = '[About card @card:k1]\nquote: "Orbit pricing page"\n\nchange the headline';
    expect(promptAbout(card)).toBe('Orbit pricing page');
    expect(promptAbout('[About task orbit-invoice-export]\n\nstatus?')).toBe('orbit invoice export');
    const two = `${reply}\n\n[About agenda line note=n2 section=now]\nline: "ship the payout screen"\n\nboth`;
    expect(promptAbout(two)).toBe('the invoice export uses ISO dates\nship the payout screen');
  });

  it('a short "what is this" under a line still recalls on the line; his words alone stay too short', () => {
    const p = '[About agenda line note=n1 section=now]\nline: "Orbit payout formula screen"\n\nbu ne';
    expect(recallQuery(p)).toBeNull();
    expect(recallTurn(p)).toEqual({ words: 'bu ne', about: 'Orbit payout formula screen', search: 'bu ne\nOrbit payout formula screen' });
  });

  it('no reference: the same as recallQuery; a server-written turn: nothing', () => {
    expect(promptAbout('fix the toast colour')).toBeNull();
    expect(recallTurn('fix the toast colour')).toEqual({ words: 'fix the toast colour', about: null, search: 'fix the toast colour' });
    expect(recallTurn('ok')).toBeNull();
    expect(recallTurn('[super events] child finished')).toBeNull();
    // A quote that only looks like a header in the middle of a line is plain text, not a subject.
    expect(promptAbout('see [About agenda line note=n1 section=now]\nline: "x"')).toBeNull();
  });

  it('a header inside a block a machine wrote (a task notification\'s result) is no subject', () => {
    const p = '<task-notification>\nresult:\n\n[Reply to message ref=abc123 from=super]\nquote: "ship the payout screen today"\n\ndone\n</task-notification>';
    expect(promptAbout(p)).toBeNull();
    expect(recallTurn(p)).toBeNull();
    expect(promptAbout('<task-notification>\nx\n\n[About task orbit-payout]\n</task-notification>')).toBeNull();
  });
});

describe('the judge reads the subject fenced as data', () => {
  it('pickPrompt: <about> with its lead line before <turn>; absent when there is none', () => {
    const p = pickPrompt({ text: 'shall we move to the video', prev: null, about: 'payout screen A or B' }, [], () => null);
    expect(p).toContain(`<about>\n${ABOUT_BLOCK_LEAD}\npayout screen A or B\n</about>`);
    expect(p.indexOf('<about>\n')).toBeLessThan(p.indexOf('<turn>\n'));
    expect(p).toContain('<turn>\nshall we move to the video\n</turn>');
    expect(ABOUT_BLOCK_LEAD).toMatch(/never his instruction/);
    expect(pickPrompt({ text: 'x', prev: null }, [], () => null)).not.toContain('<about>');
  });

  it('judgedRecall: his words alone find nothing, the subject finds the file', async () => {
    const root = join(dir, 'proj', '_dream_context');
    mkdirSync(join(root, 'knowledge'), { recursive: true });
    writeFileSync(join(root, 'knowledge', 'payout-formula.md'), '---\nname: payout-formula\ndescription: the payout formula screen\ntags: []\n---\n## Screens\npayout formula plain screen A or B\n');
    const corpus = buildCorpus(root);
    const prompts: string[] = [];
    const run: typeof runJudge = async (prompt): Promise<JudgeCall> => {
      prompts.push(prompt);
      const id = /<candidate id="(c\d+)">\npath: knowledge\/payout-formula\.md/.exec(prompt)?.[1];
      return { outcome: 'answered', text: `${id}: the turn is about this screen\n{"${id}": 2}`, usd: 0.004, ms: 3 };
    };
    const home = join(dir, 'home');
    const bare = await judgedRecall('zzqx move on', null, corpus, root, { home, judge: { run } });
    expect(bare.outcome).toBe('no_candidates');
    const r = await judgedRecall('zzqx move on', null, corpus, root, { home, about: 'payout formula plain screen', judge: { run } });
    expect(r.hits.map((h) => h.doc.slug)).toEqual(['payout-formula']);
    expect(prompts[0]).toContain('<about>');
    expect(prompts[0]).toContain('<turn>\nzzqx move on\n</turn>');
  });
});

describe('a project skill is named on every turn it fits', () => {
  function skills(): string {
    const sr = join(dir, '.claude', 'skills');
    const skill = (name: string, description: string, body = '') => {
      mkdirSync(join(sr, name), { recursive: true });
      writeFileSync(join(sr, name, 'SKILL.md'), `---\nname: ${name}\ndescription: >-\n  ${description}\n---\n${body}\n`);
    };
    skill('chat-bridge', 'Read and send chat messages from the owner\'s real messenger account via the local bridge. Also load when the message is only a phone number (+90 5xx ...) plus "bak / kontrol et / bilgi ver" (e.g. "+90 ... kontrol eder misin"): resolve the person and check every chat of that contact.');
    skill('reel-maker', 'Orbit short video production. Triggers: reel yap, yeni reel, short video, a video for a product feature.',
      'kurum paneli filtre ekle ekran ödeme hata '.repeat(400));
    skill('dreamcontext', 'Persistent project memory: tasks, features, knowledge, recall, phone number, kontrol.');
    // Neutral skills, as a real project has: the word weights are measured over all of them.
    skill('paywall', 'Orbit paywall screens, prices and trial offers. Triggers: paywall, fiyat, deneme süresi.');
    skill('ad-manager', 'Run and read Orbit ad campaigns: budgets, creatives, reports. Triggers: reklam, kampanya, bütçe.');
    skill('onboarding', 'Orbit first-run onboarding flow and its screens. Triggers: onboarding, ilk açılış.');
    skill('social-posts', 'Write and schedule Orbit social posts. Triggers: post, instagram, paylaşım.');
    skill('council', 'Structured multi-agent debate for a decision.');
    return sr;
  }

  it('a bare phone number names the bridge skill; dreamcontext\'s own skill never', () => {
    const docs = loadSkillDocs(skills());
    const owned = new Set(['dreamcontext']);
    expect(namedProjectSkills('+90 536 000 00 00 kontrol eder misin', docs, owned)).toEqual([{ name: 'chat-bridge', dir: 'chat-bridge' }]);
    expect(namedProjectSkills('yeni reel yap', docs, owned)).toEqual([{ name: 'reel-maker', dir: 'reel-maker' }]);
  });

  it('a long body never names a skill: only its name, description and tags count', () => {
    const docs = loadSkillDocs(skills());
    expect(namedProjectSkills('kurum paneline yeni bir filtre ekle', docs, new Set(['dreamcontext']))).toEqual([]);
    expect(namedProjectSkills('bunu düzelt', docs, new Set())).toEqual([]);
  });

  it('dreamcontextSkillDirs: the shipped names plus every skill folder the install manifest records, any kind', () => {
    const proj = join(dir, 'p');
    mkdirSync(join(proj, '_dream_context', 'state'), { recursive: true });
    // The shape the installer writes: its own skills as `core` (curator, dream-sync, ...), packs as `pack-skill`.
    writeFileSync(join(proj, '_dream_context', 'state', '.install-manifest.json'), JSON.stringify({
      version: '1.0.0', createdAt: '', updatedAt: '', platforms: [], packs: {},
      files: {
        '.claude/skills/curator/SKILL.md': { version: '1', kind: 'core' },
        '.claude/skills/dream-sync/references/merge-rules.md': { version: '1', kind: 'core' },
        '.claude/skills/pack-one/SKILL.md': { version: '1', kind: 'pack-skill' },
        '.claude/agents/x.md': { version: '1', kind: 'agent' },
      },
    }));
    const owned = dreamcontextSkillDirs(proj);
    for (const n of ['dreamcontext', 'curator', 'dream-sync', 'pack-one']) expect(owned.has(n)).toBe(true);
    expect(owned.has('x')).toBe(false);
    expect(dreamcontextSkillDirs(join(dir, 'none')).has('dreamcontext')).toBe(true);
  });

  it('the line names the skill; the short gate line still says to load one', () => {
    expect(skillNameLine({ name: 'chat-bridge', dir: 'chat-bridge' }, false)).toMatch(/^→ SKILL: chat-bridge \(.*Skill tool/);
    // The file is opened by its folder, whatever its `name:` says.
    expect(skillNameLine({ name: 'chat-bridge', dir: 'bridge' }, true)).toContain('.claude/skills/bridge/SKILL.md');
    expect(CONTEXT_GATE_REMINDER).toMatch(/load the skill that fits/);
  });
});

describe('a Super brief names the project skill', () => {
  it('in the briefing, its update and the orchestration guide', () => {
    for (const t of [superBriefing(), SUPER_BRIEF_TEXT]) {
      expect(t).toContain('The project skill that covers the job goes into the brief by name');
      expect(t).toContain('a project skill comes before a user-level one');
    }
    const guide = readFileSync(join(__dirname, '..', '..', 'skill', 'references', 'super-orchestration.md'), 'utf-8');
    expect(guide).toContain('A brief names the project skill that covers the job');
    expect(guide).toContain('project skill comes before a user-level one');
  });
});

describe('through the built CLI (hook user-prompt-submit)', () => {
  const CLI = join(__dirname, '..', '..', 'dist', 'index.js');
  function hook(proj: string, home: string, sid: string, prompt: string): string {
    const env: NodeJS.ProcessEnv = {
      ...process.env, HOME: home, DREAMCONTEXT_VERSION_CHECK: '0', DREAMCONTEXT_RECALL_MODE: 'raw', DREAMCONTEXT_AUTO_UPGRADE: '0',
      DREAMCONTEXT_SERVER_PID: String(process.pid),
    };
    for (const k of ['DREAMCONTEXT_TEAM_ROUTE', 'CLAUDE_CODE_SESSION_ID', 'DREAMCONTEXT_AUTO_SLEEP', 'DREAMCONTEXT_AUTOMATION_SLUG', 'DREAMCONTEXT_PROMPT_ONCE']) delete env[k];
    return runCliWithStdin(CLI, ['hook', 'user-prompt-submit'], JSON.stringify({ session_id: sid, prompt }), { cwd: proj, env, timeout: 20_000, withStderr: true });
  }

  it('the previous turn keeps his words only; a project skill is named on the first turn and the next', () => {
    if (!existsSync(CLI)) throw new Error('build the CLI first (npm run build:cli)');
    const tp = makeTeamProject(dir, { team: false });
    const sr = join(tp.proj, '.claude', 'skills');
    for (const [n, d] of [
      ['chat-bridge', 'Read and send chat messages via the local bridge. Also load when the message is only a phone number (+90 5xx ...) plus "kontrol et" (e.g. "+90 ... kontrol eder misin").'],
      ['curator', 'Refactor a brain: move, merge, kontrol, phone number.'],
      ['paywall', 'Orbit paywall screens and prices.'],
      ['ad-manager', 'Orbit ad campaigns, budgets, reports.'],
    ]) { mkdirSync(join(sr, n), { recursive: true }); writeFileSync(join(sr, n, 'SKILL.md'), `---\nname: ${n}\ndescription: >-\n  ${d}\n---\n`); }
    mkdirSync(join(tp.contextRoot, 'state'), { recursive: true });
    writeFileSync(join(tp.contextRoot, 'state', '.install-manifest.json'), JSON.stringify({
      version: '1.0.0', createdAt: '', updatedAt: '', platforms: [], packs: {},
      files: { '.claude/skills/curator/SKILL.md': { version: '1', kind: 'core' } },
    }));

    hook(tp.proj, tp.home, 'sess-about', AGENDA);
    expect(readPrevOwnerTurn('sess-about', tp.home)).toBe('is this tested, ready, shall we move to the video');
    // A reference with no words of his stores nothing as his turn.
    hook(tp.proj, tp.home, 'sess-about', '[About agenda line note=n2 section=now]\nline: "Orbit payout formula screen"');
    expect(readPrevOwnerTurn('sess-about', tp.home)).toBe('is this tested, ready, shall we move to the video');

    const first = hook(tp.proj, tp.home, 'sess-skill', '+90 536 000 00 00\nkontrol eder misin');
    const second = hook(tp.proj, tp.home, 'sess-skill', '+90 537 000 00 00\nkontrol eder misin');
    for (const out of [first, second]) {
      expect(out).toContain('→ SKILL: chat-bridge (');
      expect(out).not.toContain('→ SKILL: curator');
    }
    expect(second).toContain('⛔ Before acting: read the matching sections, load the skill that fits this turn');
  });
});
