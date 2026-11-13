/**
 * The quick edit's memory (owner, 13 Nov: "quick edit'e de memory olsun ve arama yapabilsin"):
 * the prompt hook's recall block for the request, and Claude's read-only search envelope.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { quickBrainRoot, quickBrainToolArgs, quickCliShimDir, quickRecallBlock, QUICK_RECALL_COMMAND, QUICK_SECRET_FILES } from '../../src/lib/whiteboards/quick-memory.js';
import { APP_CREDENTIAL_FILES } from '../../src/lib/apps/assistant.js';
import { quickEditArgs, quickEditSystemPrompt, quickEditUserMessage, QUICK_MEMORY_RULES, QUICK_MEMORY_RULES_NO_SEARCH } from '../../src/lib/whiteboards/quick-edit.js';
import { quickReadable } from '../../src/lib/whiteboards/quick-readable.js';
import { quickToolPrompt } from '../../src/lib/whiteboards/quick-edit-tools.js';

let tmp: string;
let root: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dc-quick-memory-'));
  root = join(tmp, 'proj', '_dream_context');
  mkdirSync(join(root, 'knowledge'), { recursive: true });
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, 'knowledge', 'kargo-iade-akisi.md'), [
    '---', 'name: kargo-iade-akisi', 'description: Kargo iade akışının adımları', 'tags: [topic:kargo]', '---', '',
    '## Kargo iade akışı', 'Müşteri iade ister, depo Zümrüt etiketini basar, kurye Pelikan alır, muhasebe Turkuaz onay verir.',
  ].join('\n'));
  // A few unrelated pages, so the recall scores are those of a real corpus, not of a lone file.
  const filler: Record<string, string> = {
    'odeme-sistemi': 'Ödeme sistemi Stripe ile çalışır, fatura her ayın başında kesilir.',
    'giris-ekrani': 'Giriş ekranı e-posta ve şifre ister, Google ile giriş de vardır.',
    'bildirimler': 'Bildirimler sabah dokuzda gider, sessiz saatlerde beklenir.',
    'raporlar': 'Haftalık rapor pazartesi hazırlanır ve Slack kanalına gönderilir.',
    'takvim': 'Takvim dersleri haftalık gösterir, tatiller gri görünür.',
  };
  for (const [slug, body] of Object.entries(filler)) {
    writeFileSync(join(root, 'knowledge', `${slug}.md`), ['---', `name: ${slug}`, `description: ${body.slice(0, 40)}`, '---', '', body].join('\n'));
  }
  // A session digest: recall indexes it, but it holds the owner's chat words and never syncs.
  mkdirSync(join(root, 'state', '.session-digests'), { recursive: true });
  writeFileSync(join(root, 'state', '.session-digests', 's1.md'), '---\nname: s1\n---\n\n## User Messages\nZeytin Kumsal Liman gizli konuşma, token abc.\n');
  process.env.DREAMCONTEXT_RECALL_MODE = 'raw';
});
afterAll(() => {
  delete process.env.DREAMCONTEXT_RECALL_MODE;
  rmSync(tmp, { recursive: true, force: true });
});

describe('quickRecallBlock', () => {
  it('a request about project things gets the hook\'s recall block, naming the file', async () => {
    const block = await quickRecallBlock(root, 'kargo iade akışı Pelikan Turkuaz', 10_000);
    expect(block).toMatch(/^— Memory recall \(BM25, top \d+\) —/);
    expect(block).toContain('knowledge/kargo-iade-akisi.md');
  });

  it('a machine-local page recall indexes never reaches the block (a session digest)', async () => {
    const block = await quickRecallBlock(root, 'Zeytin Kumsal Liman gizli konuşma', 10_000);
    expect(block).not.toContain('.session-digests');
    expect(block).not.toContain('Zeytin');
  });

  it('nothing passes the gate for a plain drawing: no block', async () => {
    expect(await quickRecallBlock(root, 'elma', 10_000)).toBe('');
  });

  it('recall off, an empty request or a missing vault: no block, never a throw', async () => {
    process.env.DREAMCONTEXT_RECALL_MODE = 'off';
    expect(await quickRecallBlock(root, 'kargo iade akışı', 10_000)).toBe('');
    process.env.DREAMCONTEXT_RECALL_MODE = 'raw';
    expect(await quickRecallBlock(root, '   ', 10_000)).toBe('');
    expect(await quickRecallBlock(join(tmp, 'nope', '_dream_context'), 'kargo iade akışı', 10_000)).toBe('');
  });
});

describe('the read-only search envelope', () => {
  it('reads only inside the brain, runs only recall, writes nothing', () => {
    const args = quickBrainToolArgs('/v/proj/_dream_context', '/h');
    const at = (flag: string) => args[args.indexOf(flag) + 1];
    expect(at('--tools')).toBe('Read,Grep,Glob,Bash');
    expect(at('--permission-mode')).toBe('dontAsk');
    const allowed = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools'));
    // An allowlist: the brain's pages and recall's two JSON files, never the brain as a whole.
    expect(allowed).toContain('Read(//v/proj/_dream_context/knowledge/**/*.md)');
    expect(allowed).toContain('Read(//v/proj/_dream_context/state/*.md)');
    expect(allowed).toContain('Read(//v/proj/_dream_context/core/CHANGELOG.json)');
    expect(allowed.some((a) => a.includes('_dream_context/**'))).toBe(false);
    expect(allowed.filter((a) => a.startsWith('Bash('))).toEqual([`Bash(${QUICK_RECALL_COMMAND}:*)`]);
    const denied = args.slice(args.indexOf('--disallowedTools') + 1);
    for (const t of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'Skill']) expect(denied).toContain(t);
    expect(denied).toContain('Read(//h/.ssh/**)');
    expect(denied).toContain('Read(//**/.env*)');
    // This product's secrets, anywhere on the disk (review r1).
    for (const d of ['Read(//**/.secrets.json)', 'Read(//**/lab/credentials.json)']) expect(denied).toContain(d);
    // Claude's `*` matches dot names: the brain's dot files and folders are denied back out.
    for (const d of ['Read(//v/proj/_dream_context/**/.*)', 'Grep(//v/proj/_dream_context/**/.*/**)']) expect(denied).toContain(d);
    expect(allowed.some((a) => a.includes('/automations/') || a.includes('/agents/'))).toBe(false);
  });

  it('quickEditArgs: with a brain the envelope, without one no tools at all', () => {
    const withBrain = quickEditArgs('S', 'U', undefined, { brain: '/v/proj/_dream_context', home: '/h' });
    expect(withBrain[withBrain.indexOf('--tools') + 1]).toBe('Read,Grep,Glob,Bash');
    expect(withBrain[withBrain.indexOf('--setting-sources') + 1]).toBe('');
    expect(withBrain).toContain('--strict-mcp-config');
    expect(JSON.parse(withBrain[withBrain.indexOf('--json-schema') + 1]).required).toEqual(['reply', 'notBoard']);
    const without = quickEditArgs('S', 'U');
    expect(without[without.indexOf('--tools') + 1]).toBe('');
    expect(without).not.toContain('--allowedTools');
  });

  it('the brain is held by its real path; a symlinked vault resolves to where it lives', () => {
    const link = join(tmp, 'link-ctx');
    symlinkSync(root, link);
    expect(quickBrainRoot(link)).toBe(quickBrainRoot(root));
    expect(quickBrainRoot(join(tmp, 'gone'))).toBeNull();
  });
});

