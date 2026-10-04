/**
 * /propose/<id>: one proposal (the screen itself is `ProposalView`). The id
 * is checked here: anything but a plain positive number opens the not-found
 * view without asking the API.
 */

import { ProposalView } from './ProposalView';

type Params = Promise<{ id: string }>;

export default async function ProposalPage({ params }: { params: Params }) {
  const { id } = await params;
  const proposalId = /^[1-9][0-9]{0,8}$/.test(id) ? Number(id) : Number.NaN;
  return <ProposalView proposalId={proposalId} />;
}
