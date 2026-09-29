/**
 * Propose: honest and static (PRD v0.2). Proposals are not open yet, so this
 * page says exactly that, and nothing else on it pretends otherwise — no
 * fetched data, no feature flag, just the rules the pilot will run under
 * once they are. Keep the wording here in sync with the operator's spec if
 * it ever changes: the timing, quorum and unanimous-consent numbers are
 * rules people will actually rely on, not copy.
 */

import styles from './propose.module.css';

export default function ProposePage() {
  return (
    <main className="page stack-lg">
      <div>
        <h1 className="page-title">Propose</h1>
        <p className="lede">Proposals aren't open yet.</p>
      </div>

      <section className="card stack">
        <h2 className="section-title">How a proposal will move</h2>
        <p className="muted">
          Once proposals open, anyone eligible can bring an idea, pitched in plain English. From
          there it moves through five stages:
        </p>
        <p className={styles.flowLine}>Motion → Second → Debate → Vote → Build queue</p>
        <ol className={styles.flowList}>
          <li>
            <strong>Motion</strong> — you bring the idea, pitched in plain English. You can edit it
            until someone seconds it; after that you can only withdraw it.
          </li>
          <li>
            <strong>Second</strong> — another eligible member has to second it before debate can
            open. A motion nobody seconds within 7 days lapses.
          </li>
          <li>
            <strong>Debate</strong> — the community discusses it in the open. If debate ends without
            a single objection, the proposal passes without the voting days.
          </li>
          <li>
            <strong>Vote</strong> — eligible members vote, one member one vote.
          </li>
          <li>
            <strong>Build queue</strong> — a proposal that passes joins the same queue as any other
            task.
          </li>
        </ol>
        <p className="faint">
          One active proposal per person — once yours is decided, you can bring another. During
          the pilot, the eligible members are the invited pilot group; later, contributors at tier T1
          and above.
        </p>
      </section>

      <section className="card stack">
        <h2 className="section-title">The unanimous-consent fast path</h2>
        <p className="muted">
          From the moment a proposal is seconded, every eligible member can Consent or Object. If
          every eligible member consents, it passes right away, without waiting out the rest of
          debate or holding a vote. The person who moved it counts as consenting automatically; the
          person who seconded it has to consent like anyone else. Who counts as eligible is fixed at
          the moment it is seconded. A single objection ends the fast path: the proposal finishes
          its debate and then goes to a vote.
        </p>
      </section>

      <section className="card stack">
        <h2 className="section-title">Pilot timing</h2>
        <p className="muted">
          For the pilot: debate runs for 3 days, then voting runs for 2 days. Quorum is a majority of
          eligible members, and once quorum is met, a majority of the votes cast carries.
        </p>
      </section>
    </main>
  );
}
