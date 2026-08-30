# contracts/

Placeholder. On-chain code lives here **if** it stays in-repo (PRD §9 notes
this as one of the modules that may instead live in the private repo as a
submodule-shaped exception — see PRD Appendix J for the proprietary-code
variant).

If used:

- This path is a **cold-account approval path**: `/contracts/` in the root
  `CODEOWNERS` lists `@td` and `@forge-cold` (PRD Appendix C.3). Read that
  honestly — GitHub is satisfied when any one listed owner approves, and
  both accounts belong to the same person. Because GitHub never counts the
  author's own approval, a `@td`-authored change here does force a sign-in
  to the hardware-2FA cold account: friction against a stolen session, not
  independent review. The upgrade to genuine two-person control (a second
  human maintainer, `required_approving_review_count: 2`) is recorded in
  `CODEOWNERS` and the operator runbook (private core repo).
- **Tier floor: T2.** Contracts-touching work is not open to T0/T1
  contributors (PRD §4 Stage 5, §5 T1 residual-risk posture).
- Changes here carry the same cold-account approval at *deploy* time, not
  just merge time, for anything chain-touching (PRD §4 Stage 7).

No contract source has landed yet — this file is a scaffold placeholder
only.
