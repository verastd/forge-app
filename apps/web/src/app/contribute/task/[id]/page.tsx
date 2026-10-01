/**
 * /contribute/task/<id>: one task, end to end (the screen itself is
 * `components/contribute/TaskView.tsx`).
 *
 * A server component only so that server settings reach the page as props
 * rather than as NEXT_PUBLIC_ variables baked into the bundle:
 * GITHUB_APP_SLUG (the Copilot rail's "install FORGE's GitHub app" link,
 * hidden when unset), and the outcome the Copilot callback put in the query
 * string (`?started=` / `?start_error=`), which the page shows once.
 */
import { TaskView } from '../../../../components/contribute/TaskView';
import { githubAppSlug, readStartOutcome } from '../../../../lib/handoff';

// GITHUB_APP_SLUG is read per request, so one build serves whatever each server is configured with.
export const dynamic = 'force-dynamic';

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function TaskPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const taskId = /^[1-9][0-9]{0,8}$/.test(id) ? Number(id) : Number.NaN;
  const outcome = readStartOutcome({
    started: first(query.started),
    startError: first(query.start_error),
    status: first(query.status),
  });
  return <TaskView taskId={taskId} appSlug={githubAppSlug(process.env.GITHUB_APP_SLUG)} outcome={outcome} />;
}
