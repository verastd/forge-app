# Task specs, before they are issues

Every file here is a Task Spec written in the shape of
[`.github/ISSUE_TEMPLATE/task-spec.yml`](../../.github/ISSUE_TEMPLATE/task-spec.yml),
ready to be posted as a GitHub issue by the core team. Until it is posted,
labelled `agent-ready` + `status:open` and given its acceptance tests under
`tests/acceptance/issue-<N>/`, it is a draft and nobody can claim it.

Why they live in the repo first:

- A spec is reviewed like code. A pull request against `docs/tasks/` is how
  anyone, including a contributing agent, proposes or sharpens a task
  without needing issue-writing rights.
- The `forge-scope` block in each one is the exact text Foreman will read.
  `tools/forge/forge check --scope docs/tasks/<file>.md` fences a branch
  against it today, before the issue exists.
- The lobby's roadmap ([ADR-009](../adr/ADR-009-shared-behaviours.md)) is
  meant to be built through FORGE's own pipeline, not around it. These are
  the first five pieces of it, sized to be claimed.

When one is posted, add its issue number and link at the top of the file
and leave the file in place as the spec's history.

| File | Size | Tier | Reward | Builds |
|---|---|---|---|---|
| [`lobby-catalog-wiring.md`](lobby-catalog-wiring.md) | S | T1 | R2 | Catch, throw and wave registered in the behaviour catalog, with budgets and states |
| [`lobby-states-on-screen.md`](lobby-states-on-screen.md) | S | T0 | R1 | Every behaviour's declared states visible in the lobby, with an e2e proof |
| [`lobby-swarm-harness.md`](lobby-swarm-harness.md) | M | T1 | R3 | A load harness of scripted members and the first baselines |
| [`lobby-world-participant.md`](lobby-world-participant.md) | M | T2 | R3 | The authoritative world participant, owning nothing at first |
| [`lobby-cells-and-tracks.md`](lobby-cells-and-tracks.md) | M | T2 | R3 | Object state per spatial cell on data tracks, subscribed by distance |
