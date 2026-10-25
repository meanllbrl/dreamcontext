import { useI18n } from '../../context/I18nContext';
import { isDesktop } from '../../lib/desktop';
import { MacFixedAddress } from './MacFixedAddress';
import { macModeOffered } from './macContract';
import { useMacStatus } from './macStore';
import '../sleepy/chat/ChatViews.css';
import './handsfree.css';

/** Settings → hands-free (Mac mode): the fixed address the phone app is installed from. Start,
 *  stop, the password and the signed-in phones live in the hands-free sheet. */
export function HandsfreeSettingsCard() {
  const { t } = useI18n();
  const mac = useMacStatus();
  // Hidden where the server says Mac mode cannot run (every OS but macOS).
  if (!isDesktop() || !macModeOffered(mac)) return null;
  return (
    <div className="hf-settings" data-testid="hf-settings">
      <h3 className="hf-settings-title">{t('handsfree.settings.title')}</h3>
      <p className="hf-quiet">{t('handsfree.settings.lead')}</p>
      <MacFixedAddress />
    </div>
  );
}
