/**
 * The canned side of the eval's `dreamcontext` shim: what `dreamcontext super <verb>` answers
 * in the scratch vault, with no app behind it. Pure: the entry (dreamcontext.mjs) owns the
 * files. Plain .mjs so the shim starts in a few ms.
 */

export const MACHINES = {
  ok: { totalMemGb: 16, availMemGb: 9.2, diskFreeGb: 120, swapUsedGb: 2.1, swapTotalGb: 8, claudeSessions: 4, heavySteps: 0, load1: 1.4, notes: [] },
  // The owner's measurement of 2026-10-20: swap 18.5/21.5 GB, disk 6.7 GB, 1.9 GB free, 25 claude sessions.
  overloaded: {
    totalMemGb: 16, availMemGb: 1.9, diskFreeGb: 6.7, swapUsedGb: 18.5, swapTotalGb: 21.5, claudeSessions: 25, heavySteps: 2, load1: 9.8,
    notes: ['25 Claude processes are running on this machine (about 10 fit its RAM)', 'swap is 86 % full (line 75 %); removing worktrees or files frees disk, not memory', '6.7 GB disk free (line 8 GB)', '1.9 GB memory free (line 2 GB); removing worktrees or files frees disk, not memory'],
  },
};

export const MCP_SERVERS = ['whatsapp', 'apple-mail', 'fathom', 'posthog', 'slack'];

/** argv: everything after `dreamcontext` (starts with 'super'). */
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
 * @param {string[]} argv ['super', 'delegate', '--prompt', ...]
 * @param {{ machine: 'ok'|'overloaded', children?: Array<object>, counters: {child:number,pool:number,ask:number}, started: Array<object> }} ctx mutated
 * @returns {{ passthrough?: true, stdout?: string, stderr?: string, exit: number, held?: boolean }}
 */
export function handleSuper(argv, ctx) {
  const { words, opts } = parseOpts(argv.slice(1));
  if (opts.help === 'true' || opts.h === 'true' || words.length === 0 || words[0] === 'help') return { passthrough: true, exit: 0 };
  const verb = words[0];
  const sub = words[1];
  const json = (o) => ({ stdout: `${JSON.stringify(o, null, 2)}\n`, exit: 0 });
  const machine = MACHINES[ctx.machine] ?? MACHINES.ok;
  switch (verb) {
    case 'delegate': {
      // The machine never holds a delegate (owner, 2026-10-21): only the cap does, and the
      // eval never reaches it. An overloaded machine shows in `state` only.
      const id = `child-${++ctx.counters.child}`;
      ctx.started.push({ id, mode: opts.mode ?? 'basic', brief: opts.brief ?? '', worktree: opts.worktree ?? '', slug: opts.slug ?? '' });
      return json({ sessionId: id, status: 'started', ...(opts.worktree ? { worktree: `/scratch/${opts.worktree}-${opts.slug ?? id}`, branch: `super/${opts.slug ?? id}` } : {}) });
    }
    case 'pool':
      if (sub === 'add') return json({ ok: true, row: `pool-${++ctx.counters.pool}`, state: 'waiting' });
      if (sub === 'list') return json({ rows: [] });
      return json({ ok: true });
    case 'ask':
      return json({ ok: true, item: `q-${++ctx.counters.ask}`, state: 'open' });
    case 'state': {
      const children = [...(ctx.children ?? []), ...ctx.started.map((c) => ({ sessionId: c.id, status: 'working', brief: c.brief, lastLine: '' }))];
      return json({
        handedOver: true, children, containers: [], queue: [], head: null,
        machine, mcpServers: MCP_SERVERS, limits: { maxChildren: 15 },
      });
    }
    case 'merge':
      return json({ ok: true, branch: `super/${opts.into ?? 'topic'}`, merged: words.slice(1) });
    case 'worktree':
      return json({ worktrees: [] });
    case 'queue':
      return json({ ok: true, items: [] });
    default:
      return json({ ok: true });
  }
}
