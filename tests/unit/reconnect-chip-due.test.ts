import { describe, it, expect } from 'vitest';
import { RECONNECT_CHIP_DELAY_MS, reconnectChipDue } from '../../dashboard/src/components/sleepy/chat/reconnectChip';

describe('reconnectChipDue', () => {
  it('says "Reconnecting…" only after 1.5 s of connecting', () => {
    expect(RECONNECT_CHIP_DELAY_MS).toBe(1500);
    expect(reconnectChipDue(1000, 1000)).toBe(false);
    expect(reconnectChipDue(1000, 2499)).toBe(false);
    expect(reconnectChipDue(1000, 2500)).toBe(true);
    expect(reconnectChipDue(1000, 60_000)).toBe(true);
  });
});
