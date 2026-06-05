import './ProblemSection.css';

/**
 * The problem section — reframes dreamcontext as deep *understanding* of your
 * whole project, not mere memory storage. It surfaces what's hiding, connects
 * scattered decisions, and gets to the point where the agent sometimes
 * understands your project better than you do — because it never forgets and
 * sees the whole graph. Positioning-safe: understanding & surfacing, never
 * autonomous action. Uses the shared `.about-section` shape; the without/with
 * contrast cards are ported into ProblemSection.css.
 */
export function ProblemSection() {
  return (
    <section className="about-section">
      <p className="about-kicker">The problem</p>
      <h2 className="about-h2">Your project is bigger than anyone can hold.</h2>
      <p className="about-section-lead">
        dreamcontext isn't a memory file. It builds a deep understanding of your whole
        project — the company, the codebase, even how you work — then <em>surfaces what's
        hiding</em>: the scattered decisions, the forgotten reasons, the connections no one
        wrote down. Because it never forgets and sees the whole graph, the agent sometimes
        understands your project better than you do.
      </p>
      <div className="about-contrast">
        <div className="about-contrast-card about-contrast-card--bad">
          <span className="about-contrast-tag">Without dreamcontext</span>
          <ul>
            <li>Decisions scatter across chats, commits, and your head</li>
            <li>The "why" behind last month's choice is already gone</li>
            <li>You re-explain the project from scratch every session</li>
            <li>Blind to the connections between what you've decided</li>
          </ul>
        </div>
        <div className="about-contrast-card about-contrast-card--good">
          <span className="about-contrast-tag">With dreamcontext</span>
          <ul>
            <li>Deep understanding of the whole project, across every session</li>
            <li>Surfaces the hidden links between scattered decisions</li>
            <li>Holds the whole picture — company, code, and work-life context</li>
            <li>Gets sharper every time it consolidates what changed</li>
          </ul>
        </div>
      </div>
    </section>
  );
}
