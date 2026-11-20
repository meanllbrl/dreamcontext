/** A member's answer arrives in the Super chat as a quote card (super-v3 Ü3), read from the server's own event lines. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { jobNameOf, memberAnswersOf } from '../../dashboard/src/components/sleepy/super/memberQuote.js';
import { wrapUntrusted } from '../../src/lib/assistant/autonomy.js';

const D = join(__dirname, '..', '..', 'dashboard', 'src', 'components', 'sleepy');
const pane = readFileSync(join(D, 'ChatPane.tsx'), 'utf-8');
const card = readFileSync(join(D, 'super', 'MemberQuoteCard.tsx'), 'utf-8');

const turn = [
  '[super events] 2 items',
  '- item=q1 team=team-a member=sage event=done awaited=owner status=done',
  wrapUntrusted('acme', 'Brief: Fiyat sayfası\nyıllık plan'),
  wrapUntrusted('acme', 'Answer: Yıllık planı 990 ₺ ile öne çıkar.\nYıllık kart solda <b>.'),
  '  (cut: the whole answer: `dreamcontext super read team-a`)',
  '- item=q2 team=team-b member=nova event=question status=asking',
  wrapUntrusted('acme', 'Question: Hangi dil?'),
  '- item=q3 team=team-c event=done moved-on',
].join('\n');

describe('member answers in an event turn', () => {
  it('reads each done or answer item with its brief and its whole fenced answer', () => {
    const got = memberAnswersOf(turn);
    expect(got).toEqual([{
      item: 'q1', team: 'team-a', member: 'sage', event: 'done', brief: 'Fiyat sayfası\nyıllık plan',
      answer: 'Yıllık planı 990 ₺ ile öne çıkar.\nYıllık kart solda <b>.', cut: true,
    }]);
  });
  it('a question, a moved-on item or plain prose draws no card', () => {
    expect(memberAnswersOf('Sage answered: 990')).toEqual([]);
    expect(memberAnswersOf('- item=q9 team=t member=Bad Slug event=done')).toEqual([]);
  });
  it('the job is the brief\'s first line', () => {
    expect(jobNameOf('Fiyat sayfası\nyıllık plan')).toBe('Fiyat sayfası');
  });
  it('the card sits under the turn\'s line, with Read full answer and Ask <name>', () => {
    expect(pane).toContain('const answers = memberAnswersOf(item.text);');
    expect(card).toContain('data-testid="member-quote-read"');
    expect(card).toContain("session.sendText(t('super.quote.askDraft').replace('{name}', name));");
  });
});
