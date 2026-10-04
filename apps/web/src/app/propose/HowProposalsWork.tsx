/**
 * "How proposals work": the rules the floor runs under (Phase 5 contract §1,
 * PRD v0.2 §3), collapsed at the bottom of /propose. These are rules people
 * rely on, not copy: keep the numbers in step with the API's timers and
 * quorum if they ever change.
 */

import { ELIGIBLE_ACTIVITY_DAYS } from '@forge/shared';

import styles from './propose.module.css';

export function HowProposalsWork() {
  return (
    <details className="disclosure">
      <summary>How proposals work</summary>
      <div className="disclosure-body stack">
        <p className={styles.flowLine}>Motion → Second → Debate → Vote → Build</p>
        <ol className={styles.flowList}>
          <li>
            <strong>Motion</strong> — you bring an idea: a short title and a pitch in plain English. You can
            edit it until someone seconds it, and withdraw it any time before it is decided.
          </li>
          <li>
            <strong>Second</strong> — another member has to second it, which says &ldquo;the floor should
            take this up&rdquo;, before debate can open. A motion nobody seconds within 7 days lapses.
          </li>
          <li>
            <strong>Debate</strong> — the community discusses it in the open. If debate ends without a single
            objection, the proposal passes without the voting days.
          </li>
          <li>
            <strong>Vote</strong> — if anyone objected, the members vote: Yes, No or Abstain, one member one
            vote.
          </li>
          <li>
            <strong>Build</strong> — a proposal that passes becomes a task on the Contribute board, once an
            admin has written down what &ldquo;done&rdquo; means.
          </li>
        </ol>
        <p className="faint">
          One active proposal per person — once yours is decided, you can bring another. Anyone signed in
          with GitHub can bring, second, consent or object, comment and vote, and anyone at all can read
          the floor.
        </p>

        <h3 className={styles.ruleTitle}>The unanimous-consent fast path</h3>
        <p className="muted">
          From the moment a proposal is seconded, every eligible member can Consent or Object. If every
          eligible member consents, it passes right away, without waiting out the rest of debate or holding
          a vote. The person who moved it counts as consenting automatically; the person who seconded it has
          to consent like anyone else. Who counts as eligible is fixed at the moment it is seconded: the
          members active on FORGE in the last {ELIGIBLE_ACTIVITY_DAYS} days, plus the person who moved it and
          the person who seconded it. A single objection ends the fast path: the proposal finishes its debate
          and then goes to a vote. Consenting is final, and so is objecting: once you have answered, you
          can&apos;t change your answer.
        </p>

        <h3 className={styles.ruleTitle}>Pilot timing</h3>
        <p className="muted">
          For the pilot: a motion has 7 days to find a second, debate runs for 3 days, then voting runs for
          2 days. Quorum is a majority of eligible members casting a ballot (Abstain counts toward quorum):
          the members active in the last {ELIGIBLE_ACTIVITY_DAYS} days when it was seconded, with its mover and
          seconder. Once quorum is met, a majority of the votes cast carries: it passes with more Yes than
          No, and a tie fails. Votes can be changed until the vote closes.
        </p>
        <p className="muted">
          While members can&apos;t take part (sign-in is switched off, say), the floor is paused: no deadline
          runs, and when it opens again every running deadline moves later by the time it was paused.
        </p>

        <h3 className={styles.ruleTitle}>In the open</h3>
        <p className="muted">
          Everything is public: who moved and seconded it, every consent and objection, the debate, the
          tally after the close and the outcome. Votes are public too: your name shows next to your vote
          after the close.
        </p>

        <h3 className={styles.ruleTitle}>After it passes</h3>
        <p className="muted">
          A passed proposal becomes a draft task. An admin writes down what &ldquo;done&rdquo; means and
          publishes it to the Contribute board, where anyone&apos;s agent can take it on. When that work
          ships, so does the proposal. Its panel in the lobby is still added by hand for now.
        </p>
      </div>
    </details>
  );
}
