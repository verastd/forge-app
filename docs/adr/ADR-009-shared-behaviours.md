# ADR-009: Shared behaviours — one catalog, budgets, and one process that steps the world

Why the lobby's behaviours (catch, throw, wave, and everything the community
adds after them) are entries in one catalog with declared budgets and
on-screen states, why their shared objects are entities with an owner and an
epoch, and why authority over contended objects moves to one world
participant on the existing LiveKit room rather than to a replicated-model
framework. Decided with the operator on 2026-10-09.

## Status

Accepted. The catalog, budgets, entities and world kernel ship with this ADR
(`packages/lobby/src/behaviors/`). The steps below are claimable Task Specs
in [`docs/tasks/`](../tasks/README.md).

## Context

Catch and throw ([PR #44](https://github.com/verastd/forge-app/pull/44))
are the lobby's first shared object. ADR-004 left shared state open: "LiveKit
relays; it doesn't keep a model everyone agrees on. Objects people move
together would need a small server, or a tool like Multisynq alongside for
just that." The operator's intent is a lobby that takes every imaginative
idea the community brings: multi-body physics, area effects, autonomous
things, persistent constructions, with a hundred or more members in one cave
and, hypothetically, far more.

Three things were weighed for the shared state: staying on LiveKit and adding
authority ourselves; Multisynq (Croquet's deterministic replicated model on a
reflector network) for state with LiveKit kept for voice; and an independent
Croquet-style framework such as Krestianstvo.

## Decision

**Stay on LiveKit. Put authority in a pure kernel. Host it in one process.**

The burden an MMO carries is not simulation hosting, which a replicated model
removes, but authority: when two members press catch on the same ball in the
same 80 ms, something has to decide, and for a platform whose pitch is that
nobody has to trust anybody, that something has to be able to refuse a
dishonest client. A reflector cannot: "reflectors only pass messages, all
logic runs on clients" (Multisynq's docs), nothing authenticates the sender
of an event, and every merged community behaviour would change the session
every member must be in (a Croquet session id includes a hash of all model
code). One nondeterministic contribution would desync every member at once.
Krestianstvo is a single-maintainer SolidJS re-implementation that still
requires a reflector. Neither is a footing for untrusted contributions.

So the end state is **one process steps the world**: a world participant in
the LiveKit room runs the same pure kernel clients use for prediction,
clients send intents, the world publishes state, and LiveKit forwards state
only to those near enough to care. Community behaviour code that is buggy,
heavy or hostile runs where it can be budgeted, paused, killed and rolled
back. Nothing ships for it before it is needed, and nothing written before it
is thrown away: the kernel is the same code at every step.

**The decisions that cost nothing today and a rewrite later.**

1. **Ticks, not frames.** The kernel steps at a fixed 20 Hz on its own timer,
   as voice already does; rendering interpolates. A behaviour is
   `step(state, tick)`, never `onFrame`.
2. **Intents in, state out.** A client never publishes state for anything it
   doesn't own. Own position is the one owned state today; when the world
   participant exists it becomes input too.
3. **Entities from day one.** Every shared thing has a stable id
   (`<kind>:<name>`), a kind, an owner, whose word is final (`owner` or
   `world`), an epoch that grows with every change of hands, a pose and a
   `persistent` bit. The ball is entity one. Balls are never persisted.
4. **Cells in the wire format while there is one cell.** The cave is cut into
   8 sectors by 4 bands (`CELLS`, `cellOf`, `neighbours`). Today everything is
   one broadcast; every message is keyed by cell so that one LiveKit data
   track per cell changes nothing on the wire.
5. **Budgets are part of a behaviour's definition.** A catalog entry without
   `entities`, `bytesPerSecond`, `msPerTick` and `intentsPerSecond` is refused
   by `validateBehaviors`, and `createBehaviorMeter` holds a behaviour to them,
   pausing the behaviour (not the lobby) with a reason the panel can show.
6. **Three kill levels.** A flag per behaviour (named in its entry; no
   deploy), a runtime pause per behaviour (`pauseBehavior`, for the world
   participant and an operator), and per-member rate limits (the meter, which
   generalises `acceptAction`).
7. **Physics runs only in the authority.** Never replicated across browsers:
   cross-engine float divergence is the whole reason replicated models are
   fragile. Clients get poses and predict visually.
8. **Clients degrade by budget, not by luck.** Nearest-N peers and objects
   drawn by device class, as voices are 8 or 16; cull by cell; instance
   identical meshes.
9. **Persistence is event-sourced.** `world`-owned persistent entities keep an
   intent log and snapshots in the API's store. Transient objects never
   touch it.
10. **The world participant's identity and host.** Identity `world`, a token
    the browser route never issues, a long-lived Node process (Vercel can't
    hold one; `infra/` has terraform), joining with `@livekit/rtc-node`, a
    dependency its Task Spec pre-approves.

**Claims resolve the same on every client.** A claim names the epoch at which
the claimant saw the entity. The first claim at that epoch takes it. A rival
claim at the same epoch is resolved by `resolveClaim`: the later epoch wins,
and at the same epoch the lower claimant id, a tie-break with no meaning but
the same everywhere. Two honest clients that hear both claims in either order
end with the same owner (`applyClaim`, proved by its tests). Today this is
owner authority: as peer-trusted as positions are (ADR-004), and said so. The
world participant closes that by being the only one whose claims count.

**Front-end states are part of the contract.** Authority means a gap between
pressing catch and owning the ball. Every catalog entry declares copy for
`requested`, `confirmed`, `contested`, `rejected`, `outOfRange` and `paused`
and a `confirmWithinMs`; `validateBehaviors` refuses one without. A control
that shows nothing while its intent is in flight is a defect, not a nit.

## Build order

0. **This ADR, the catalog, budgets, entities and world kernel.** Shipped.
1. **Wire catch, throw and wave through the catalog**
   ([spec](../tasks/lobby-catalog-wiring.md)) and **put the states on screen**
   ([spec](../tasks/lobby-states-on-screen.md)).
2. **A load harness before anything else grows**
   ([spec](../tasks/lobby-swarm-harness.md)): scripted members at 25, 50, 100
   and 150, measured from a real browser, baselines recorded. You cannot
   future-proof what you cannot load; the "about 100" broadcast ceiling
   ADR-004 predicted gets a number.
3. **The world participant, empty at first**
   ([spec](../tasks/lobby-world-participant.md)): joins as `world`, runs the
   kernel at 20 Hz, owns nothing, then the ball's flight behind a flag.
4. **Interest management** ([spec](../tasks/lobby-cells-and-tracks.md)): one
   data track per cell, subscribed by distance with voice's hysteresis;
   positions follow, which also closes ADR-004's "a client that lies about
   where it is still gets in".
5. **Physics and persistence**: in the world participant only, with a
   deterministic WASM engine pre-approved by its own spec; multi-body
   behaviours become possible here and nowhere else.

## Beyond a hundred

The ten decisions hold at every order of magnitude. At a thousand, one SFU
room stops being the unit: positions are N², members connect to the room for
their cell and its neighbours, the world becomes several processes each
owning a cell group with entities handed across boundaries (the kernel being
pure makes that a function call), voice permissions move server-side, and
LiveKit's participant-minute billing says self-host the SFU, which ADR-004
kept open. Three preparations cost nothing now: derive the room name from
shard and cell rather than the constant `lobby`, use globally unique entity
ids, and keep the world process restartable from a snapshot. At ten thousand
there is no single simulation: shards, a router, a real database behind the
event log, a message bus for cross-shard events, LiveKit per shard-cell at the
edge. A replicated model is categorically out there, since every client
cannot run the whole world. Authority-only physics is what keeps the cell
split possible.

## Revisit a replicated model only if

behaviours need many objects interacting with each other rather than with a
holder, *and* a shared simulation has to run client-side for feel, *and*
Multisynq publishes rates, limits and an SLA and offers server-signed
identity, *and* a per-version world with a written persistence migration is
acceptable. Even then the same kernel is what would be hosted in the Model,
and LiveKit keeps voice and identity.

## Consequences

- `@forge/lobby` grows a `behaviors/` folder, pure and fully unit-tested
  under the package's determinism lint, exported whole and pinned by
  `index.test.ts`.
- Catch and throw as merged are not yet on the catalog: the first Task Spec
  moves them, without changing `actions.ts` or `play.ts`.
- A community behaviour's Task Spec scopes its registry entry, its kernel
  module, its tests, its flag, its view hook and its state copy, never the
  feeds, the token route, the kernel core or the world participant. The
  Gauntlet's coverage gate and CODEOWNERS do the gatekeeping a reflector
  would otherwise be trusted with.
- The world participant is the first long-lived process FORGE runs outside
  Vercel. Its host is decided on its spec's issue before its PR opens.
- Nothing here changes the lobby's bill until the swarm harness says what
  the room costs at a hundred.
