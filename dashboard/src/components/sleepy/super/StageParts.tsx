import { STAGE, type StagePlan } from './superLayout';
import type { SuperStateView } from '../../../lib/superTypes';
import type { ChatSession } from '../chatSession';
import { ChatTile } from './AgentCard';
import { chatStatus, useLiveSession } from './SuperContainer';
import { toneOfStatus } from './superHandover';

/** A chat in an open panel: the same tile as on the stage, live, glowing as it does there. */
export function PanelChatTile({ session, child, title, asksOwner }: { session: ChatSession | undefined; child: SuperStateView['children'][string] | undefined; title: string; asksOwner: boolean }) {
  useLiveSession(session);
  const status = chatStatus(session);
  return (
    <div className="super-panel-tile" data-status={status.kind === 'asking' ? 'asking' : status.kind === 'working' ? 'working' : 'idle'} data-super-tone={toneOfStatus(status.kind)}>
      <div className="super-panel-clip"><ChatTile session={session} child={child} title={title} asksOwner={asksOwner} status={status} /></div>
    </div>
  );
}

/**
 * The orbit (owner 2026-10-20): a faint dashed arc through each side's inner tiles, fading at its
 * ends, under the centre (its ends slip behind it). Static: it is redrawn with the plan, never
 * animated.
 */
export function OrbitPath({ plan }: { plan: StagePlan }) {
  const T = STAGE.TILE;
  return (
    <svg className="super-orbit" width={plan.width} height={plan.height} aria-hidden>
      {plan.orbit.map((a) => {
        const span = a.ymax + T / 2 + STAGE.GAP + 40;
        const pts: string[] = [];
        for (let y = a.cy - span; y <= a.cy + span + 0.01; y += 6) {
          const k = (y - a.cy) / a.ymax;
          pts.push(`${(a.x0 + a.dir * a.depth * (1 - k * k)).toFixed(1)},${y.toFixed(1)}`);
        }
        const id = `super-orbit-fade-${a.side}`;
        return (
          <g key={a.side}>
            <defs>
              <linearGradient id={id} gradientUnits="userSpaceOnUse" x1="0" y1={a.cy - span} x2="0" y2={a.cy + span}>
                <stop offset="0" className="super-orbit-stop" stopOpacity="0" />
                <stop offset="0.25" className="super-orbit-stop" stopOpacity="0.45" />
                <stop offset="0.75" className="super-orbit-stop" stopOpacity="0.45" />
                <stop offset="1" className="super-orbit-stop" stopOpacity="0" />
              </linearGradient>
            </defs>
            <polyline points={pts.join(' ')} fill="none" stroke={`url(#${id})`} strokeWidth={1.2} strokeDasharray="2 6" strokeLinecap="round" />
          </g>
        );
      })}
    </svg>
  );
}


