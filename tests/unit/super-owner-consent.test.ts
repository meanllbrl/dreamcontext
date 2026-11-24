/**
 * The owner's own written word passes ONE of his permissions (owner 2026-11-15: "Neden izini
 * buradan veremedim"). The server decides from what IT recorded of his typing, never the Super's
 * word: a fake ref, a server turn, a message older than the card, a second use, two waiting cards
 * with none named, and an outward call are all refused.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  _resetOwnerWords, allowByOwnerWords, consentOf, noteOwnerWords, ownerPermissionItem, writtenConsentRefusal,
  type WaitingCard, type WrittenConsentDeps,
} from '../../src/lib/super/owner-consent.js';
import { classifyOwnerFrame, superOwnerWordsOf } from '../../src/server/routes/agent-chat.js';
import { msgRef, type OwnerAnswerRequest, type SuperQueueItem } from '../../src/lib/super/types.js';

const SESSION = 'sup-1';
/** Times in these tests are offsets from now (his words older than a day are no consent). */
const T = Date.now();

function refusal(id: string, createdAt: number, input = 'ls dist', extra: Partial<SuperQueueItem> = {}): SuperQueueItem {
  return {
    id, sessionId: 'c1', kind: 'owner', state: 'escalated', createdAt: T + createdAt,
    wait: { kind: 'refusal', id: `w-${id}`, refusal: { tool: 'Bash', input, whole: true, source: 'classifier' } },
    ...extra,
  } as SuperQueueItem;
}
function mirror(id: string, createdAt: number, member: string): SuperQueueItem {
  return { id, sessionId: `m-${member}`, kind: 'member', state: 'escalated', createdAt: T + createdAt, member, answers: `own-${id}`, of: 'permission', requestId: `r-${id}` } as SuperQueueItem;
}

function deps(over: Partial<WrittenConsentDeps> = {}) {
  const answer = vi.fn(async (_root: string, _req: OwnerAnswerRequest) => ({ ok: true as const, outcome: 'answered' as const }));
  const d: WrittenConsentDeps = {
    mirror: async (_root, id) => ({ item: { id: `own-${id}`, sessionId: 'm', kind: 'permission', state: 'pending', createdAt: 1, requestId: 'r' } as SuperQueueItem }),
    call: (item) => item.kind === 'owner' && item.wait?.refusal
      ? { tool: item.wait.refusal.tool, input: item.wait.refusal.input, whole: item.wait.refusal.whole }
      : { tool: 'Bash', input: 'ls dist', whole: true },
    answer,
    memberName: (slug) => (slug === 'pr-mesaj' ? 'Conor' : slug === 'strateji' ? 'Atlas' : null),
    ...over,
  };
  return { d, answer };
}

function said(text: string, at: number, waiting?: WaitingCard[], via: 'telegram' | 'phone' | 'composer' = 'telegram'): string {
  const ref = msgRef(text);
  noteOwnerWords(SESSION, { ref, text, via, at: T + at, ...(waiting ? { waiting: Promise.resolve(waiting) } : {}) });
  return ref;
}

const record = (queue: SuperQueueItem[]) => ({ superId: 'main' as const, session: SESSION, queue });

beforeEach(() => { _resetOwnerWords(); });

