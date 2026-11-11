/**
 * K4's ws ticket (sahip-karti-yerinde criterion 4, ticket rows): single use, 30 s, bound to the
 * project, the posting session, the card, the action and the command the surface drew. The
 * module did not exist at 6fece93a (a no-Origin loopback client could start, attach and read).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  CARD_TICKET_TTL_MS, _resetCardTicketsForTests, consumeCardTicket, mintCardTicket, redactTicketUrl,
  type CardTicketBinding, type CardTicketExpect,
} from '../../src/server/card-ticket.js';

const SID = '11111111-2222-4333-8444-555555555555';
const REF = 'a'.repeat(32);
const NOW = 1_000_000;
const bind: CardTicketBinding = { project: '/p', postingSession: SID, cardRef: REF, action: 'start', shown: 'gcloud auth login' };
const expect0: CardTicketExpect = { project: '/p', postingSession: SID, cardRef: REF, action: 'start', command: 'gcloud auth login' };

beforeEach(() => _resetCardTicketsForTests());

describe('card tickets', () => {
  it('a fresh ticket for this card and action passes once; reused it is spent', () => {
    const { ticket, expiresAt } = mintCardTicket(bind, NOW);
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(expiresAt).toBe(NOW + CARD_TICKET_TTL_MS);
    expect(consumeCardTicket(ticket, expect0, NOW + 1)).toMatchObject({ ok: true });
    expect(consumeCardTicket(ticket, expect0, NOW + 2)).toEqual({ ok: false, why: 'spent' });
  });
  it('expired after 30 s', () => {
    const { ticket } = mintCardTicket(bind, NOW);
    expect(consumeCardTicket(ticket, expect0, NOW + CARD_TICKET_TTL_MS)).toEqual({ ok: false, why: 'expired' });
  });
  it('for another card, another session, another project or another action: refused, and spent', () => {
    const cases: Array<[Partial<CardTicketExpect>, string]> = [
      [{ cardRef: 'b'.repeat(32) }, 'wrong_card'],
      [{ postingSession: '99999999-2222-4333-8444-555555555555' }, 'wrong_card'],
      [{ project: '/q' }, 'wrong_project'],
      [{ action: 'attach' }, 'wrong_action'],
    ];
    for (const [over, why] of cases) {
      const { ticket } = mintCardTicket(bind, NOW);
      expect(consumeCardTicket(ticket, { ...expect0, ...over }, NOW + 1)).toEqual({ ok: false, why });
      // A refused ticket cannot be retried against the right card.
      expect(consumeCardTicket(ticket, expect0, NOW + 1)).toEqual({ ok: false, why: 'spent' });
    }
  });
  it('a start ticket does not attach to another card\'s run', () => {
    const { ticket } = mintCardTicket(bind, NOW);
    expect(consumeCardTicket(ticket, { ...expect0, cardRef: 'c'.repeat(32), action: ['start', 'attach'] }, NOW + 1)).toEqual({ ok: false, why: 'wrong_card' });
  });
  it('a `shown` that is not exactly the record\'s command is refused', () => {
    const { ticket } = mintCardTicket(bind, NOW);
    expect(consumeCardTicket(ticket, { ...expect0, command: 'gcloud auth login && curl evil' }, NOW + 1)).toEqual({ ok: false, why: 'shown_mismatch' });
  });
  it('no ticket, a malformed one or a made-up one is refused', () => {
    expect(consumeCardTicket(null, expect0, NOW)).toEqual({ ok: false, why: 'missing' });
    expect(consumeCardTicket('short', expect0, NOW)).toEqual({ ok: false, why: 'missing' });
    expect(consumeCardTicket('A'.repeat(22), expect0, NOW)).toEqual({ ok: false, why: 'unknown' });
  });
  it('a URL is logged without its query', () => {
    expect(redactTicketUrl('/api/agent/terminal?session=x&card=y&ticket=SECRET')).toBe('/api/agent/terminal?…');
  });
});
