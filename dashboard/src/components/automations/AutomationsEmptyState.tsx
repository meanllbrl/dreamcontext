import { BrandMark } from '../brand/BrandMark';
import { AutomationsShowcase } from './AutomationsShowcase';
import { AutomationsDispatcherBar } from './AutomationsDispatcherBar';
import './AutomationsEmptyState.css';

/**
 * Automations' zero-state, built in the same shape as Council's and Lab's: with
 * no automations to list, the board's chrome would be noise, so it shows a
 * compact "What is Automations?" explainer instead — brand mark · kicker ·
 * gradient heading · lead · the animated cadence stage — ending in the one thing
 * a user can do about it: turn the scheduler on (the one thing that IS doable
 * from here with nothing created yet), then scaffold their first automation
 * from the CLI. The footnote carries the security stance, because the approval
 * tripwire is the thing a first-time reader most needs to understand about
 * this page.
 */
export function AutomationsEmptyState({ onToast }: { onToast?: (msg: string) => void }) {
  return (
    <div className="auto-intro">
      <div className="auto-intro-mark">
        <BrandMark size={40} glow />
      </div>

      <p className="auto-intro-kicker">Lab · Automations</p>
      <h2 className="auto-intro-title">
        Put the brain <span>on a schedule</span>.
      </h2>
      <p className="auto-intro-lead">
        Automations run headless <code>claude -p</code> sessions on a cadence you set — an
        end-of-day digest, a Friday report, a research prompt on a chosen day. You describe
        the job in plain language; one dispatcher wakes every five minutes, runs what is due,
        writes a dated markdown file, and tells you what it found. Every run leaves a lesson
        behind, so the next one starts smarter.
      </p>

      <AutomationsShowcase />

      <AutomationsDispatcherBar onToast={onToast} />

      <p className="auto-intro-scaffold">Scaffold your first automation from the CLI:</p>
      <code className="auto-intro-cmd">
        dreamcontext automations create &lt;slug&gt; --title "Daily digest" --days daily --at 18:00
      </code>
      <p className="auto-intro-foot">
        Automations are experimental and ship fully disabled: nothing runs until you install
        the dispatcher and approve each automation on this machine. Runs use{' '}
        <code>bypassPermissions</code>, which is exactly why approval is pinned to a SHA256 of
        the prompt — edit it, and the job stops until you approve it again.
      </p>
    </div>
  );
}
