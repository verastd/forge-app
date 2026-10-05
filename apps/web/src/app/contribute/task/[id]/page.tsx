/**
 * /contribute/task/<id>: one task, end to end (the screen itself is
 * `components/contribute/TaskView.tsx`).
 *
 * A server component only so that server settings reach the page as props
 * rather than as NEXT_PUBLIC_ variables baked into the bundle:
 * GITHUB_APP_SLUG (the Copilot rail's "install FORGE's GitHub app" link,
 * hidden when unset); whether FORGE's OAuth App is set up (`repoApp()`:
 * GITHUB_REPO_CLIENT_ID and _SECRET with GitHub sign-in), which decides
 * whether "Get started" and "Send for review" are offered; and the outcomes
 * the callbacks put in the query string (Copilot's `?started=` /
 * `?start_error=`, and the repo callback's `?copy=` / `?review=` /
 * `?repo_error=`), which the page shows once.
 */
import { TaskView } from '../../../../components/contribute/TaskView';
import { githubAppSlug, readRepoOutcome, readStartOutcome } from '../../../../lib/handoff';
import { repoApp } from '../../../../lib/session';

// GITHUB_APP_SLUG and the OAuth App settings are read per request, so one build serves whatever each server is configured with.
export const dynamic = 'force-dynamic';

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function TaskPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const [{ id }, query, app] = await Promise.all([params, searchParams, repoApp()]);
  const taskId = /^[1-9][0-9]{0,8}$/.test(id) ? Number(id) : Number.NaN;
  const outcome = readStartOutcome({
    started: first(query.started),
    startError: first(query.start_error),
    status: first(query.status),
  });
  const repoOutcome = readRepoOutcome({
    copy: first(query.copy),
    synced: first(query.synced),
    latest: first(query.latest),
    review: first(query.review),
    pr: first(query.pr),
    repoError: first(query.repo_error),
    status: first(query.status),
    files: first(query.files),
  });
  return (
    <TaskView
      taskId={taskId}
      appSlug={githubAppSlug(process.env.GITHUB_APP_SLUG)}
      outcome={outcome}
      repoSetup={app !== null}
      repoOutcome={repoOutcome}
    />
  );
}
