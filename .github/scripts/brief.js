// .github/scripts/brief.js
//
// Builds the "Gauntlet Decision Brief" PR comment. Invoked from
// .github/workflows/foreman-annotate.yml via actions/github-script, which
// hands us an authenticated Octokit (`github`), the event `context`, and
// the Actions `core` logger. Plain Node, zero npm dependencies by design —
// this runs on the privileged, no-fork-checkout side of the Gauntlet, so
// its dependency surface is exactly "whatever ships with the GitHub
// Actions Node runtime."
//
// PRD requires pinning third-party actions by SHA before production — see
// the operator runbook (private core repo; this file isn't a third-party
// action, but the note travels with the rest of the Gauntlet).

const BRIEF_MARKER = "<!-- forge-decision-brief -->";

module.exports = async ({ github, context, core }) => {
  const run = context.payload.workflow_run;
  if (!run) {
    core.setFailed("brief.js: no workflow_run payload on this event.");
    return;
  }

  const { owner, repo } = context.repo;

  const prNumber = await resolvePrNumber({ github, core, owner, repo, run });
  if (!prNumber) {
    core.warning(
      "brief.js: could not resolve a PR number for this gauntlet run — skipping brief."
    );
    return;
  }

  const jobs = await listJobs({ github, owner, repo, runId: run.id });
  const artifacts = await listArtifacts({ github, owner, repo, runId: run.id });

  const body = renderBrief({ run, jobs, artifacts, prNumber });

  await upsertComment({ github, owner, repo, issueNumber: prNumber, body });
};

async function resolvePrNumber({ github, core, owner, repo, run }) {
  if (Array.isArray(run.pull_requests) && run.pull_requests.length > 0) {
    return run.pull_requests[0].number;
  }

  // Fallback: fork-originated gauntlet runs often report an empty
  // `pull_requests` array (GitHub only reliably populates it for
  // same-repo PRs). The `tests` job in gauntlet.yml uploads its dist
  // artifact as `pr-<number>-dist`, so recover the PR number from
  // artifact metadata instead.
  core.info(
    "brief.js: workflow_run.pull_requests was empty, falling back to artifact metadata."
  );
  const artifacts = await listArtifacts({ github, owner, repo, runId: run.id });
  for (const artifact of artifacts) {
    const match = /^pr-(\d+)-dist$/.exec(artifact.name);
    if (match) {
      return Number(match[1]);
    }
  }
  return null;
}

async function listJobs({ github, owner, repo, runId }) {
  const { data } = await github.rest.actions.listJobsForWorkflowRun({
    owner,
    repo,
    run_id: runId,
  });
  return data.jobs.map((job) => ({
    name: job.name,
    conclusion: job.conclusion,
    url: job.html_url,
  }));
}

async function listArtifacts({ github, owner, repo, runId }) {
  const { data } = await github.rest.actions.listWorkflowRunArtifacts({
    owner,
    repo,
    run_id: runId,
  });
  return data.artifacts.map((artifact) => ({
    name: artifact.name,
    id: artifact.id,
    sizeInBytes: artifact.size_in_bytes,
    expired: artifact.expired,
  }));
}

function renderBrief({ run, jobs, artifacts, prNumber }) {
  const resultsTable = jobs.length
    ? [
        "| Job | Result |",
        "|---|---|",
        ...jobs.map(
          (job) =>
            `| [${job.name}](${job.url}) | ${statusEmoji(job.conclusion)} ${
              job.conclusion || "pending"
            } |`
        ),
      ].join("\n")
    : "_No job results reported by this gauntlet run._";

  const artifactLinks = artifacts.length
    ? artifacts
        .map(
          (a) =>
            `- \`${a.name}\` (${formatBytes(a.sizeInBytes)}${
              a.expired ? ", expired" : ""
            }) — run [#${run.id}](${run.html_url})`
        )
        .join("\n")
    : "_No artifacts uploaded by this run._";

  const riskFlags = jobs
    .filter((job) => job.conclusion && job.conclusion !== "success")
    .map((job) => `- ⚠️ \`${job.name}\` concluded **${job.conclusion}**`);

  const riskSection = riskFlags.length
    ? riskFlags.join("\n")
    : "_No risk flags — all gauntlet jobs reported success._";

  return [
    BRIEF_MARKER,
    "## Gauntlet Decision Brief",
    "",
    `Triggering run: [${run.name} #${run.run_number}](${run.html_url}) (${
      run.conclusion || "in progress"
    })`,
    "",
    "### Job results",
    resultsTable,
    "",
    "### Artifacts",
    artifactLinks,
    "",
    "### Spec conformance (G4 advisory) — pending",
    "_The advisory LLM review pass is not wired into this brief yet. This section is a placeholder until G4 ships._",
    "",
    "### Contributor tier — see Foreman",
    "_Tier, claim history, and reward-at-stake are tracked by Foreman, not this workflow. Placeholder pending the Foreman ledger integration._",
    "",
    "### Risk flags",
    riskSection,
    "",
    `<sub>PR #${prNumber} · gauntlet run [${run.id}](${
      run.html_url
    }) · updated ${new Date().toISOString()}</sub>`,
  ].join("\n");
}

function statusEmoji(conclusion) {
  switch (conclusion) {
    case "success":
      return "✅";
    case "failure":
      return "❌";
    case "cancelled":
      return "⏹️";
    case "skipped":
      return "⏭️";
    case "neutral":
      return "🚩";
    default:
      return "⏳";
  }
}

function formatBytes(bytes) {
  if (bytes === undefined || bytes === null) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function upsertComment({ github, owner, repo, issueNumber, body }) {
  const { data: comments } = await github.rest.issues.listComments({
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  });

  const existing = comments.find((c) => c.body && c.body.includes(BRIEF_MARKER));

  if (existing) {
    await github.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existing.id,
      body,
    });
  } else {
    await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body,
    });
  }
}
