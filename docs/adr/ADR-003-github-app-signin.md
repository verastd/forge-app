# ADR-003: Sign in with GitHub — a dedicated App, an in-house OAuth flow, and a BFF

Why identity for FORGE v0.2 is a small in-house OAuth client on `jose`
talking to its own GitHub App, rather than an auth library or a shared
credential with Foreman. Source: FORGE v0.2 Phase 1 spec ("Sign in with
GitHub").

## Status

Accepted (Phase 1). Tightened after the Phase 1 security review: the
transaction cookie's `__Host-` prefix, admins by GitHub id, a practice-only
dev secret, and practice sign-in fixed at build time (all below).

## Context

FORGE v0.2 needs to know who's using it: an avatar menu, a profile at `/me`,
a Data app (Upland) private to the signed-in visitor, and later one-vote-
per-contributor proposals. The operator decision was GitHub sign-in only —
no email/password, no other providers — which narrows the problem but still
leaves real choices: build the OAuth client or adopt one, register a new
GitHub App or reuse Foreman's, and decide how the browser is allowed to
reach `apps/api` for data that's now supposed to be per-user rather than
public.

`apps/web` runs on the Edge-capable parts of Next.js (`middleware.ts` in
particular), which rules out anything that assumes Node's `node:` built-ins
or a database connection are available wherever identity is checked.

## Decision

**An in-house OAuth flow, on `jose` alone.** `packages/auth` is built only on
`jose@^6.2.12` (Web Crypto under the hood) — no Node built-ins, enforced by
its own `eslint.config.mjs` — so Next's Edge middleware can import it
directly to gate `/me` and `/upland` without a database round trip.
Auth.js (NextAuth) v5 was rejected because it's still beta and in
maintenance mode; Better Auth was rejected because it wants a database,
which this phase deliberately has none of. A hand-built flow is more code to
own (see Consequences), but it's code that fits the one thing FORGE actually
needs — GitHub, and only GitHub — instead of a general-purpose library's
much larger surface.

**A dedicated GitHub App, not Foreman's App and not an OAuth App.** Foreman
already exists as a GitHub App operated by the core team, and reusing its
registration was the obvious shortcut — rejected anyway, because Foreman's
App is provisioned with the repository permissions its protocol-gate job
needs, and a sign-in flow has no business inheriting that blast radius for
an unrelated purpose. A plain OAuth App was also rejected: GitHub Apps
using the user-authorization web flow issue *expiring* user access tokens
(8 hours) with rotating refresh tokens, versus an OAuth App's non-expiring
token; a GitHub App's permissions are also fine-grained and can be
broadened later (Phase 2+ proposals may need to read issues/PRs to weight a
vote) without redoing the sign-in flow itself. Phase 1 requests **no
repository permissions at all** — `GET /user` needs none — so today's
GitHub App is, deliberately, no more dangerous than reading a public
profile.

**PKCE (S256), always.** The authorization code flow carries a PKCE
challenge/verifier pair even though this is a confidential client (the
client secret lives server-side, never in the browser). It costs nothing
and closes the authorization-code-interception class of attack outright,
so there's no reason to special-case it away for a "we have a secret
anyway" argument.

**Stateless JWE sessions, not a session store.** The session cookie is an
encrypted JWE (`alg: dir`, `enc: A256GCM`), not a signed-but-readable JWT
and not an opaque id into a database row. This keeps `apps/web` free of a
session store dependency, matches the "no DB in this phase" constraint, and
means the cookie's claims (GitHub id, login, name, avatar) are never
visible to anyone holding the cookie, only to whoever holds
`FORGE_SESSION_SECRET`. The OAuth transaction itself (`state` + PKCE
verifier + `next`) is sealed the same way, in a second, 10-minute cookie —
never one shared with the identity that emerges from it. In production both
cookies carry the `__Host-` prefix (`__Host-forge_session`,
`__Host-forge_oauth`), which requires `Secure` and `Path=/` and forbids
`Domain`: a sibling subdomain or an HTTP man-in-the-middle could otherwise
plant a transaction cookie of their own and finish their sign-in in a
visitor's browser, signing the visitor in as them (login CSRF).

**A BFF plus short-lived assertions, instead of CORS and cookies on the
API.** The browser could plausibly have called `apps/api` for Upland data
directly, with the API reading the session cookie and a CORS policy
allowing the web origin. That was rejected in favor of a same-origin
`/bff/upland/*` proxy on the web side that mints a 60-second HS256
assertion (`iss: forge-web`, `aud: forge-api`) and forwards to
`apps/api`, which verifies that assertion on every request
(`require_identity`/`require_admin`; see [`architecture.md`](../architecture.md#identity)
for the exact dependency order and status codes). This keeps the session
cookie itself — and `FORGE_SESSION_SECRET` — confined to `apps/web`, never
parsed or trusted by a second service; keeps `apps/api` free of any CORS
policy naming the web origin (there is none); and gives every API call a
tightly-scoped, quickly-expiring credential instead of a long-lived one.
The cost is a second secret (`FORGE_API_ASSERTION_SECRET`) that both sides
must agree on byte-for-byte, and one more hop. Operator-only routes
(`require_admin`) admit a caller by numeric GitHub user id, listed in
`FORGE_ADMIN_IDS`, never by login: a login can be renamed and then
registered by someone else, while the id stays with the account. One entry
that isn't an id empties the whole list, so a mistake (a login where an id
belongs, say) locks operators out and logs why, rather than half-applying.

**The practice account is a build, and the dev secret vouches for no one.**
The demo build's practice account is decided when the app is compiled:
`next.config.mjs` inlines `NEXT_PUBLIC_FORGE_DEMO` even when it is unset,
so no runtime setting can switch practice sign-in on in a live deployment,
and a live build refuses practice sessions outright (middleware,
`getSession()`, BFF). So a fresh checkout works without setup, `next dev`
with `FORGE_SESSION_SECRET` unset seals under a hard-coded dev secret.
That secret is public, so anyone can seal any cookie under it: it only ever
counts for the practice account, and the BFF never mints an assertion while
it is in use. A secret that is set but too short never falls back to it;
sign-in is simply off.

## Consequences

- **No early revocation.** A stateless session can't be individually
  deleted; the only lever is rotating `FORGE_SESSION_SECRET` (which signs
  *everyone* out) or waiting out the 7-day absolute lifetime. This is an
  accepted risk for this phase, not an oversight — see
  [`architecture.md`](../architecture.md#identity)'s Operations notes for
  what rotation actually does and doesn't cover.
- **Every route becomes dynamic.** The root layout now awaits
  `getPublicSession()` on every request (to seed the account menu), which
  reads cookies and therefore forces Next to render the whole app
  dynamically rather than statically. This was already implied by
  per-visitor state in the nav; Phase 1 just makes it load-bearing rather
  than incidental.
- **We own security-critical code.** `packages/auth` and the routes built on
  it are hand-written, not a maintained library's responsibility. The
  mitigations are structural, not aspirational: a 100% coverage floor
  enforced in `packages/auth/vitest.config.ts` (not merely the repo-wide
  80%-of-changed-lines gate), RFC 7636 Appendix B test vectors for the PKCE
  math specifically (rather than trusting a hand-rolled implementation on
  faith), cold-account `CODEOWNERS` review on the package, every route
  that touches a session or the BFF's Origin check, and the build-time
  switch that decides whether practice sessions count, and the same paths
  listed in `.github/forge-protocol.json`'s `protectedPaths` so Foreman's
  G0 gate enforces the same trust boundary mechanically. None of this
  proves the code is correct; it's what the team could do instead of a
  library's own track record.
- **Two secrets to provision and keep in sync.** `FORGE_SESSION_SECRET`
  (web-only) and `FORGE_API_ASSERTION_SECRET` (web and API, must match
  exactly) are both required outside local dev, both need to be at least 32
  ASCII characters, and a deployment that gets either wrong fails toward
  "signed out" or "Data app unreachable" rather than toward silently
  accepting a forged identity — but it does mean two things to get right
  instead of one.
