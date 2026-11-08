/**
 * The phone's on-screen truth for push (hands-free W2 part 2): with the Sohbetler list gone a
 * chat is on screen only when the Chat page is up in the project in front, the window is shown
 * and no drawer covers it. Anything else may push, so a question to a chat behind the open drawer
 * reaches the lock screen.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chatOnScreen } from '../../dashboard/src/components/sleepy/chatOnScreen.js';

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const shown = { expanded: true, active: true, drawerVisible: false, visible: true };

describe('chatOnScreen', () => {
  it('the chat shown, nothing over it: on screen', () => {
    expect(chatOnScreen(shown)).toBe(true);
  });

  it('the drawer open over it: not on screen (a question pushes)', () => {
    expect(chatOnScreen({ ...shown, drawerVisible: true })).toBe(false);
  });

  it('another page navigated to: not on screen', () => {
    expect(chatOnScreen({ ...shown, expanded: false })).toBe(false);
  });

  it('an inactive project: not on screen', () => {
    expect(chatOnScreen({ ...shown, active: false })).toBe(false);
  });

  it('the window hidden: not on screen', () => {
    expect(chatOnScreen({ ...shown, visible: false })).toBe(false);
  });
});

describe('the surface reads it, and only it', () => {
  const surface = read('dashboard/src/components/sleepy/AgentSurface.tsx');

  it('the phone\'s on-screen chat, the swipe and the toast all hang off one chatOnScreen read', () => {
    expect(surface).toMatch(/const phoneChatShown = macPhone && chatOnScreen\(\{ expanded, active: isActive, drawerVisible: stageBesideDrawer, visible: !windowActivity\.hidden \}\);/);
    expect(surface).toContain("const onScreenChatId = phoneChatShown ? (mobileActive?.id ?? '') : '';");
    expect(surface).toContain('const phoneChatOn = phoneChatShown;');
    // A chat told it is not on screen is free to push (ChatSession.setOnScreen).
    expect(surface).toMatch(/\(s as ChatSession\)\.setOnScreen\(id === onScreenChatId\)/);
  });

  it('no list-or-chat view, escape hatch or surface drawer is left', () => {
    for (const gone of ['phoneView', 'setPhoneView', 'phoneNav', 'mobileEscaped', 'setDrawerOpen', 'data-phone-nav', 'dataset.mobileChat', 'phoneChatMark']) {
      expect(surface).not.toContain(gone);
    }
  });
});