describe('consentOf: his WHOLE message is a plain yes or no', () => {
  it.each([
    ['İzin veriyorum', 'allow'],
    ['IZIN VERIYORUM', 'allow'],
    ['evet, geçir', 'allow'],
    ['ok go ahead', 'allow'],
    ['tamam', 'allow'],
    // D14: how he says it
    ['onay verdim saysın', 'allow'],
    ['hadi evet', 'allow'],
    ['artık onaylıyorum', 'allow'],
    ['onay verdim mi?', null],
    ["don't say yes", null],
    ['hadi', null],
    ['izin verme', 'deny'],
    ['hayır', 'deny'],
    ['hayır, izin verme', 'deny'],
    ['izin vermiyorum', 'deny'],
    ['Neden izini buradan veremedim', null],
    ['izin verdin mi?', null],
    ['ne oldu', null],
    ['', null],
    // review r1: a yes word inside other words is no consent
    ['Do not allow it', null],
    ['izin vermeden önce bana sor', null],
    ['Bana durum raporu ver', null],
    ['tamam, sonra bakarım', null],
    ['I am not sure, ok let me look later', null],
    ['evet ama push yapma', null],
  ] as const)('%s → %s', (text, want) => {
    expect(consentOf(text)).toBe(want);
  });
  it('a waiting card\'s member name, with its case ending, rides along', () => {
    expect(consentOf("Conor'a izin veriyorum", ['pr-mesaj', 'Conor'])).toBe('allow');
    expect(consentOf("Conor'a izin veriyorum")).toBeNull();
  });
});

describe('writtenConsentRefusal: outward calls need his tap', () => {
  it.each([
    'git push main main', 'git push --force origin x', 'npm publish', 'gh pr merge 12', 'git merge super/x',
    'git reset --hard HEAD~1', 'gh api repos/x/y -X DELETE', 'cd /x && git push',
    // review r1: forms the label list misses
    'git --no-pager push', 'git --git-dir=.git push', 'fly deploy', 'wrangler deploy', 'netlify deploy --prod', 'docker push acme/x',
    'cargo publish', 'twine upload dist/*', 'eas submit -p ios', 'terraform apply', 'aws s3 cp a s3://b', 'curl -X POST https://x.test -d @f',
    'curl https://x.test --data-binary @f', 'ssh host ls', 'rsync -a dist/ host:/srv',
    // review r2: a push hidden behind a script, an alias, a package script or an inline program
    'bash go.sh', './go.sh', 'sh -c "git pu""sh"', 'git p', 'git -c alias.p=push p', 'git commit -m x', 'npm run ship', 'npm test',
    'make ship', 'python3 -c "import os; os.system(1)"', 'node -e "x"', 'cd /x && bash go.sh', 'FOO=1 sudo bash go.sh',
    'echo $(git push)', 'ls `x`', 'git config alias.p push', 'npx something',
    // review r3: the program disguised, a wrapper with flags, a runner off the list, a git hook
    '"bash" go.sh', '\\bash go.sh', "'git' p", '$SHELL go.sh', 'G=git; $G p', 'nice -n 5 bash go.sh', 'env -i bash go.sh',
    'sudo -u me bash go.sh', 'command -p bash go.sh', 'find . -maxdepth 0 -exec bash go.sh ;', "awk 'BEGIN{system(1)}'",
    'open go.command', 'arch -arm64 bash go.sh', 'crontab job.txt', 'git checkout main', 'git switch main', 'git --git-dir=x status',
  ])('%s is refused', (cmd) => {
    expect(writtenConsentRefusal({ tool: 'Bash', input: cmd, whole: true })).not.toBeNull();
  });
  it.each(['mcp__github__create_pull_request', 'mcp__github__merge_pull_request', 'mcp__github__push_files', 'WebFetch', 'mcp__slack__read'])('the %s tool is refused', (tool) => {
    expect(writtenConsentRefusal({ tool, input: '{}', whole: true })).not.toBeNull();
  });
  it('a file tool passes, except where writing makes later commands run code', () => {
    expect(writtenConsentRefusal({ tool: 'Write', input: '/x/a.md', whole: false })).not.toBeNull();
    expect(writtenConsentRefusal({ tool: 'Write', input: '/x/a.md', whole: true })).toBeNull();
    for (const path of ['/x/.git/hooks/post-checkout', '/x/.git/config', '/Users/u/.gitconfig', '/Users/u/Library/LaunchAgents/a.plist', '/x/package.json', '/x/Makefile', '/Users/u/.zshrc', '/x/.husky/pre-commit']) {
      expect(writtenConsentRefusal({ tool: 'Write', input: path, whole: true }), path).not.toBeNull();
    }
  });
  it('a cut command is refused', () => {
    expect(writtenConsentRefusal({ tool: 'Bash', input: 'npm run build', whole: false })).not.toBeNull();
  });
  it.each(['ls dist && cat a.txt', 'ffmpeg -i a.mp4 -t 3 b.mp4', 'curl -s https://x.test/status', 'git status && git diff', 'mkdir -p out && cp a b'])('%s passes', (cmd) => {
    expect(writtenConsentRefusal({ tool: 'Bash', input: cmd, whole: true })).toBeNull();
  });
});

