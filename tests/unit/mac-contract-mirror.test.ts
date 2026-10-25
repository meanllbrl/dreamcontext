// The dashboard's copy of the Mac-mode contract equals src/lib/handsfree/mac/contract.ts.
import { describe, it, expect } from 'vitest';
import * as server from '../../src/lib/handsfree/mac/contract.js';
import * as dash from '../../dashboard/src/components/handsfree/macContract.js';

describe('mac contract mirror', () => {
  it('close codes, reattach values, the probe budget and the routes agree', () => {
    expect(dash.MAC_CLOSE_SIGNED_OUT).toBe(server.MAC_CLOSE_SIGNED_OUT);
    expect(dash.MAC_CLOSE_TAKEN_OVER).toBe(server.MAC_CLOSE_TAKEN_OVER);
    expect(dash.REATTACH_EVICT).toBe(server.REATTACH_EVICT);
    expect(dash.REATTACH_PASSIVE).toBe(server.REATTACH_PASSIVE);
    expect(dash.HOLDER_PROBE_MS).toBe(server.HOLDER_PROBE_MS);
    expect(dash.MAC_ROUTES).toEqual(server.MAC_ROUTES);
  });

  it('the thermal governor constants and state list agree', () => {
    expect(dash.MAC_THERMAL_POLL_MS).toBe(server.MAC_THERMAL_POLL_MS);
    expect(dash.MAC_THERMAL_RELEASE_TICKS).toBe(server.MAC_THERMAL_RELEASE_TICKS);
    expect(dash.MAC_THERMAL_STATES).toEqual(server.MAC_THERMAL_STATES);
    expect(server.MAC_THERMAL_POLL_MS).toBe(20_000);
    expect(server.MAC_THERMAL_RELEASE_TICKS).toBe(6);
  });

  it('the very-hot states agree, and the phone payload carries bagMode + startedAt (an old one parses with defaults)', async () => {
    expect(dash.HEAT_HOT).toEqual(server.HEAT_HOT);
    expect(server.HEAT_HOT).toEqual(['serious', 'critical']);
    const { parsePhonePayload } = await import('../../dashboard/src/components/handsfree/phone/phoneState.js');
    const wire: server.MacPhonePayload = { mode: 'mac', battery: { percent: 80, charging: false }, sleepAllowed: false, thermal: { state: 'serious', slowed: 0 }, bagMode: true, startedAt: '2026-10-24T20:00:00.000Z' };
    const asDash: dash.MacPhonePayload = wire;
    expect(parsePhonePayload(asDash)).toMatchObject({ bagMode: true, startedAt: '2026-10-24T20:00:00.000Z', thermal: { state: 'serious' } });
    expect(parsePhonePayload({ mode: 'mac', battery: { percent: 80, charging: true }, sleepAllowed: false, thermal: { state: 'fair', slowed: 1 } })).toMatchObject({ bagMode: false, startedAt: null });
  });

  it('the Bag mode default agrees (never chosen = on)', () => {
    expect(dash.MAC_BAG_MODE_DEFAULT).toBe(server.MAC_BAG_MODE_DEFAULT);
    expect(server.MAC_BAG_MODE_DEFAULT).toBe(true);
  });

  it('the passive probe stays well under the client connect timeout', async () => {
    const { CONNECT_TIMEOUT_MS } = await import('../../dashboard/src/components/sleepy/chatSession.js');
    expect(server.HOLDER_PROBE_MS * 3).toBeLessThanOrEqual(CONNECT_TIMEOUT_MS);
  });
});
