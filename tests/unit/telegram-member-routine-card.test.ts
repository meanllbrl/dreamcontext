/** A member's routine approval on Telegram (super-v3 K10, Ü6): the bold lead line, then the automation's own card whole; member lines lead with the name in bold. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { memberLeadHtml, routineIsApproval } from '../../src/server/telegram/member-lines.js';

const asks = readFileSync(join(__dirname, '..', '..', 'src', 'server', 'telegram', 'asks.ts'), 'utf-8');

describe('member lines on Telegram', () => {
  it('the name is bold, the rest plain, both escaped and redacted', () => {
    expect(memberLeadHtml('Sage', 'bir rutin istiyor')).toBe('<b>Sage</b> bir rutin istiyor');
    expect(memberLeadHtml('<i>x</i>', 'a & b')).toBe('<b>&lt;i&gt;x&lt;/i&gt;</b> a &amp; b');
    expect(memberLeadHtml(null, 'Bir rutin onayını bekliyor')).toBe('Bir rutin onayını bekliyor');
    expect(memberLeadHtml('Sage', 'token sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).not.toContain('sk-ant-api03-AAAA');
  });
  it('only a routine to approve (new or changed) is an approval fact', () => {
    expect(routineIsApproval('not-approved:abc')).toBe(true);
    expect(routineIsApproval('change-pending:abc')).toBe(true);
    expect(routineIsApproval('q:123')).toBe(false);
    expect(routineIsApproval('denials:1')).toBe(false);
    expect(routineIsApproval(undefined)).toBe(false);
  });
});

describe('the routine approval goes out as its card', () => {
  it('lead line first, then sendAutomationCard from the item\'s slug (never its words)', () => {
    expect(asks).toContain("if (routineIsApproval(item.fact) && item.routine) {");
    expect(asks).toContain('await sendAutomationCard(hub, ab, item.routine, superSession).catch(() => false);');
    const at = asks.indexOf("if (routineIsApproval(item.fact) && item.routine) {");
    expect(asks.indexOf('const messages = await plain(hub, ab, [`✋ ${lead}`]);', at)).toBeLessThan(asks.indexOf('await sendAutomationCard(hub, ab, item.routine', at));
  });
  it('a member identity approval names the member in bold and stays on the Mac', () => {
    expect(asks).toContain("memberLeadHtml(who || 'Bir ekip üyesi', 'onayını bekliyor')");
  });
});
