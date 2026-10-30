/**
 * The canned side of the AI Team routing eval's `dreamcontext` shim: what `dreamcontext super
 * <verb>` answers in the scratch vault, with no app behind it. Pure: the entry owns the files.
 * `super team ask` is the verb under test: recorded, answered `running` for an approved member,
 * refused 409 `say_unapproved` for the one waiting on its approval (Atlas), 404 for no member.
 */

export function parseOpts(argv) {
  const words = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) { opts[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { opts[a.slice(2)] = next; i++; } else opts[a.slice(2)] = 'true';
    } else words.push(a);
  }
  return { words, opts };
}

/**
 * @param {string[]} argv ['super', 'team', 'ask', 'ledger', '...']
 * @param {{ members: Array<{slug:string,title:string,state:string,role:string}>, showMembers: boolean, counters: {child:number, team:number, ask:number} }} ctx mutated
 */
export function handleSuper(argv, ctx) {
  const { words, opts } = parseOpts(argv.slice(1));
  if (opts.help === 'true' || opts.h === 'true' || words.length === 0 || words[0] === 'help') return { passthrough: true, exit: 0 };
  const json = (o) => ({ stdout: `${JSON.stringify(o, null, 2)}\n`, exit: 0 });
  const refuse = (status, code, message) => ({ stderr: `${JSON.stringify({ error: code, status, message })}\n`, exit: 1 });
  const verb = words[0];
  switch (verb) {
    case 'team': {
      if (words[1] !== 'ask') return json({ ok: true });
      const slug = words[2] ?? '';
      const m = ctx.members.find((x) => x.slug === slug);
      if (!m) return refuse(404, 'unknown_member', `no AI Team member "${slug}" in this project (\`dreamcontext agents list\`)`);
      if (m.state === 'needs-approval') {
        return refuse(409, 'say_unapproved', `${m.title} is not approved on this machine yet. Approve it, then ask again. You cannot approve it: the owner does, in AI Team. His queue strip asks him now; give the job again once he says so.`);
      }
      if (m.state === 'off') return refuse(409, 'say_disabled', `${m.title} is turned off. Turn it on to call it.`);
      const job = `team-eval${++ctx.counters.team}`;
      return json({ job, member: slug, runId: '2026-10-29T10:00:00.000Z', queued: false, status: 'running' });
    }
    case 'delegate': {
      const id = `child-${++ctx.counters.child}`;
      return json({ sessionId: id, status: 'started', ...(opts.worktree ? { worktree: `/scratch/${opts.worktree}-${opts.slug ?? id}`, branch: `super/${opts.slug ?? id}` } : {}) });
    }
    case 'ask':
      return json({ ok: true, item: `q-${++ctx.counters.ask}`, state: 'open', reached: true });
    case 'state':
      return json({
        handedOver: true, children: [], containers: [], queue: [], head: null, team: [],
        ...(ctx.showMembers && ctx.members.length ? { members: ctx.members } : {}),
        limits: { maxChildren: 15 },
      });
    case 'read':
      return json({ team: words[1] ?? '', status: 'running', text: '(no answer yet)' });
    default:
      return json({ ok: true });
  }
}
