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
  meant to be built through FORGE's own pipeline, not around it. The first five
  are pieces of it, sized to be claimed; the rest are the small, real
  tasks a first contributor can finish in an afternoon.

When one is posted, add its issue number and link at the top of the file
and leave the file in place as the spec's history. A posted spec stays
`status:draft` until its acceptance tests are on `main`
(`tests/acceptance/issue-<N>/`, see [the acceptance README](../../tests/acceptance/README.md)
for how a feature's tests stay skipped until the work that satisfies them
exists); only then does the core team label it `agent-ready` + `status:open`.

| File | Issue | Size | Tier | Reward | Builds |
|---|---|---|---|---|---|
| [`lobby-catalog-wiring.md`](lobby-catalog-wiring.md) | [#48](https://github.com/verastd/forge-app/issues/48) | S | T1 | R2 | Catch, throw and wave registered in the behaviour catalog, with budgets and states |
| [`lobby-states-on-screen.md`](lobby-states-on-screen.md) | [#49](https://github.com/verastd/forge-app/issues/49) | S | T0 | R1 | Every behaviour's declared states visible in the lobby, with an e2e proof |
| [`lobby-swarm-harness.md`](lobby-swarm-harness.md) | [#50](https://github.com/verastd/forge-app/issues/50) | M | T1 | R3 | A load harness of scripted members and the first baselines |
| [`lobby-world-participant.md`](lobby-world-participant.md) | [#51](https://github.com/verastd/forge-app/issues/51) | M | T2 | R3 | The authoritative world participant, owning nothing at first |
| [`lobby-cells-and-tracks.md`](lobby-cells-and-tracks.md) | [#52](https://github.com/verastd/forge-app/issues/52) | M | T2 | R3 | Object state per spatial cell on data tracks, subscribed by distance |
| [`fixtures-mirror-test.md`](fixtures-mirror-test.md) | not yet posted | XS | T0 | R1 | A vitest that locks the web's task fixtures to the API's `tasks.json` |
| [`task-specs-scope-lint.md`](task-specs-scope-lint.md) | not yet posted | S | T0 | R1 | A pytest that keeps every spec here parseable and inside the protected paths |
| [`upland-spec-into-docs.md`](upland-spec-into-docs.md) | not yet posted | XS | T0 | none | The Upland build spec moves under `docs/` without the laptop paths |
| [`architecture-web-tests-row.md`](architecture-web-tests-row.md) | not yet posted | XS | T0 | none | The module map stops saying `apps/web` has no unit tests |
| [`lobby-behavior-types-pinned.md`](lobby-behavior-types-pinned.md) | not yet posted | XS | T0 | none | The behaviour kernel's public types pinned in the export test |
