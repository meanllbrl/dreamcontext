/** One copy of a question (super-v3 D7): Show from a stage card scrolls the chat to it; scrolled away, one strip says it waits. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const D = join(__dirname, '..', '..', 'dashboard', 'src', 'components', 'sleepy');
const strip = readFileSync(join(D, 'super', 'QuestionStrip.tsx'), 'utf-8');
const pane = readFileSync(join(D, 'ChatPane.tsx'), 'utf-8');
const handover = readFileSync(join(D, 'super', 'superHandover.ts'), 'utf-8');

describe('the question lives in the chat once', () => {
  it('the chat listens for a stage card\'s Show and scrolls to that open card', () => {
    expect(strip).toContain('window.addEventListener(REVEAL_QUESTION_EVENT, on);');
    expect(strip).toContain("card.scrollIntoView({ block: 'center', behavior: 'smooth' });");
  });
  it('the strip shows only while an open question card is out of view, in the Mac Super chat', () => {
    expect(strip).toContain('setHidden(!seen);');
    expect(pane).toContain("<QuestionStrip scrollRef={scrollRef} enabled={session.mode === 'super' && !session.superMirror} />");
  });
  it('the stage band leaves permissions to the chat on the Mac (D8)', () => {
    expect(handover).toContain("bandItem(it) && (remote || !isMacPermissionCard(it))");
  });
});
