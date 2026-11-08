/**
 * The foot of the phone's drawer is one short row. What takes the owner's tap stays open: the
 * turn-on button, and the address warning while notifications need turning on.
 */
import { describe, it, expect, vi } from 'vitest';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.js';

let push = { state: 'on', quick: true, busy: false, failed: false, turnOn: async () => {} };
vi.mock('../../dashboard/src/context/I18nContext.js', () => ({ useI18n: () => ({ t: (k: string) => k }) }));
vi.mock('../../dashboard/src/context/VaultContext.js', () => ({ useApi: () => ({}) }));
vi.mock('../../dashboard/src/components/handsfree/phone/PushOptIn.js', () => ({ usePushOptIn: () => push }));
const { PhoneDrawerFoot } = await import('../../dashboard/src/components/handsfree/phone/PhoneDrawerFoot.js');
const foot = (over: Partial<typeof push>) => { push = { ...push, ...over }; return renderToStaticMarkup(createElement(PhoneDrawerFoot)); };

describe('the drawer foot', () => {
  it('on: a status and Send log; the long words are not on screen', () => {
    const html = foot({ state: 'on', quick: true, failed: false });
    expect(html).toContain('handsfree.push.statusOn');
    expect(html).toContain('handsfree.phoneLog.short');
    expect(html).not.toContain('push-enable');
    expect(html).not.toContain('push-quick-note');
    expect(html).not.toContain('handsfree.phoneLog.sub');
  });

  it('off on a changing address: the button and the warning are open', () => {
    const html = foot({ state: 'off', quick: true, failed: false });
    expect(html).toContain('data-testid="push-enable"');
    expect(html).toContain('data-testid="push-quick-note"');
    expect(html).toContain('data-testid="drawer-foot-more"');
  });

  it('off on a fixed address: the button, no warning; a failure says so', () => {
    expect(foot({ state: 'off', quick: false })).not.toContain('push-quick-note');
    expect(foot({ state: 'off', quick: false, failed: true })).toContain('handsfree.push.failed');
  });

  it('an iPhone on a changing address: the reason stands open, there is nothing to tap', () => {
    const html = foot({ state: 'quick', quick: true, failed: false });
    expect(html).toContain('handsfree.push.needsFixed');
    expect(html).toContain('handsfree.push.statusOff');
    expect(html).not.toContain('push-enable');
  });

  it('a phone with no web push still has the log and its explanation', () => {
    const html = foot({ state: 'hidden', quick: false, failed: false });
    expect(html).toContain('data-testid="phone-log-send"');
    expect(html).toContain('data-testid="drawer-foot-more"');
    expect(html).not.toContain('push.status');
  });
});
