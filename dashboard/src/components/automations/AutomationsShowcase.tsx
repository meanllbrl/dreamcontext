import { FlowDiagram } from '../about/FlowDiagram';
import { MaturityTag } from '../common/MaturityTag';
import { useI18n } from '../../context/I18nContext';
import { AUTOMATIONS_SHOWCASE } from './automationsFlowSpec';

/**
 * The Automations "stage" — the animated cadence diagram framed in a gradient
 * panel, echoing the Council and Lab showcases so the three experimental
 * surfaces read as a set. Used full-size as the centrepiece of the empty state.
 *
 * The corner tag is the app's own maturity marker, the same "Beta" the sidebar row wears:
 * the retired "Lab" word is gone from the UI (style guide, 2026-09-22). The diagram's spoken
 * description is read through i18n, so it follows the copy rules the rest of the page does.
 */
export function AutomationsShowcase() {
  const { t } = useI18n();
  return (
    <div className="auto-stage">
      <MaturityTag level="beta" className="auto-stage-tag" />
      <FlowDiagram
        spec={{ ...AUTOMATIONS_SHOWCASE, ariaLabel: t('agents.empty.showcaseAria') }}
        className="auto-stage-flow"
      />
    </div>
  );
}