describe('ownerPermissionItem', () => {
  it('a Bypass child\'s permission handed to the Super is not his; an allowed one waits on nothing', () => {
    expect(ownerPermissionItem({ id: 'a', sessionId: 'c', kind: 'permission', state: 'pending', createdAt: 1, toSuper: true } as SuperQueueItem)).toBe(false);
    expect(ownerPermissionItem({ id: 'a', sessionId: 'c', kind: 'permission', state: 'pending', createdAt: 1 } as SuperQueueItem)).toBe(true);
    expect(ownerPermissionItem(refusal('r', 1, 'ls', { allowed: 'once' }))).toBe(false);
    expect(ownerPermissionItem({ id: 'a', sessionId: 'c', kind: 'question', state: 'escalated', createdAt: 1 } as SuperQueueItem)).toBe(false);
  });
});

describe('allowByOwnerWords', () => {
  it('passes the one waiting card on his later "İzin veriyorum", as his answer, once', async () => {
    const { d, answer } = deps();
    const ref = said('İzin veriyorum', 200);
    const r = await allowByOwnerWords('/root', record([refusal('q1', 100, 'ffmpeg -i a.mp4 b.mp4')]), { item: 'q1', ref, deny: false }, d);
    expect(r).toMatchObject({ ok: true, behavior: 'allow', answer: { ok: true } });
    expect(answer).toHaveBeenCalledTimes(1);
    expect(answer.mock.calls[0][1]).toEqual({
      record: 'main', item: 'q1', via: 'chat',
      answer: { kind: 'refusal', action: 'allow', size: 'once' },
      shown: { tool: 'Bash', input: 'ffmpeg -i a.mp4 b.mp4' },
    });
  });

  it('a ref the server never saw him type is refused (a fake, a server turn, a child\'s words)', async () => {
    const { d, answer } = deps();
    const r = await allowByOwnerWords('/root', record([refusal('q1', 100)]), { item: 'q1', ref: msgRef('İzin veriyorum'), deny: false }, d);
    expect(r).toMatchObject({ ok: false, error: 'not_owner_message' });
    expect(answer).not.toHaveBeenCalled();
  });

  it('his words in ANOTHER Super session are no consent here', async () => {
    const { d } = deps();
    noteOwnerWords('other-session', { ref: msgRef('evet'), text: 'evet', via: 'composer', at: T + 200 });
    const r = await allowByOwnerWords('/root', record([refusal('q1', 100)]), { item: 'q1', ref: msgRef('evet'), deny: false }, d);
    expect(r).toMatchObject({ ok: false, error: 'not_owner_message' });
  });

  it('a message written before the card was born is refused', async () => {
    const { d, answer } = deps();
    const ref = said('izin veriyorum', 50);
    const r = await allowByOwnerWords('/root', record([refusal('q1', 100)]), { item: 'q1', ref, deny: false }, d);
    expect(r).toMatchObject({ ok: false, error: 'before_card' });
    expect(answer).not.toHaveBeenCalled();
  });

  it('his words older than a day are no consent', async () => {
    const { d } = deps();
    const ref = said('izin veriyorum', 200);
    const r = await allowByOwnerWords('/root', record([refusal('q1', 100)]), { item: 'q1', ref, deny: false, now: T + 25 * 3600_000 }, d);
    expect(r).toMatchObject({ ok: false, error: 'not_owner_message' });
  });

  it('one message passes one permission: a second use is refused', async () => {
    const { d, answer } = deps();
    const ref = said('izin veriyorum', 200);
    const q = [refusal('q1', 100)];
    expect((await allowByOwnerWords('/root', record(q), { item: 'q1', ref, deny: false }, d)).ok).toBe(true);
    const again = await allowByOwnerWords('/root', record([refusal('q2', 150)]), { item: 'q2', ref, deny: false }, d);
    expect(again).toMatchObject({ ok: false, error: 'ref_used' });
    expect(answer).toHaveBeenCalledTimes(1);
  });

  it('two calls at once on one message: only one is answered', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const { d, answer } = deps({ mirror: async (_root, id) => { await gate; return { item: { id: `own-${id}`, sessionId: 'm', kind: 'permission', state: 'pending', createdAt: 1, requestId: 'r' } as SuperQueueItem }; } });
    const ref = said('Conor\'a izin veriyorum', 200);
    const q = [mirror('m1', 100, 'pr-mesaj')];
    const a = allowByOwnerWords('/root', record(q), { item: 'm1', ref, deny: false }, d);
    const b = allowByOwnerWords('/root', record(q), { item: 'm1', ref, deny: false }, d);
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect([ra.ok, rb.ok].filter(Boolean)).toHaveLength(1);
    expect(answer).toHaveBeenCalledTimes(1);
  });

  it('a question or an unclear line is no consent; "no" does not allow', async () => {
    const { d, answer } = deps();
    const q = [refusal('q1', 100)];
    const r1 = await allowByOwnerWords('/root', record(q), { item: 'q1', ref: said('Neden izini buradan veremedim', 200), deny: false }, d);
    expect(r1).toMatchObject({ ok: false, error: 'not_consent' });
    const r2 = await allowByOwnerWords('/root', record(q), { item: 'q1', ref: said('hayır, izin verme', 210), deny: false }, d);
    expect(r2).toMatchObject({ ok: false, error: 'not_consent' });
    expect(answer).not.toHaveBeenCalled();
  });

  it('his "no" denies it (--deny)', async () => {
    const { d, answer } = deps();
    const ref = said('hayır, izin verme', 200);
    const r = await allowByOwnerWords('/root', record([refusal('q1', 100)]), { item: 'q1', ref, deny: true }, d);
    expect(r).toMatchObject({ ok: true, behavior: 'deny' });
    expect(answer.mock.calls[0][1].answer).toEqual({ kind: 'refusal', action: 'not_needed', size: 'once' });
  });

  it('two of his permissions waiting and his message names neither: refused, both listed', async () => {
    const { d, answer } = deps();
    const q = [mirror('m1', 100, 'pr-mesaj'), mirror('m2', 110, 'strateji')];
    const r = await allowByOwnerWords('/root', record(q), { item: 'm1', ref: said('İzin veriyorum', 200), deny: false }, d);
    expect(r).toMatchObject({ ok: false, error: 'several_pending', pending: ['m1', 'm2'] });
    expect(answer).not.toHaveBeenCalled();
  });

  it('two waiting, his message names the member: that one passes, the other never', async () => {
    const { d, answer } = deps();
    const q = [mirror('m1', 100, 'pr-mesaj'), mirror('m2', 110, 'strateji')];
    const ref = said('Conor\'a izin veriyorum', 200);
    const wrong = await allowByOwnerWords('/root', record(q), { item: 'm2', ref, deny: false }, d);
    expect(wrong).toMatchObject({ ok: false, error: 'several_pending' });
    const right = await allowByOwnerWords('/root', record(q), { item: 'm1', ref, deny: false }, d);
    expect(right.ok).toBe(true);
    expect(answer).toHaveBeenCalledTimes(1);
    expect(answer.mock.calls[0][1]).toMatchObject({ item: 'm1', answer: { kind: 'permission', behavior: 'allow', size: 'once' } });
  });

  it('a card born AFTER his message does not count as waiting', async () => {
    const { d } = deps();
    const q = [refusal('q1', 100), refusal('q2', 300)];
    const r = await allowByOwnerWords('/root', record(q), { item: 'q1', ref: said('izin veriyorum', 200), deny: false }, d);
    expect(r.ok).toBe(true);
  });

  it('an outward call (push) never passes on his words, and the words are not spent', async () => {
    const { d, answer } = deps();
    const ref = said('izin veriyorum', 200);
    const r = await allowByOwnerWords('/root', record([refusal('q1', 100, 'git push main main')]), { item: 'q1', ref, deny: false }, d);
    expect(r).toMatchObject({ ok: false, error: 'outward' });
    expect(answer).not.toHaveBeenCalled();
    // Still his, for a card that is not outward.
    const r2 = await allowByOwnerWords('/root', record([refusal('q2', 150)]), { item: 'q2', ref, deny: false }, d);
    expect(r2.ok).toBe(true);
  });

  it('an answer that did not land leaves his words unspent', async () => {
    const answer = vi.fn(async () => ({ ok: false as const, error: 'no_window' as const, message: 'x' }));
    const { d } = deps({ answer });
    const ref = said('izin veriyorum', 200);
    const r = await allowByOwnerWords('/root', record([refusal('q1', 100)]), { item: 'q1', ref, deny: false }, d);
    expect(r).toMatchObject({ ok: true, answer: { ok: false, error: 'no_window' } });
    const again = await allowByOwnerWords('/root', record([refusal('q1', 100)]), { item: 'q1', ref, deny: false }, d);
    expect(again.ok).toBe(true);
    expect(answer).toHaveBeenCalledTimes(2);
  });

  it('a Bypass child\'s permission handed to the Super is not passed this way', async () => {
    const { d } = deps();
    const q = [{ id: 'p1', sessionId: 'c1', kind: 'permission', state: 'pending', createdAt: T + 100, requestId: 'r', toSuper: true } as SuperQueueItem];
    const r = await allowByOwnerWords('/root', record(q), { item: 'p1', ref: said('izin veriyorum', 200), deny: false }, d);
    expect(r).toMatchObject({ ok: false, error: 'not_owner_permission' });
  });

  it('a member Super passes its own item under its own record', async () => {
    const { d, answer } = deps();
    const ref = said('izin veriyorum', 200);
    await allowByOwnerWords('/root', { superId: 'm:pr-mesaj', session: SESSION, queue: [refusal('q1', 100)] }, { item: 'q1', ref, deny: false }, d);
    expect(answer.mock.calls[0][1].record).toBe('pr-mesaj');
  });
});

