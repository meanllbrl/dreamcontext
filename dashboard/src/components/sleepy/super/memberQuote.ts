/**
 * A member's answer inside a Super event turn (plan super-v3 Ü3): the server writes each team item
 * as its own line (`- item=<id> team=<job> member=<slug> event=done …`) followed by its fenced
 * Brief and Answer (src/lib/super/team.ts `teamItemLines`). The window reads them back to draw the
 * quote card; nothing here is the agent's prose, only the server's own lines.
 */

export interface MemberAnswer {
  item: string;
  team: string;
  member: string;
  /** `done` (its result) or `answer` (a note from a job that goes on). */
  event: 'done' | 'answer';
  brief: string;
  answer: string;
  /** The server cut the answer (`super read <team>` has it whole). */
  cut: boolean;
}

const HEAD = /^- item=(\S+) team=(\S+) member=(\S+) event=(\S+)/;
const FENCE = /<untrusted-project-output vault="[^"]*">([\s\S]*?)<\/untrusted-project-output>/y;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Every member answer of one event turn's text, in order. */
export function memberAnswersOf(text: string): MemberAnswer[] {
  const out: MemberAnswer[] = [];
  const lines = text.split('\n');
  let cur: MemberAnswer | null = null;
  const flush = () => { if (cur && cur.answer) out.push(cur); cur = null; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const head = HEAD.exec(line);
    if (head) {
      flush();
      const [, item, team, member, event] = head;
      if ((event === 'done' || event === 'answer') && SLUG.test(member) && !/ moved-on\b/.test(line)) {
        cur = { item, team, member, event, brief: '', answer: '', cut: false };
      }
      continue;
    }
    if (!cur) continue;
    // A fence may run over several lines: join until it closes.
    if (line.includes('<untrusted-project-output')) {
      let block = line;
      while (!block.includes('</untrusted-project-output>') && i + 1 < lines.length) block += `\n${lines[++i]}`;
      FENCE.lastIndex = block.indexOf('<untrusted-project-output');
      const m = FENCE.exec(block);
      const body = (m?.[1] ?? '').replace(/‹/g, '<');
      if (body.startsWith('Answer: ')) cur.answer = body.slice('Answer: '.length).trim();
      else if (body.startsWith('Brief: ')) cur.brief = body.slice('Brief: '.length).trim();
      continue;
    }
    if (/^\s+\(cut: /.test(line)) cur.cut = true;
  }
  flush();
  return out;
}

/** The job's name on the card: the brief's first line, cut at `max`. */
export function jobNameOf(brief: string, max = 60): string {
  const first = (brief.split('\n').find((l) => l.trim()) ?? '').replace(/\s+/g, ' ').trim();
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
}

/** The member's ONE card on the stage (Ü2): the team card standing on one of its jobs, or null.
 *  "Read full answer" opens it as the member's tab in the presentation window. */
export function memberCardOf(
  member: string,
  team: ReadonlyArray<{ id: string; member: string }>,
  containers: ReadonlyArray<{ id: string; kind: string; ref: string }>,
): string | null {
  const jobs = new Set(team.filter((j) => j.member === member).map((j) => j.id));
  return containers.find((c) => c.kind === 'team' && jobs.has(c.ref))?.id ?? null;
}
