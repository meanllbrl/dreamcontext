import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { isMacPhoneSurface } from '../../../lib/phoneSurface';
import { registerServiceWorker } from './phoneState';

/**
 * The phone's notification opt-in (Mac mode), in the session drawer. iPhone web push needs the
 * app on the Home Screen, a fixed https address (a quick tunnel's changes every start, which an
 * installed app cannot follow) and a tap to grant permission, so the row says which step is next.
 * Any other phone browser (Android Chrome, Firefox) subscribes from a plain tab, so there the
 * button shows on a quick address too (owner, 2026-10-17, on Android: no notification ever came):
 * the subscription lives until Mac mode ends, which signs the phone out anyway, and the next
 * start asks once more.
 */

export type PushOptInState =
  | 'hidden'        // not the phone surface, or this browser has no web push at all
  | 'quick'         // an iPhone on a quick tunnel address: notifications need the fixed address
  | 'install'       // an iPhone browser tab: add to Home Screen first
  | 'off'           // push works here (the iPhone app, or any other phone browser), not subscribed yet: offer the button
  | 'on'            // subscribed on this device
  | 'blocked';      // the owner said no (iOS Settings or the browser's site settings to undo)

export interface PushEnv {
  phone: boolean;
  /** iPhone / iPad: web push only for a Home Screen app, on one stable origin. */
  ios: boolean;
  hostname: string;
  standalone: boolean;
  pushSupported: boolean;
  permission: 'default' | 'granted' | 'denied';
  subscribed: boolean;
}

/** Pure: which step the opt-in row shows. */
export function pushOptInState(e: PushEnv): PushOptInState {
  if (!e.phone) return 'hidden';
  const quick = isQuickAddress(e.hostname);
  if (e.ios) {
    if (quick) return 'quick';
    if (!e.standalone) return 'install';
  }
  // Not an iPhone and no web push (an in-app browser, say): a fixed address would not help.
  if (!e.pushSupported) return 'hidden';
  if (e.permission === 'denied') return 'blocked';
  return e.permission === 'granted' && e.subscribed ? 'on' : 'off';
}

/** A quick tunnel's address, new on every Mac mode start. */
export function isQuickAddress(hostname: string): boolean {
  return /\.trycloudflare\.com$/i.test(hostname);
}

function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  // iPadOS reports a Mac; a Mac has no touch points.
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isStandalone(): boolean {
  try {
    return window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
  } catch { return false; }
}

function pushSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration('/');
    return reg ? await reg.pushManager.getSubscription() : null;
  } catch { return null; }
}

/** The VAPID key the server signs with, as the bytes pushManager.subscribe wants. */
function keyBytes(b64u: string): Uint8Array {
  const b64 = b64u.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64u.length % 4)) % 4);
  const raw = atob(b64);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** Same bytes? (a subscription made for another VAPID key can never deliver) */
function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
}

/** This browser's subscription for the Mac's CURRENT key: one made for an older pair is replaced. */
async function subscriptionFor(reg: ServiceWorkerRegistration, publicKey: string): Promise<PushSubscription> {
  const want = keyBytes(publicKey);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options?.applicationServerKey, want)) {
    await sub.unsubscribe().catch(() => false);
    sub = null;
  }
  return sub ?? reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: want as BufferSource });
}

/** The Mac's copy of this device's subscription. Idempotent: the server keeps one per device. */
async function sendToMac(reg: ServiceWorkerRegistration): Promise<boolean> {
  const keyRes = await fetch('/api/handsfree/push/key', { credentials: 'same-origin', cache: 'no-store' });
  if (!keyRes.ok) return false;
  const { publicKey } = await keyRes.json() as { publicKey: string };
  const sub = await subscriptionFor(reg, publicKey);
  const put = await fetch('/api/handsfree/push/subscription', {
    method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sub.toJSON()),
  });
  return put.ok;
}

/** Turn notifications on: permission (a user gesture), the subscription, and the server copy. */
export async function enablePush(): Promise<'on' | 'blocked' | 'failed'> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'blocked' : 'failed';
  const reg = (await registerServiceWorker()) ?? (await navigator.serviceWorker.ready);
  return (await sendToMac(reg)) ? 'on' : 'failed';
}

/** On every start of the app: a browser that is already subscribed hands its subscription to the
 *  Mac again. The Mac drops it on Return, logout, a revoke and a new sign-in (a new device id), so
 *  "on" is only true once the Mac holds this device's copy; otherwise the row offers the button. */
export async function resyncPush(): Promise<boolean> {
  if (!pushSupported() || Notification.permission !== 'granted') return false;
  try {
    const reg = await navigator.serviceWorker.getRegistration('/');
    if (!reg || !(await reg.pushManager.getSubscription())) return false;
    return await sendToMac(reg);
  } catch { return false; }
}

export function PushOptIn() {
  const { t } = useI18n();
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    void (isMacPhoneSurface() ? resyncPush() : currentSubscription().then((s) => !!s))
      .then((on) => { if (live) setSubscribed(on); });
    return () => { live = false; };
  }, [tick]);

  const hostname = typeof location !== 'undefined' ? location.hostname : '';
  const state = pushOptInState({
    phone: isMacPhoneSurface(),
    ios: isIos(),
    hostname,
    standalone: isStandalone(),
    pushSupported: pushSupported(),
    permission: pushSupported() ? Notification.permission : 'default',
    subscribed,
  });

  const turnOn = useCallback(async () => {
    setBusy(true);
    setFailed(false);
    try {
      const out = await enablePush();
      if (out === 'failed') setFailed(true);
    } catch { setFailed(true); }
    setBusy(false);
    setTick((n) => n + 1);
  }, []);

  if (state === 'hidden') return null;
  return (
    <div className="mchat-push" data-testid="push-optin" data-state={state}>
      {state === 'quick' && <p className="mchat-push-note">{t('handsfree.push.needsFixed')}</p>}
      {state === 'install' && <p className="mchat-push-note">{t('handsfree.push.install')}</p>}
      {state === 'blocked' && <p className="mchat-push-note">{t('handsfree.push.blocked')}</p>}
      {state === 'on' && <p className="mchat-push-note">{t('handsfree.push.on')}</p>}
      {(state === 'on' || state === 'off') && isQuickAddress(hostname) && <p className="mchat-push-note" data-testid="push-quick-note">{t('handsfree.push.quickNote')}</p>}
      {state === 'off' && (
        <button type="button" className="mchat-push-btn" onClick={() => void turnOn()} disabled={busy} data-testid="push-enable">
          {busy ? t('handsfree.push.enabling') : t('handsfree.push.enable')}
        </button>
      )}
      {failed && <p className="mchat-push-note" role="alert">{t('handsfree.push.failed')}</p>}
    </div>
  );
}
