/**
 * The one entry that decides which learned rules reach an agent (learning loop C6).
 *
 * The hook, the briefings and the evals call {@link deliverForTurn} for an owner turn, a child's
 * first prompt, a dispatch, a finished-work event and an act that cannot be taken back. W1 ships
 * it returning today's behaviour (nothing); W2 implements D4, D6, D7 and D16d here, and the memory
 * plan's W2 makes it call `knowledgeFor`. {@link jobText} is the text a turn is matched on.
 */
import { promptOwnerText } from './agents/team-roster.js';

export type DeliverySurface = 'owner' | 'child' | 'dispatch' | 'finished' | 'act' | 'machine';
export type DeliverInput = Record<string, unknown> & { surface: DeliverySurface };

export interface Delivery {
  /** Rules tagged `always` (what he reads), in short form. */
  always: string[];
  /** The moment lines (P1): hot and `report`/`ask` rules, "Before you answer him:". */
  moment: string[];
  /** Rules and pattern sections matched to the job text. */
  matched: string[];
  /** Characters of all three arrays as printed. */
  chars: number;
  /** How many rules and pattern cards were considered. */
  considered: number;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * The text a turn is matched on. W1: his own words for an owner turn, the Agent prompt for a
 * dispatch, the command line for an act; nothing for the rest (a child's brief is W2).
 */
export function jobText(input: DeliverInput): string {
  switch (input.surface) {
    case 'owner':
      return promptOwnerText(str(input.prompt)) ?? '';
    case 'dispatch': {
      const ti = (input.tool_input ?? {}) as Record<string, unknown>;
      return str(ti.prompt);
    }
    case 'act': {
      const ti = (input.tool_input ?? {}) as Record<string, unknown>;
      return str(ti.command) || str(input.tool_name);
    }
    default:
      return '';
  }
}

/** W1: today's behaviour, nothing is delivered. */
export function deliverForTurn(_root: string, _input: DeliverInput): Delivery {
  return { always: [], moment: [], matched: [], chars: 0, considered: 0 };
}
