/**
 * The checklist relay's half of gate G1 (sahip-karti-yerinde K4, criterion 4's checklist rows,
 * criterion 8 "the checklist's submit goes through the vault window by record").
 *
 * The checklist window holds no owner key, so the vault window relays its submit. It does so ONLY
 * with the single-use nonce it minted for that open (`openChecklistWindow` → `#n=`), spent
 * synchronously the first time it is seen, before any await. An `emitTo(vault-*, checklist-submit)`
 * from any other frame (no nonce, a wrong one, a spent one) sends NOTHING to the server; after a
 * real submit that failed, the same nonce with other content sends nothing either.
 * Fictional project, checklist and session (synthetic-fixtures pattern).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  _resetChecklistNonces, checklistNonceFromHash, mintChecklistNonce, spendChecklistNonce,
} from '../../dashboard/src/lib/desktop.js';
import { relayChecklistSubmit, type ChecklistRelayDeps } from '../../dashboard/src/lib/checklistBridge.js';
import type { ChecklistViewSpec } from '../../dashboard/src/lib/chatViewSpec.js';

const VAULT = 'acme-shop';
const SID = '11111111-2222-4333-8444-555555555555';
const CARD = 'c'.repeat(32);
const SPEC: ChecklistViewSpec = {
  type: 'checklist', id: 'store-setup', title: 'Store setup',
  items: [{ id: 'a', text: 'Create the app record' }, { id: 'k', text: 'Paste the API key', wants: 'secret' }],
} as ChecklistViewSpec;
const STATE = { checked: { a: true }, notes: {}, files: {} };

function deps(over: Partial<{ ok: boolean; outcome: string; chat: boolean }> = {}) {
  const posted: Array<{ session: string; card: string; state: unknown; secrets: unknown }> = [];
  const chat: Array<{ to: string; markdown: string }> = [];
  const d: ChecklistRelayDeps = {
    spend: spendChecklistNonce,
    submitRecord: async (b) => { posted.push(b); return { ok: over.ok ?? true, ...(over.outcome ? { outcome: over.outcome } : {}) }; },
    postToChat: (to, markdown) => { chat.push({ to, markdown }); return over.chat ?? true; },
  };
  return { d, posted, chat };
}

const payload = (nonce: unknown, extra: Record<string, unknown> = {}) => ({
  vault: VAULT, conversationId: SID, checklistId: SPEC.id, nonce, state: STATE, secrets: { k: 'sk_test_fake_value' }, ...extra,
});

beforeEach(() => _resetChecklistNonces());

describe('the vault window relays a checklist submit only with its own nonce', () => {
  it('the real checklist window submit goes through, routed by record, with structured state and no markdown', async () => {
    const n = mintChecklistNonce(VAULT, SPEC.id, { postingSession: SID, cardRef: CARD, spec: SPEC });
    const { d, posted, chat } = deps({ outcome: 'delivered' });
    expect(await relayChecklistSubmit(payload(n), d)).toBe(true);
    expect(posted).toEqual([{ session: SID, card: CARD, state: STATE, secrets: { k: 'sk_test_fake_value' } }]);
    expect(JSON.stringify(posted)).not.toContain('Checklist:');
    expect(chat).toEqual([]);
  });

  it('no nonce sends nothing (another frame: a web card, the viewer)', async () => {
    mintChecklistNonce(VAULT, SPEC.id, { postingSession: SID, cardRef: CARD, spec: SPEC });
    const { d, posted, chat } = deps();
    expect(await relayChecklistSubmit(payload(undefined), d)).toBe(false);
    expect(await relayChecklistSubmit(payload(''), d)).toBe(false);
    expect(posted).toEqual([]);
    expect(chat).toEqual([]);
  });

  it('a wrong nonce sends nothing', async () => {
    const n = mintChecklistNonce(VAULT, SPEC.id, { postingSession: SID, cardRef: CARD, spec: SPEC });
    const { d, posted } = deps();
    const wrong = n.slice(0, -1) + (n.endsWith('0') ? '1' : '0');
    expect(await relayChecklistSubmit(payload(wrong), d)).toBe(false);
    expect(posted).toEqual([]);
  });

  it('a spent nonce sends nothing (single use)', async () => {
    const n = mintChecklistNonce(VAULT, SPEC.id, { postingSession: SID, cardRef: CARD, spec: SPEC });
    const { d, posted } = deps();
    expect(await relayChecklistSubmit(payload(n), d)).toBe(true);
    expect(await relayChecklistSubmit(payload(n), d)).toBe(false);
    expect(posted).toHaveLength(1);
  });

  it('after a real submit that FAILED, the same nonce with other content sends nothing', async () => {
    const n = mintChecklistNonce(VAULT, SPEC.id, { postingSession: SID, cardRef: CARD, spec: SPEC });
    const failing = deps({ ok: false });
    expect(await relayChecklistSubmit(payload(n), failing.d)).toBe(false);
    expect(failing.posted).toHaveLength(1);
    const again = deps();
    expect(await relayChecklistSubmit(payload(n, { state: { checked: { a: false }, notes: { a: 'other' }, files: {} } }), again.d)).toBe(false);
    expect(again.posted).toEqual([]);
  });

  it('the nonce is spent synchronously, before the first await', () => {
    const n = mintChecklistNonce(VAULT, SPEC.id, { postingSession: SID, cardRef: CARD, spec: SPEC });
    const { d } = deps();
    void relayChecklistSubmit(payload(n), d);
    // No await yet: a second frame that heard the same event already finds it spent.
    expect(spendChecklistNonce(VAULT, SPEC.id, n)).toBeNull();
  });

  it('a body carrying finished markdown is refused, and its nonce is gone', async () => {
    const n = mintChecklistNonce(VAULT, SPEC.id, { postingSession: SID, cardRef: CARD, spec: SPEC });
    const { d, posted } = deps();
    expect(await relayChecklistSubmit(payload(n, { markdown: 'Checklist: Store setup — 2 of 2 done.' }), d)).toBe(false);
    expect(posted).toEqual([]);
    expect(spendChecklistNonce(VAULT, SPEC.id, n)).toBeNull();
  });

  it('every open mints a fresh nonce and revokes the one before it', async () => {
    const first = mintChecklistNonce(VAULT, SPEC.id, { postingSession: SID, cardRef: CARD, spec: SPEC });
    const second = mintChecklistNonce(VAULT, SPEC.id, { postingSession: SID, cardRef: CARD, spec: SPEC });
    expect(second).not.toBe(first);
    const { d, posted } = deps();
    expect(await relayChecklistSubmit(payload(first), d)).toBe(false);
    expect(await relayChecklistSubmit(payload(second), d)).toBe(true);
    expect(posted).toHaveLength(1);
  });

  it('a nonce of another project or another checklist sends nothing', async () => {
    const n = mintChecklistNonce(VAULT, SPEC.id, { postingSession: SID, cardRef: CARD, spec: SPEC });
    const { d, posted } = deps();
    expect(await relayChecklistSubmit(payload(n, { vault: 'other-shop' }), d)).toBe(false);
    expect(await relayChecklistSubmit(payload(n, { checklistId: 'other' }), d)).toBe(false);
    expect(posted).toEqual([]);
  });

  it('not a crew card (`window`): the vault window posts the markdown it builds from the spec it drew', async () => {
    const n = mintChecklistNonce(VAULT, SPEC.id, { postingSession: SID, cardRef: CARD, spec: SPEC });
    const { d, chat } = deps({ outcome: 'window' });
    expect(await relayChecklistSubmit(payload(n), d)).toBe(true);
    expect(chat).toHaveLength(1);
    expect(chat[0].to).toBe(SID);
    expect(chat[0].markdown.startsWith('Checklist: Store setup — 1 of 2 done.')).toBe(true);
  });

  it('a chat card with no record posts into its chat (as at the base), still only with the nonce', async () => {
    const n = mintChecklistNonce(VAULT, SPEC.id, { postingSession: SID, spec: SPEC });
    const { d, posted, chat } = deps();
    expect(await relayChecklistSubmit(payload(n), d)).toBe(true);
    expect(posted).toEqual([]);
    expect(chat).toHaveLength(1);
  });

  it('the window reads its nonce from the URL fragment only', () => {
    expect(checklistNonceFromHash('#n=abc123')).toBe('abc123');
    expect(checklistNonceFromHash('')).toBeNull();
    expect(checklistNonceFromHash('#x=1')).toBeNull();
  });
});
