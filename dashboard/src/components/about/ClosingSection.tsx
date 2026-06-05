import './ClosingSection.css';

/**
 * The closing "So — what is this?" block: a centered summary, the mono command
 * list (init / dashboard / sleep), and the live-dashboard foot note. Ported out
 * of AboutPage into a self-contained component with its own `.closing-*` styles
 * (it no longer borrows any closing-specific rules from AboutPage.css).
 *
 * Copy stays positioning-safe: dreamcontext "is learning to act" is roadmap
 * framing — nothing here claims the agent acts on its own.
 */

interface Command {
  cmd: string;
  hint: string;
}

const COMMANDS: Command[] = [
  { cmd: 'dreamcontext init', hint: '# set up the brain' },
  { cmd: 'dreamcontext dashboard', hint: '# open this dashboard' },
  { cmd: 'dreamcontext sleep', hint: '# consolidate the session' },
];

export function ClosingSection() {
  return (
    <section className="closing" aria-labelledby="closing-heading">
      <h2 className="closing-title" id="closing-heading">
        So — what is this?
      </h2>
      <p className="closing-body">
        <strong>dreamcontext</strong> is a small CLI that gives your AI coding
        agents a structured, persistent brain across sessions. It pre-loads what
        matters, keeps a living map of your project, and consolidates new
        knowledge as you go — so you stop paying, every single session, to
        re-teach the agent what it already learned.
      </p>

      <div className="closing-cmds" role="list">
        {COMMANDS.map((c) => (
          <div className="closing-cmd" role="listitem" key={c.cmd}>
            <span className="closing-cmd-c" aria-hidden="true">
              $
            </span>
            <span className="closing-cmd-text">{c.cmd}</span>
            <span className="closing-cmd-hint">{c.hint}</span>
          </div>
        ))}
      </div>

      <p className="closing-foot">
        You're looking at the dashboard now. The brain graph, tasks, and sleep
        state in the sidebar are this project's actual memory — live.
      </p>
    </section>
  );
}
