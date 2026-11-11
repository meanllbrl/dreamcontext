/**
 * sahip-karti-yerinde W1 contracts: the server's owner-card shapes and their window mirror, the
 * two new queue kinds, and the stored card handle's re-validation.
 */
import { describe, it, expect } from 'vitest';
import * as server from '../../src/lib/super/types.js';
import * as client from '../../dashboard/src/lib/superTypes.js';
import { OWNER_CARD_KINDS } from '../../src/lib/super/owner-wait.js';
import { CARD_KINDS } from '../../src/lib/cards/public.js';
import { buildSubmitMarkdown as fromDashboard } from '../../dashboard/src/lib/checklistMarkdown.js';
import { buildSubmitMarkdown as fromServer } from '../../src/lib/checklist-markdown.js';

describe('owner-card types — server <-> window mirror', () => {
  it('every list matches, in order', () => {
    expect([...client.OWNER_CARD_KINDS]).toEqual([...OWNER_CARD_KINDS]);
    expect([...CARD_KINDS]).toEqual([...OWNER_CARD_KINDS]);
    expect([...client.OWNER_WAKE_OUTCOMES]).toEqual([...server.OWNER_WAKE_OUTCOMES]);
    expect([...client.OWNER_DELIVERY_STATES]).toEqual([...server.OWNER_DELIVERY_STATES]);
    expect([...client.OWNER_RECEIPT_VIEW_STATES]).toEqual([...server.OWNER_RECEIPT_VIEW_STATES]);
    expect([...client.CARD_TICKET_ACTIONS]).toEqual([...server.CARD_TICKET_ACTIONS]);
    expect(client.CARD_TICKET_TTL_MS).toBe(server.CARD_TICKET_TTL_MS);
    expect([...client.QUEUE_KINDS]).toEqual([...server.QUEUE_KINDS]);
  });
  it('the Super hears `parked` and `owner-result` as queue kinds (event=<kind>)', () => {
    expect(server.QUEUE_KINDS).toContain('parked');
    expect(server.QUEUE_KINDS).toContain('owner-result');
  });
  it('the dashboard checklist message is the server\'s own function', () => {
    expect(fromDashboard).toBe(fromServer);
  });
  it('every card kind has its Telegram sentence', () => {
    for (const k of OWNER_CARD_KINDS) expect(server.OWNER_CARD_TELEGRAM_LINE[k]).toMatch(/Mac/);
  });
});

describe('cleanOwnerCardHandle', () => {
  const good = {
    cardRef: 'a'.repeat(32), postingSession: '11111111-2222-4333-8444-555555555555', vault: 'acme',
    postingConversationId: '22222222-2222-4333-8444-555555555555',
    spec: { type: 'run', id: 'login', command: 'gcloud auth login' },
    childRecordId: 'm:writer', childId: '11111111-2222-4333-8444-555555555555', deliverTo: '11111111-2222-4333-8444-555555555555',
  };
  it('keeps a valid handle', () => {
    expect(server.cleanOwnerCardHandle(good)).toEqual(good);
  });
  it('drops a bad id, a non-card spec, an over-long command, a path in a child id', () => {
    expect(server.cleanOwnerCardHandle({ ...good, cardRef: 'x' })).toBeUndefined();
    expect(server.cleanOwnerCardHandle({ ...good, spec: { type: 'pin', id: 'p', weight: 'tag', facts: [] } })).toBeUndefined();
    expect(server.cleanOwnerCardHandle({ ...good, spec: { type: 'run', id: 'r', command: 'x'.repeat(5000) } })).toBeUndefined();
    expect(server.cleanOwnerCardHandle({ ...good, deliverTo: '../x' })).toBeUndefined();
    expect(server.cleanOwnerCardHandle({ ...good, childRecordId: 'other' })).toBeUndefined();
  });
  it('an owner-result fact keeps its outcome and caps its text', () => {
    expect(server.cleanOwnerResultFact({ card: 'run', cardRef: 'a'.repeat(32), outcome: 0, text: 'ok' })).toEqual({ card: 'run', cardRef: 'a'.repeat(32), outcome: 0, text: 'ok' });
    expect(server.cleanOwnerResultFact({ card: 'secret', cardRef: 'a'.repeat(32), outcome: 'submitted', text: 'x'.repeat(9000) })?.text).toHaveLength(server.MAX_OWNER_RESULT_TEXT);
    expect(server.cleanOwnerResultFact({ card: 'refusal', cardRef: 'a'.repeat(32), outcome: 0, text: '' })).toBeUndefined();
  });
});