describe('allowByOwnerWords: what the server can prove (review r1)', () => {
  it('words typed on the Mac (a socket any local process can open) never pass: tap the card', async () => {
    const { d, answer } = deps();
    const ref = said('İzin veriyorum', 200, undefined, 'composer');
    const r = await allowByOwnerWords('/root', record([refusal('q1', 100)]), { item: 'q1', ref, deny: false }, d);
    expect(r).toMatchObject({ ok: false, error: 'mac_words' });
    expect(answer).not.toHaveBeenCalled();
  });

  it('his phone\'s words pass like Telegram\'s', async () => {
    const { d } = deps();
    const ref = said('İzin veriyorum', 200, undefined, 'phone');
    expect((await allowByOwnerWords('/root', record([refusal('q1', 100)]), { item: 'q1', ref, deny: false }, d)).ok).toBe(true);
  });

  it('two were waiting when he wrote: closing one since does not make his words about the other', async () => {
    const { d, answer } = deps();
    const ref = said('İzin veriyorum', 200, [{ id: 'q1' }, { id: 'q2' }]);
    const now = [refusal('q1', 100, 'ls', { state: 'done' }), refusal('q2', 110)];
    const r = await allowByOwnerWords('/root', record(now), { item: 'q2', ref, deny: false }, d);
    expect(r).toMatchObject({ ok: false, error: 'several_pending', pending: ['q1', 'q2'] });
    expect(answer).not.toHaveBeenCalled();
  });

  it('a card that was not waiting on him when he wrote is not his words\' subject', async () => {
    const { d } = deps();
    const ref = said('İzin veriyorum', 200, [{ id: 'q1' }]);
    const r = await allowByOwnerWords('/root', record([refusal('q1', 100), refusal('q2', 110)]), { item: 'q2', ref, deny: false }, d);
    expect(r).toMatchObject({ ok: false, error: 'before_card' });
  });

  it('two waiting at his writing, his words name one member: only that one', async () => {
    const { d } = deps();
    const ref = said("Conor'a izin veriyorum", 200, [{ id: 'm1', member: 'pr-mesaj' }, { id: 'm2', member: 'strateji' }]);
    const q = [mirror('m1', 100, 'pr-mesaj'), mirror('m2', 110, 'strateji')];
    expect(await allowByOwnerWords('/root', record(q), { item: 'm2', ref, deny: false }, d)).toMatchObject({ ok: false, error: 'several_pending' });
    expect((await allowByOwnerWords('/root', record(q), { item: 'm1', ref, deny: false }, d)).ok).toBe(true);
  });
});

