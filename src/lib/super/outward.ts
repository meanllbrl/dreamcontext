import { MSG_REF_RE } from './types.js';

/**
 * A push, PR or deploy the owner's own message named (owner, 2026-11-12: "when HIS message names a
 * push, PR or deploy, the child does exactly that"). `step` is the Super's line for it, `ref` his
 * message, `words` that message as the Super's record kept it when the grant was checked (cut by
 * the server, so the child can hold the step against what he wrote).
 *
 * A grant lives with the job that carries it, never with the ledger it was checked against: the
 * pool row keeps it (a last wave starts hours later, after the message's debt has been trimmed),
 * and so does the child record (a `--succeeds` hand-over passes it on). Checked once, by the
 * route, against a message of his; read back here only as data.
 */
export interface OutwardGrant { step: string; ref: string; words?: string }

/** The longest `--outward` line, and the longest words kept beside it. */
export const MAX_OUTWARD = 300;

/** No control characters (the line is one line of a child's first message). */
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** A grant as a record holds it, or undefined for anything else (the record is local, but a
 *  hand-edited or older file never widens what a child is told). */
export function sanitizeOutward(raw: unknown): OutwardGrant | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.step !== 'string' || typeof r.ref !== 'string' || !MSG_REF_RE.test(r.ref)) return undefined;
  const step = r.step.trim();
  if (!step || step.length > MAX_OUTWARD || CONTROL_RE.test(step)) return undefined;
  const words = typeof r.words === 'string' && r.words.trim() && r.words.length <= MAX_OUTWARD + 1 && !CONTROL_RE.test(r.words) ? r.words.trim() : undefined;
  return { step, ref: r.ref, ...(words ? { words } : {}) };
}

const unquote = (s: string): string => s.replace(/[«»]/g, '"');

/**
 * The child's line for an outward step his message named: what the server checked (the ref is a
 * message of his, these are its words), the step, the limits, and a refused or failed command
 * going to him as a run card, never around the refusal. One line (team-roster's SERVER_LINE_RE
 * strips it from the owner's words).
 */
export function outwardLine(o: OutwardGrant): string {
  const cut = !!o.words && o.words.endsWith('…');
  const words = o.words ? ` His words${cut ? ' (their first 300 characters)' : ''}: «${unquote(o.words)}».` : '';
  return `The server checked that ref ${o.ref} is the owner's own message; the Super passed on this outward step from it, and you may run exactly it: «${unquote(o.step)}».${words} `
    + 'Nothing wider: no other remote, branch, environment or target. If his words plainly contradict the step, do not run it: ask. '
    + 'Never force-push (--force, --force-with-lease, -f, a +refspec) and never merge into the default branch (locally, by `gh pr merge` or by pushing onto it). '
    + 'If a permission check refuses the command, or it cannot reach the network, never work around it: leave him a `dream-view` run card with that exact command, and say so in your report.';
}
