# Task Spec: a swarm of scripted members, and the lobby's first baselines

Issue: not yet posted.

## Goal

An operator can put 25, 50, 100 or 150 scripted members into a LiveKit room
from one command, each walking and heartbeating like a real member, and read
what a real browser in that room measures, so every later lobby change is
judged against numbers rather than hope.

## Civilian summary

A way to fill the lobby with pretend people so we can see what breaks before
real people do.

## Acceptance criteria

1. `tools/lobby-swarm/swarm.mjs --members N --room <name> --minutes M` joins
   N participants to the room using `livekit-server-sdk` for tokens and the
   same 9-byte position packets and `act` messages a browser sends
   (`encodePosition`, `encodeAction` from `@forge/lobby`), at the real send
   policy, walking seeded random paths inside `CAMERA_LIMITS`; it exits
   non-zero if any join fails.
2. `tools/lobby-swarm/measure.mjs` drives one Chromium through Playwright
   into the same room and prints, per minute, as JSON: packets handled per
   second, packets dropped per sender, frame time p50 and p95, voice
   subscription changes, and heap size, read from a new development-only
   `window.__forgePresence` debug view in the LiveKit feed.
3. `docs/lobby-baselines.md` records one run at each of 25, 50, 100 and 150
   members against a local `livekit-server`, with the commands used, and
   ADR-009 links to it.

## Acceptance tests

`tests/acceptance/issue-<N>/test_swarm_tool.py` (committed by the spec
author): the swarm's packet generator produces only packets
`decodePosition` accepts and steps `plausibleStep` allows; `--members 0`
exits cleanly; the measure script's JSON has the named fields. The private
suite additionally runs a 25-member swarm against a LiveKit container.

## Scope

```forge-scope
in:
- tools/lobby-swarm/**
- apps/web/src/components/lobby/presence/livekitFeed.ts
- apps/web/src/components/lobby/presence/types.ts
- docs/lobby-baselines.md
- docs/adr/ADR-009-shared-behaviours.md
out:
- apps/web/src/components/lobby/voice/engine.ts
- apps/web/src/app/api/lobby/**
```

DEPS: none new. (`livekit-server-sdk`, `@playwright/test` and `livekit-client`
are already in `apps/web`; the tool imports them from the workspace.)

## Context pack

- [ADR-009](../adr/ADR-009-shared-behaviours.md), "Step 2: a load harness
  before anything else grows".
- [ADR-004](../adr/ADR-004-apps-lobby.md): the proofs done by hand so far,
  and the "about 100 people" broadcast ceiling this measures.
- `packages/lobby/src/presence.ts`: `sendPolicy`, `encodePosition`,
  `plausibleStep`, the limiter.
- `apps/web/src/components/lobby/voice/engine.ts`: `window.__forgeVoice`,
  the pattern for a development-only debug view.
- `docs/live-tests.md`: how a local LiveKit server is run for proofs.

## Size class

M

## Tier floor

T1

## Reward class

R3
