/**
 * A member's answer to the Super Agent shows once (plan r4 E2-E4):
 *  - `super team done <item> "<result>"` is read through the manifest-derived parse, and renders as
 *    one quiet line "Super Agent'a cevap verildi" with the answer as a quote; the command and its
 *    JSON only behind "ayrıntı";
 *  - the member's closing text is hidden only when it equals or is contained in the answer; a text
 *    that adds anything is kept; an owner message ends the turn;
 *  - main's request is a quote titled "Super Agent'tan".
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizedAnswer, teamDoneRepeats, teamDoneText } from '../../dashboard/src/components/sleepy/chat/dreamCommand.js';

const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');
const done = (id: string, text: string) => ({ kind: 'tool', id, name: 'Bash', input: { command: `dreamcontext super team done q-1 "${text}"` } });
const say = (id: string, text: string) => ({ kind: 'text', id, text });

describe('the answer to the Super Agent', () => {
  it('reads `super team done` through the manifest parse, and nothing else', () => {
    expect(teamDoneText('dreamcontext super team done q-mw0 "Aleykümselam Mehmet, Pacioli gelir tarafında hazır."')).toBe('Aleykümselam Mehmet, Pacioli gelir tarafında hazır.');
    expect(teamDoneText('dreamcontext super team ask rota "do it"')).toBeNull();
    expect(teamDoneText('echo super team done q "x"')).toBeNull();
  });

  it('hides a closing text that equals or is inside the answer; keeps one that adds anything', () => {
    const items = [
      { kind: 'user', id: 'u1', text: 'req' },
      done('t1', 'Aleykümselam Mehmet, Pacioli gelir tarafında hazır.'),
      say('a1', 'aleykümselam mehmet pacioli gelir tarafında hazır'),
      say('a2', 'Pacioli gelir tarafında hazır'),
      say('a3', 'Aleykümselam Mehmet, Pacioli gelir tarafında hazır. Bir de raporu yarın atarım.'),
      { kind: 'user', id: 'u2', text: 'selam' },
      say('a4', 'Pacioli gelir tarafında hazır'),
    ];
    expect([...teamDoneRepeats(items)]).toEqual(['a1', 'a2']);
    expect(normalizedAnswer('İçerik, HAZIR!')).toBe('içerik hazır');
  });

  it('the row is one quiet line and a quote; the command only behind its expand; the request is a quote', () => {
    const card = src('dashboard/src/components/sleepy/chat/DreamActionCard.tsx');
    expect(card).toContain("primary.path === 'super team done'");
    expect(card).toContain("t('superStage.member.answeredSuper')");
    expect(card).toMatch(/\{open && <div className="chat-toolcard-body"><TerminalBlock command=\{command\} output=\{result\} \/><\/div>\}/);
    const pane = src('dashboard/src/components/sleepy/ChatPane.tsx');
    expect(pane).toMatch(/if \(item\.kind === 'text' && doneRepeats\.has\(item\.id\)\) return null;/);
    const i18n = src('dashboard/src/context/I18nContext.tsx');
    expect(i18n).toContain("'superStage.member.fromSuper': 'Super Agent\\'tan'");
    expect(i18n).toContain("'superStage.member.answeredSuper': 'Super Agent\\'a cevap verildi'");
  });
});
