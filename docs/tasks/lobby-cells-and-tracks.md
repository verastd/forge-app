# Task Spec: object state per cell, on data tracks, subscribed by distance

Issue: [verastd/forge-app#52](https://github.com/verastd/forge-app/issues/52) (draft until its acceptance tests merge and it is labelled `agent-ready` + `status:open`).

## Goal

Object state travels on one LiveKit data track per spatial cell rather than
as a broadcast, and a member's client subscribes only to its own cell and
its neighbours, so a crowded cave stops costing every member every packet.

## Civilian summary

Make the lobby send you only what is happening near you, so it stays smooth
when the room is full.

## Acceptance criteria

1. The world participant publishes `obj` frames on data tracks named
   `obj:<cell>` using `cellOf` from `packages/lobby/src/behaviors/entity.ts`,
   one frame per changed entity per tick, each under 1200 bytes.
2. The LiveKit feed subscribes to the tracks for the member's cell and the
   cells `neighbours(cell)` returns, re-evaluated at 2 Hz with the same
   hysteresis shape voice uses (`dwellMs`), and unsubscribes the rest; the
   development debug view from the swarm task reports the subscribed cells.
3. Against the swarm harness at 100 members spread over the cave, packets
   handled per second on the measuring browser fall by at least half against
   the recorded broadcast baseline, and the result is appended to
   `docs/lobby-baselines.md`.

## Acceptance tests

`tests/acceptance/issue-52/test_cells.py` (committed by the spec author,
pytest, skipped until `tests/e2e/lobby-cells.spec.ts` and `apps/world`
exist): the world publishes per cell on `obj:<cell>` tracks under 1200
bytes, the feed subscribes by `neighbours` with voice's dwell at 2 Hz and
reports its cells, the e2e spec checks a scripted walk's subscription set,
and the baselines record the drop. `cellOf` and `neighbours` themselves are
unit-tested in `packages/lobby`. The private suite additionally reruns the
100-member swarm.

## Scope

```forge-scope
in:
- apps/world/**
- packages/lobby/src/behaviors/**
- apps/web/src/components/lobby/presence/livekitFeed.ts
- apps/web/src/components/lobby/presence/types.ts
- docs/lobby-baselines.md
- tests/e2e/lobby-cells.spec.ts
out:
- apps/web/src/components/lobby/voice/engine.ts
- apps/web/src/app/api/lobby/**
- packages/lobby/src/presence.ts
```

DEPS: none new.

## Context pack

- [ADR-009](../adr/ADR-009-shared-behaviours.md), "Step 4: interest
  management", and decision 4 on cells.
- `packages/lobby/src/behaviors/entity.ts`: `cellOf`, `neighbours`, `CELLS`.
- `packages/lobby/src/voice.ts`: the hysteresis and dwell the subscription
  logic should mirror.
- LiveKit data tracks: per-track selective subscription, frames under 1200
  bytes to fit one packet.

## Size class

M

## Tier floor

T2

## Reward class

R3
