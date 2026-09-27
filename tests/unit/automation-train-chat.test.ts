import { describe, it, expect } from 'vitest';

/**
 * Train Me bound to an automated agent: the panel → surface bridge
 * (`dashboard/src/lib/automationRunChat.ts`) and the kickoff prompt that binds the new chat
 * to the automation (`dashboard/src/lib/agentPrompt.ts`).
 *
 * Same shape as `automation-run-chat.test.ts`: the bus is a plain `EventTarget` per test,
 * which IS the production object, not a stand-in.
 */

async function bridge() {
  return import('../../dashboard/src/lib/automationRunChat.js');
}
async function prompts() {
  return import('../../dashboard/src/lib/agentPrompt.js');
}

const ARGS = { slug: 'calbuddy-funnel-watch', automationTitle: 'CalBuddy Funnel Watch' };

describe('openTrainChat — the ACK', () => {
  it('dispatches slug + title on TRAIN_CHAT_EVENT, with accepted starting false', async () => {
    const { openTrainChat, TRAIN_CHAT_EVENT } = await bridge();
    const bus = new EventTarget();
    const seen: unknown[] = [];
    bus.addEventListener(TRAIN_CHAT_EVENT, (e) => {
      seen.push({ ...(e as CustomEvent).detail });
    });
    openTrainChat(bus, ARGS);
    expect(seen).toEqual([{ slug: ARGS.slug, automationTitle: ARGS.automationTitle, accepted: false }]);
  });

  it('returns false when no surface is listening', async () => {
    const { openTrainChat } = await bridge();
    expect(openTrainChat(new EventTarget(), ARGS)).toBe(false);
  });

  it('returns false when the listener refuses (leaves accepted alone)', async () => {
    const { openTrainChat, TRAIN_CHAT_EVENT } = await bridge();
    const bus = new EventTarget();
    bus.addEventListener(TRAIN_CHAT_EVENT, () => { /* guards rejected */ });
    expect(openTrainChat(bus, ARGS)).toBe(false);
  });

  it('returns true when the listener flips accepted', async () => {
    const { openTrainChat, TRAIN_CHAT_EVENT } = await bridge();
    const bus = new EventTarget();
    bus.addEventListener(TRAIN_CHAT_EVENT, (e) => {
      (e as CustomEvent<{ accepted?: boolean }>).detail.accepted = true;
    });
    expect(openTrainChat(bus, ARGS)).toBe(true);
  });

  it('is scoped to its bus: a listener on another project’s bus never sees it', async () => {
    const { openTrainChat, TRAIN_CHAT_EVENT } = await bridge();
    const mine = new EventTarget();
    const other = new EventTarget();
    let otherSaw = false;
    other.addEventListener(TRAIN_CHAT_EVENT, (e) => {
      otherSaw = true;
      (e as CustomEvent<{ accepted?: boolean }>).detail.accepted = true;
    });
    expect(openTrainChat(mine, ARGS)).toBe(false);
    expect(otherSaw).toBe(false);
  });
});

describe('trainTabTitle', () => {
  it('reads "Train · <title>"', async () => {
    const { trainTabTitle } = await bridge();
    expect(trainTabTitle('CalBuddy Funnel Watch')).toBe('Train · CalBuddy Funnel Watch');
  });

  it('clips a long title to 34 chars and keeps the prefix whole', async () => {
    const { trainTabTitle } = await bridge();
    const t = trainTabTitle('A very long automation title that will never fit a tab');
    expect(t.length).toBeLessThanOrEqual(34);
    expect(t.startsWith('Train · ')).toBe(true);
    expect(t.endsWith('…')).toBe(true);
  });

  it('falls back to a name when the title is blank', async () => {
    const { trainTabTitle } = await bridge();
    expect(trainTabTitle('   ')).toBe('Train · Automation');
  });
});

describe('trainKickoffPrompt', () => {
  it('binds the session to the automation and names its playbook', async () => {
    const { trainKickoffPrompt } = await prompts();
    const p = trainKickoffPrompt(ARGS.slug, ARGS.automationTitle);
    expect(p).toContain(ARGS.slug);
    expect(p).toContain(ARGS.automationTitle);
    expect(p).toContain('bound to');
    expect(p).toContain(`_dream_context/automations/${ARGS.slug}.md`);
    expect(p).toContain(`dreamcontext automations pattern ${ARGS.slug}`);
  });

  it('routes the result through automations learn --playbook-file, after a yes', async () => {
    const { trainKickoffPrompt } = await prompts();
    const p = trainKickoffPrompt(ARGS.slug, ARGS.automationTitle);
    expect(p).toContain(`dreamcontext automations learn ${ARGS.slug} --playbook-file`);
    expect(p).toMatch(/write nothing until I say yes/i);
  });

  it('never points the result at knowledge/patterns', async () => {
    const { trainKickoffPrompt } = await prompts();
    const p = trainKickoffPrompt(ARGS.slug, ARGS.automationTitle);
    expect(p).not.toContain('knowledge/patterns');
    expect(p).not.toContain('knowledge create');
    expect(p).not.toContain('kind:pattern');
  });

  it('is plain words: no em dashes, and short enough to inline', async () => {
    const { trainKickoffPrompt, promptFitsInline } = await prompts();
    const p = trainKickoffPrompt(ARGS.slug, ARGS.automationTitle);
    expect(p).not.toContain('—');
    expect(promptFitsInline(p)).toBe(true);
  });
});
