# Task Spec: the world participant, owning nothing at first

Issue: not yet posted.

## Goal

A long-lived Node process joins the lobby's LiveKit room as the participant
`world`, runs the behaviour kernel at a fixed 20 Hz, owns every entity whose
authority is `world`, and publishes their state, so the lobby has one place
where contended objects are decided and community behaviours can be paused.

## Civilian summary

Give the lobby a referee: one program that decides who caught the ball when
two people grab at once, and can switch off a misbehaving trick for everyone.

## Acceptance criteria

1. `apps/world` is a workspace package whose `pnpm --filter @forge/world
   start` joins the room named by `LOBBY_ROOM` with a token minted from
   `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` for identity `world`, publishes
   nothing until an entity with `authority: 'world'` exists, and exits
   non-zero with a one-line reason when the settings are missing.
2. The process steps `packages/lobby/src/behaviors` at 20 Hz on its own timer,
   enforces every catalog entry's `msPerTick` budget with
   `createBehaviorMeter`, and exposes `GET /healthz` (tick time p95, entities,
   paused behaviours) and `POST /behaviors/<id>/pause` guarded by a bearer
   token from `WORLD_ADMIN_TOKEN`.
3. Behind the new flag `lobby_world` (registered everywhere `lobby_avatars`
   is), the ball's flight moves to the world: a browser's throw becomes an
   intent, the world publishes the ball's `obj` state, and both browsers in
   the e2e see the same holder after a contested catch (`resolveClaim`
   decides).

## Acceptance tests

`tests/acceptance/issue-<N>/test_world.py` (committed by the spec author):
the kernel loop's tick accounting, the pause route's auth, and the flag's
registration in all five places. The private suite additionally runs the
process against a LiveKit container with two scripted catchers.

## Scope

```forge-scope
in:
- apps/world/**
- packages/lobby/src/behaviors/**
- packages/flags/src/core.ts
- packages/shared/src/index.ts
- packages/shared/src/index.test.ts
- apps/api/src/forge_api/services/flags.py
- apps/api/tests/test_flags.py
- config/flags.json
- apps/web/src/components/lobby/presence/livekitFeed.ts
- apps/web/src/components/lobby/scene/play.ts
- pnpm-workspace.yaml
- pnpm-lock.yaml
- tests/e2e/lobby-world.spec.ts
out:
- apps/web/src/app/api/lobby/**
- apps/api/src/forge_api/models.py
```

DEPS: `@livekit/rtc-node` (to join a room from Node), pre-approved by name for
`apps/world` only; the PR needs the `deps-approved` label. The web's token
route is out of scope: the world mints its own token server-side with the
existing `livekit-server-sdk`. `models.py` is out of scope because
`FlagConfig` there is updated by the core team in the same window, to keep the
zod and Pydantic sides changing together.

## Context pack

- [ADR-009](../adr/ADR-009-shared-behaviours.md), "Step 3: the world
  participant, empty at first", and decision 10 on its identity and host.
- `packages/lobby/src/behaviors/`: `World`, `applyIntent`, `resolveClaim`,
  `createBehaviorMeter`.
- `apps/web/src/components/lobby/voice/engine.ts`, header: "Swap the
  broadcast for your authoritative game-state feed by calling
  setPeerPosition() yourself and setting positionHz to 0."
- `apps/api/src/forge_api/services/flags.py` and friends: the five flag
  registration points, with `lobby_avatars` as the model.
- `docs/architecture.md`, Operations: Vercel cannot host this process; the
  issue's thread decides the host before the PR opens.

## Size class

M

## Tier floor

T2

## Reward class

R3
