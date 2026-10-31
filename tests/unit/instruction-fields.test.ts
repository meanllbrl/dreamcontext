import { describe, it, expect } from 'vitest';
import { canonicalApprovalPayload } from '../../src/lib/automations/registry.js';
import type { AutomationManifest } from '../../src/lib/automations/types.js';
import { APPROVAL_DIFF_FIELDS } from '../../src/lib/automations/types.js';
import { HASHED_FIELD_SIDE, INSTRUCTION_FIELDS, isInstructionField } from '../../src/lib/agents/instruction-fields.js';

/** Which side a field sits on is a security decision: this test makes moving one a visible act. */
describe('the line between instruction and authority', () => {
  it('classifies every hashed field, and nothing else', () => {
    expect(Object.keys(HASHED_FIELD_SIDE).filter((f) => f !== 'mode').sort()).toEqual([...APPROVAL_DIFF_FIELDS].sort());
  });
  it('classifies everything the hash really covers: a new key fails here until someone picks a side', () => {
    const full = {
      prompt: 'p', outputInstructions: 'o', model: 'm', effort: 'high', timeoutMinutes: 5, outputDir: 'd', learning: true, review: 'output', mode: 'call',
      flow: { version: 1, nodes: [], edges: [] }, whiteboard: 'w', job: 'j', soul: 's', autonomy: 'free', readTools: ['mcp__x__read'],
    } as unknown as AutomationManifest;
    const hashed = Object.keys(JSON.parse(canonicalApprovalPayload(full).split('\n').slice(1).join('\n')) as object);
    for (const key of hashed) expect(Object.keys(HASHED_FIELD_SIDE), key).toContain(key);
  });
  it('lets an amendment reach exactly three fields', () => {
    expect([...INSTRUCTION_FIELDS].sort()).toEqual(['job', 'prompt', 'soul']);
  });
  it.each(['autonomy', 'outputDir', 'model', 'effort', 'timeoutMinutes', 'learning', 'review', 'flow', 'whiteboard', 'outputInstructions', 'readTools', 'schedule', 'shared', 'enabled', 'constructor', '__proto__', ''])(
    '%s is out of reach',
    (field) => { expect(isInstructionField(field)).toBe(false); },
  );
});
