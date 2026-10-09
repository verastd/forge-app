# Task Spec: every behaviour's declared states, on screen

Issue: [verastd/forge-app#49](https://github.com/verastd/forge-app/issues/49) (draft until its acceptance tests merge and it is labelled `agent-ready` + `status:open`).

## Goal

When a member presses a behaviour's control in the lobby, the screen shows
which of the behaviour's declared states it is in (requested, confirmed,
contested, rejected with its reason, out of range, paused) from the press to
the outcome, so nobody is left wondering whether a press worked.

## Civilian summary

When you throw or wave, the lobby always shows what happened to it: sent,
done, didn't reach, or why not.

## Acceptance criteria

1. `PlayControls.tsx` renders the state copy from the behaviour's catalog
   entry (`BEHAVIORS[...].states`) and never hard-codes its own: a `requested`
   state shows within one frame of the press, and a `confirmed` or `rejected`
   state replaces it within the catalog entry's `confirmWithinMs`, with a
   visible spinner or progress affordance while `requested`.
2. The lobby root carries `data-behavior-state="<kind>:<state>"` for the most
   recent behaviour, so e2e can read it, and the people panel's live region
   announces a `rejected` state's reason to screen readers.
3. A Playwright spec in `tests/e2e/` proves, in the practice build, each of:
   a throw with nobody in range shows `outOfRange`; a wave shows `requested`
   then `confirmed`; a catch answered `missed` shows `rejected` with the
   catalog's reason copy.

## Acceptance tests

`tests/acceptance/issue-49/test_behavior_states.py` (committed by the spec
author, pytest, skipped until `tests/e2e/lobby-behavior-states.spec.ts`
exists): the controls take their copy from the catalog and hard-code none of
it, show progress while `requested` and honour `confirmWithinMs`, the lobby
root carries `data-behavior-state`, the panel announces a rejection, and the
e2e spec names the three flows. The private suite additionally checks the
states on a phone-sized viewport.

## Scope

```forge-scope
in:
- apps/web/src/components/lobby/PlayControls.tsx
- apps/web/src/components/lobby/Lobby.tsx
- apps/web/src/components/lobby/Lobby.module.css
- apps/web/src/components/lobby/VoicePanel.tsx
- tests/e2e/lobby-behavior-states.spec.ts
out:
- apps/web/src/components/lobby/voice/engine.ts
- apps/web/src/components/lobby/scene/**
```

DEPS: none new.

## Context pack

- [ADR-009](../adr/ADR-009-shared-behaviours.md), "Front-end states are part
  of the contract": the rule this task makes true.
- `packages/lobby/src/behaviors/catalog.ts`: `BehaviorStates`, the copy and
  `confirmWithinMs`.
- `apps/web/src/components/lobby/PlayControls.tsx`: the controls today.
- `docs/architecture.md`, "The Apps lobby", **States**: the `data-*`
  attributes e2e already reads; add the new one beside them.

## Size class

S

## Tier floor

T0

## Reward class

R1
