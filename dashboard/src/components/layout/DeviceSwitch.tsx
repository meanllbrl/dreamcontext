import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useI18n } from '../../context/I18nContext';
import { DEVICE_WIDTH, WEB_DEVICES, deviceFit, type WebDevice } from '../../lib/webDevice';

const ICON: Record<WebDevice, ReactNode> = {
  phone: <rect x="5" y="1.5" width="6" height="13" rx="1.5" />,
  tablet: <rect x="2.5" y="1.5" width="11" height="13" rx="1.5" />,
  desktop: <><rect x="1" y="2" width="14" height="9" rx="1" /><path d="M5.5 14h5M8 11v3" /></>,
};

/**
 * Phone / tablet / desktop for a web page (lib/webDevice.ts), drawn with the bar it sits in
 * (`btnClass`: the card's zoom bar or the full-screen viewer's). The pressed one again returns
 * the page to its box's own width.
 */
export function DeviceSwitch({ device, onChange, btnClass }: {
  device: WebDevice | null; onChange: (d: WebDevice | null) => void; btnClass: string;
}) {
  const { t } = useI18n();
  return (
    <>
      {WEB_DEVICES.map((d) => {
        const label = `${t(`webDevice.${d}`)} · ${DEVICE_WIDTH[d]} px`;
        const on = device === d;
        return (
          <button key={d} type="button" className={`${btnClass} web-device-btn`} aria-pressed={on}
            onClick={() => onChange(on ? null : d)} aria-label={label} title={on ? `${label} · ${t('webDevice.off')}` : label}
            data-testid={`web-device-${d}`}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{ICON[d]}</svg>
          </button>
        );
      })}
    </>
  );
}

/**
 * The box a web page's frame sits in: with a device, the frame is laid out at that width and
 * the box's height (in the device's px), scaled to fit and centred; without one it fills the box.
 * Only the frame's style changes, so switching never reloads the page.
 */
export function useDeviceBox(device: WebDevice | null) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const fit = deviceFit(device, box);
  const frameStyle: CSSProperties | undefined = fit && box ? {
    position: 'absolute',
    top: 0,
    left: Math.max(0, (box.w - fit.w * fit.scale) / 2),
    width: fit.w,
    height: fit.h,
    transform: `scale(${fit.scale})`,
    transformOrigin: '0 0',
  } : undefined;
  return { ref, fit, frameStyle };
}