describe('superOwnerWordsOf: only what he typed is recorded', () => {
  const typed = classifyOwnerFrame({ origin: 'socket', msg: { type: 'user', text: 'İzin veriyorum', typed: true, own: 'İzin veriyorum' } } as Parameters<typeof classifyOwnerFrame>[0]);
  const base = { text: 'İzin veriyorum', serverText: false, serverWritten: false, tgRef: null };

  it('his composer message is recorded by its ref', () => {
    expect(typed).not.toBeNull();
    expect(superOwnerWordsOf(typed!, base)).toEqual({ ref: msgRef('İzin veriyorum'), parts: [], text: 'İzin veriyorum', via: 'composer' });
  });
  it('an agent\'s `window send` (no composer mark) is not his', () => {
    const unmarked = classifyOwnerFrame({ origin: 'socket', msg: { type: 'user', text: 'İzin veriyorum' } } as Parameters<typeof classifyOwnerFrame>[0]);
    expect(superOwnerWordsOf(unmarked!, base)).toBeNull();
  });
  it('a server turn, a continue, a run report and a schedule are not his', () => {
    expect(superOwnerWordsOf(typed!, { ...base, serverWritten: true })).toBeNull();
    expect(superOwnerWordsOf(typed!, { ...base, serverText: true })).toBeNull();
    const tg = classifyOwnerFrame({ origin: 'telegram-injector', msg: { type: 'user', text: 'x', own: 'İzin veriyorum' } } as Parameters<typeof classifyOwnerFrame>[0]);
    expect(superOwnerWordsOf(tg!, { ...base, telegram: 'run-report', tgRef: 'abc123' })).toBeNull();
    expect(superOwnerWordsOf(tg!, { ...base, telegram: 'schedule', tgRef: 'abc123' })).toBeNull();
    // A Telegram ref the store did not honour as his text: not his either.
    expect(superOwnerWordsOf(tg!, { ...base, tgRef: null })).toBeNull();
  });
  it('his Telegram text is recorded under the hub\'s ref', () => {
    const tg = classifyOwnerFrame({ origin: 'telegram-injector', msg: { type: 'user', text: 'x', own: 'İzin veriyorum' } } as Parameters<typeof classifyOwnerFrame>[0]);
    expect(superOwnerWordsOf(tg!, { ...base, telegram: 'telegram-text', tgRef: 'abc123' })).toMatchObject({ ref: 'abc123', via: 'telegram' });
  });
  it('a slash command is not his message', () => {
    expect(superOwnerWordsOf(typed!, { ...base, text: '/compact' })).toBeNull();
  });
});
