# Security Policy

How to report a vulnerability in FORGE. Source: PRD §4 Stage 0 ("Security reports"), §5 T5.

## Reporting

Report suspected vulnerabilities using **GitHub private vulnerability
reporting** on this repository (Security tab -> "Report a vulnerability").

Do **not** open a public issue or Discussion for a suspected vulnerability,
and do not post details anywhere public (including Discord) before it is
resolved. Public disclosure of an unpatched issue is itself treated as a
security incident.

Private vulnerability reporting is enabled on this repository.

## What to include

- Affected component/path and, if known, commit or PR.
- Steps to reproduce, or a minimal proof of concept.
- Impact as you understand it (what an attacker gains).
- Whether you've shared this with anyone else.

## Response SLO

The core team targets an initial response within **72 hours**. Response
means acknowledgment and triage, not resolution — fix timelines depend on
severity and are communicated in the advisory thread.

## Rewards

Security reports are, initially, **unpaid**. This is a deliberate,
hard-learned choice, not an oversight: a paid public vulnerability program
attracts low-effort/AI-generated submissions faster than any other surface
(curl ended its bounty in January 2026 for exactly this reason — see PRD
§13). If a paid program launches later, it will be announced here and will
remain private-reporting-only.

## Supported scope

FORGE is in **beta**. There is no older supported version line; report
against `main` / whatever is currently deployed to staging or beta. Nothing
is in production yet (see `README.md` "Current status").

## What is actually enforced today

So a reporter does not spend time on a control we already know is
missing, the headlines:

- **Sensitive-path review is cold-account approval, not two-person
  control.** `CODEOWNERS` lists `@verastd` and `@forge-cold` on `.github/`,
  `contracts/`, `packages/contracts-client/`, and the `auth*`/`pay*`
  routers, but GitHub accepts an approval from any one listed owner and
  both accounts belong to the same person. What it buys is a forced
  sign-in to a hardware-2FA account — friction against a stolen session.
  It is not independent review, and it does not constrain a compromised or
  mistaken operator. Reports that turn on that distinction are welcome;
  reports that it exists are already known.
- **The Gauntlet's unprivileged layer is live** (`hygiene`, `tests`,
  `security`, `e2e`), and G0's protocol checks are implemented in Foreman.
  G4, G5, and G6 are designed and not built. Foreman is not yet registered
  as a GitHub App, so nothing is processing real webhooks.
- **Push rulesets cannot be imported on a public repository**, so the
  large-file and banned-extension blocks documented in the PRD are caught
  in the PR by CI, not before a push.
- **Nothing pays out.** The reward ledger records `payable`; there is no
  payout execution, so there is no money-movement surface to attack yet.

## Coordinated disclosure

The core team will work with reporters on a disclosure timeline once a fix
is available. Credit is offered by default (name/handle in the advisory and
release notes) unless the reporter asks to stay anonymous.