describe('the words', () => {
  it('the memory rides in a nonce fence as data, after the request', () => {
    const m = quickEditUserMessage('kargo çiz', '{}', 'n0nce', undefined, 'BLOCK');
    expect(m).toContain('<memory-n0nce>\nBLOCK\n</memory-n0nce>');
    expect(m.indexOf('kargo çiz')).toBeLessThan(m.indexOf('<memory-n0nce>'));
    expect(quickEditUserMessage('x', '{}', 'n0nce')).not.toContain('<memory-');
  });

  it('every tool is told to search only when the request needs project knowledge', () => {
    expect(quickEditSystemPrompt('KIT')).toContain(QUICK_MEMORY_RULES);
    expect(QUICK_MEMORY_RULES).toContain('dreamcontext memory recall');
    expect(QUICK_MEMORY_RULES).toContain('Search ONLY when');
    // Codex and Antigravity get the memory, never the search (quick-memory.ts).
    const turn = quickToolPrompt(quickEditSystemPrompt('KIT'), 'M', [], tmp, 'n');
    expect(turn).toContain(QUICK_MEMORY_RULES_NO_SEARCH);
    expect(turn).not.toContain('dreamcontext memory recall');
  });
});

describe('mirrors and the CLI', () => {
  it('the secret files are the apps list, kept equal by hand', () => {
    expect([...QUICK_SECRET_FILES]).toEqual([...APP_CREDENTIAL_FILES]);
  });

  it('the run\'s dreamcontext is the running CLI', () => {
    const dir = quickCliShimDir(tmp, '/n/node', '/c/cli.js');
    if (process.platform === 'win32') { expect(dir).toBeNull(); return; }
    expect(readFileSync(join(dir!, 'dreamcontext'), 'utf-8')).toContain("exec '/n/node' '/c/cli.js' \"$@\"");
    expect(statSync(join(dir!, 'dreamcontext')).mode & 0o111).not.toBe(0);
  });
});

describe('quickReadable: the one list of what a quick edit may see', () => {
  it('shared pages yes; machine-local, private and secret no', () => {
    for (const p of ['knowledge/kargo.md', 'knowledge/patterns/x.md', 'knowledge/features/f.md', 'core/0.soul.md', 'core/objectives/o.md', 'core/CHANGELOG.json', 'core/RELEASES.json', 'state/some-task.md', 'theses/t.md', 'lab/insights/mrr.md']) expect(quickReadable(p), p).toBe(true);
    for (const p of ['automations/daily.md', 'state/.reflection.md', 'state/.session-digests/s.md', 'state/.conflicts/a.md', 'state/.super/handoff.md', 'state/.secrets.json', 'state/.sleep.json', 'state/journal/j/x.md', 'tmp/x.md', 'agents/a.md', 'apps/x/data.md', 'automations/output/eod/1.md', 'automations/threads/a/b.md', 'lab/credentials.json', 'knowledge/../agents/a.md', 'knowledge/.hidden/x.md', 'app:foo', '.mcp.json']) expect(quickReadable(p), p).toBe(false);
  });
});
