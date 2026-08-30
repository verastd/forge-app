# ADR-002: Stack — Next.js + FastAPI

Why the app is Next.js (TypeScript) + FastAPI (Python) rather than a single-language stack. Source: PRD Appendix H.1.

## Status

Accepted (Phase 0).

## Context

FORGE's whole premise is that a community of coding agents, not our own
engineers, will write most of the code that lands in this repo. That makes
the stack choice a swarm-performance decision, not just an engineering
preference: the agents doing the work are only as good as their training
data and the clarity of the boundaries we hand them.

## Decision

`apps/web` is Next.js (App Router, TypeScript strict). `apps/api` is
FastAPI (Python 3.12, managed with `uv`, package `forge_api`). Reasoning
specific to swarm contribution (PRD Appendix H.1):

- **Agent training coverage.** Next.js and FastAPI are two of the
  ecosystems with the deepest agent training coverage available. Community
  agents will be measurably better at these than at anything more exotic.
  Boring, mainstream stacks are a swarm-performance feature, not a
  compromise.
- **A typed contract boundary.** `packages/shared` holds zod schemas as
  the reference copy of the web/API contract;
  `apps/api/src/forge_api/models.py` mirrors those schemas field-for-field
  on the Python side — by hand, locked by contract tests, not generated
  (see the 2026-08 amendment below). This turns the most common agent failure mode —
  cross-boundary drift between frontend and backend — into a compile-time
  or CI-time Gauntlet failure instead of a silent runtime bug.
- **Workspace-shaped scope-locking.** Python isolates work (API routes,
  services, eventually ML/data/token-analytics) that the web crowd
  shouldn't need to touch, and vice versa. The Task Spec's declared Scope
  (PRD Appendix B) maps cleanly onto the `apps/web` / `apps/api` /
  `packages/*` workspace boundaries, which is what lets G0's scope
  enforcement work mechanically rather than by convention.

Carried into the architecture from the app's web3-in-disguise constraints:
all chain interaction lives behind `packages/contracts-client`, the only
module allowed to import a chain SDK. Consequence for FORGE specifically:
roughly 90% of Task Specs never touch the chain layer, so roughly 90% of
the swarm never needs the cold-account approval path — the disguise is
also the safety boundary.

## Alternatives considered

A single-language stack (e.g. all-TypeScript with a Node/Nest API, or an
all-Python stack with a Python-rendered frontend) was considered and
rejected: it would simplify tooling slightly but would either weaken the
typed-contract boundary (nothing forces a schema-drift failure the way a
cross-language mirror does) or give up FastAPI's isolation of
Python-native work. The two-ecosystem cost (two lint/typecheck/test
toolchains, reflected in `make lint` and `make test` both shelling out to
`apps/api` separately) is accepted as the price of the boundary.

## Consequences

- **Mirror discipline is load-bearing, not optional.** Every change to a
  `packages/shared` zod schema must land with the corresponding change to
  `apps/api/src/forge_api/models.py` in the same PR, or the two sides
  drift. `AGENTS.md` states this rule directly; the Gauntlet's hygiene and
  test layers (G1/G2) are the enforcement mechanism, not a style
  preference.
- Two toolchains means two lint/typecheck/test surfaces in CI (`make
  lint` and `make test` each run an eslint/tsc pass and a
  ruff/mypy/pytest pass). This is accepted overhead, tracked as part of
  keeping `make test` under the PRD's five-minute target (PRD §4 Stage 4).
- `apps/api` (Python) exists alongside the pnpm workspace rather than
  inside it. (At the time of this decision the Foreman GitHub App also
  lived in this tree as a standalone Node app; it now runs as a service
  operated by the core team, with its source in the private core repo.)
- Any future addition of a third language/runtime to this repo should get
  its own ADR; the two-stack boundary here is deliberate, not incidental.

---

**Amendment (2026-08-24, assessment response):** the assessment is right
that this is *two* sources of truth connected by convention, not one —
"documentation calls Zod the single source of truth, but developers are
told to edit both representations." The contract tests catch field-level
drift but do not prove agreement across enums, constraints, error shapes,
and future additions. The generation-based fix (FastAPI/OpenAPI as the
authority with a generated TS client, or JSON Schema emitted from zod for
Pydantic) is a recorded follow-up, not a done thing — tracked in the core
team's operator docs (private core repo).
