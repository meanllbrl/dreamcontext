// What the thermal governor shows (AC9-AC11): the phone payload parse, the chip, the CLI line,
// and the tr + en strings.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePhonePayload } from '../../dashboard/src/components/handsfree/phone/phoneState.js';
import { phoneChipView } from '../../dashboard/src/components/handsfree/phone/PhoneChip.js';
import { thermalLine } from '../../src/cli/commands/handsfree-mac.js';

const base = { mode: 'mac', battery: { percent: 80, charging: true }, sleepAllowed: false };

describe('the phone payload (AC9)', () => {
  it('carries thermal through, type-checked', () => {
    expect(parsePhonePayload({ ...base, thermal: { state: 'serious', slowed: 3 } })!.thermal).toEqual({ state: 'serious', slowed: 3 });
  });

  it('defaults to {state:null, slowed:0} when missing or malformed (an older server)', () => {
    expect(parsePhonePayload(base)!.thermal).toEqual({ state: null, slowed: 0 });
    expect(parsePhonePayload({ ...base, thermal: { state: 'toasty', slowed: '3' } })!.thermal).toEqual({ state: null, slowed: 0 });
    expect(parsePhonePayload({ ...base, thermal: { state: 'fair', slowed: -1 } })!.thermal).toEqual({ state: 'fair', slowed: 0 });
    expect(parsePhonePayload({ ...base, thermal: null })!.thermal).toEqual({ state: null, slowed: 0 });
  });

  it('is null for anything that is not a Mac payload', () => {
    expect(parsePhonePayload({ mode: 'cloud' })).toBeNull();
    expect(parsePhonePayload(null)).toBeNull();
  });
});

describe('the phone chip (AC10)', () => {
  const s = (over: object) => parsePhonePayload({ ...base, ...over })!;

  it('slowed > 0 → "cooling down", data-mac=warm', () => {
    expect(phoneChipView(s({ thermal: { state: 'fair', slowed: 2 } }))).toEqual({ mac: 'warm', key: 'handsfree.mac.chipWarm', pct: null });
  });

  it('a low battery (sleep allowed) keeps precedence over cooling down', () => {
    expect(phoneChipView(s({ sleepAllowed: true, thermal: { state: 'critical', slowed: 5 } }))).toMatchObject({ mac: 'low', key: 'handsfree.mac.chipLow' });
  });

  it('hot but nothing slowed yet, or cool: the usual chip', () => {
    expect(phoneChipView(s({ thermal: { state: 'fair', slowed: 0 } }))).toMatchObject({ mac: 'ok', key: 'handsfree.mac.chip' });
    expect(phoneChipView(s({ battery: { percent: 40, charging: false }, thermal: { state: 'nominal', slowed: 0 } }))).toEqual({ mac: 'ok', key: 'handsfree.mac.chipBattery', pct: 40 });
  });
});

describe('the phone chip: very hot and in the bag (heat task)', () => {
  const s = (over: object) => parsePhonePayload({ ...base, ...over })!;

  it('order: low battery > very hot > cooling > in the bag > battery', () => {
    expect(phoneChipView(s({ sleepAllowed: true, bagMode: true, thermal: { state: 'serious', slowed: 2 } }))).toMatchObject({ key: 'handsfree.mac.chipLow' });
    expect(phoneChipView(s({ bagMode: true, thermal: { state: 'serious', slowed: 2 } }))).toEqual({ mac: 'warm', key: 'handsfree.mac.chipHot', pct: null });
    expect(phoneChipView(s({ thermal: { state: 'critical', slowed: 0 } }))).toEqual({ mac: 'warm', key: 'handsfree.mac.chipHot', pct: null });
    expect(phoneChipView(s({ bagMode: true, thermal: { state: 'fair', slowed: 1 } }))).toMatchObject({ key: 'handsfree.mac.chipWarm' });
    expect(phoneChipView(s({ bagMode: true, battery: { percent: 40, charging: false }, thermal: { state: 'nominal', slowed: 0 } }))).toEqual({ mac: 'ok', key: 'handsfree.mac.chipBag', pct: null });
  });

  it('tr + en carry every new key', () => {
    const src = readFileSync(join(__dirname, '../../dashboard/src/context/I18nContext.tsx'), 'utf8');
    for (const key of ['bagHint', 'bagNote', 'heatLine', 'chipHot', 'chipBag', 'phoneBagNote', 'ok']) {
      expect(src.split(`'handsfree.mac.${key}':`).length - 1, key).toBe(2);
    }
    expect(src).toContain("'handsfree.mac.heatLine': 'Mac got very hot · heavy steps run one at a time'");
    expect(src).toContain("'handsfree.mac.chipBag': 'Mac · çantada'");
  });
});

describe('the CLI status line (AC11)', () => {
  it('thermal: nominal / thermal: serious, N slowed', () => {
    expect(thermalLine({ thermal: { state: 'nominal', slowed: 0 } })).toBe('thermal: nominal');
    expect(thermalLine({ thermal: { state: 'serious', slowed: 6 } })).toBe('thermal: serious, 6 slowed');
    expect(thermalLine({ thermal: { state: null, slowed: 0 } })).toBe('thermal: not read yet');
  });
});

describe('the strings (AC10)', () => {
  it('tr + en carry the chip and the panel line', () => {
    const src = readFileSync(join(__dirname, '../../dashboard/src/context/I18nContext.tsx'), 'utf8');
    expect(src).toContain("'handsfree.mac.chipWarm': 'Mac serinletiliyor'");
    expect(src).toContain("'handsfree.mac.thermalSlowed': 'Mac ısındı · {n} iş yavaşlatıldı'");
    expect(src).toContain("'handsfree.mac.chipWarm': 'Mac cooling down'");
    expect(src).toContain("'handsfree.mac.thermalSlowed': 'Mac got hot · {n} heavy jobs slowed down'");
  });

  it('tr + en carry the bag-mode switch', () => {
    const src = readFileSync(join(__dirname, '../../dashboard/src/context/I18nContext.tsx'), 'utf8');
    for (const line of [
      "'handsfree.mac.bag': 'Bag mode'",
      "'handsfree.mac.bagHint': 'Turn on if the lid goes shut in a bag.'",
      "'handsfree.mac.bagOn': 'Bag mode · heavy jobs slow down when the Mac gets hot. Return and start again to change it.'",
      "'handsfree.mac.bagOff': 'Normal mode · full performance, nothing is slowed. Return and start again to change it.'",
      "'handsfree.mac.bag': 'Çanta modu'",
      "'handsfree.mac.bagHint': 'Kapağı kapatıp çantaya koyacaksan aç.'",
      "'handsfree.mac.bagOn': 'Çanta modu · Mac ısınınca ağır işlemler yavaşlar. Değiştirmek için dönüp yeniden başlat.'",
      "'handsfree.mac.bagOff': 'Normal mod · tam performans, hiçbir şey yavaşlatılmaz. Değiştirmek için dönüp yeniden başlat.'",
    ]) expect(src).toContain(line);
  });
});
