/**
 * /propose/new: the new-proposal form (`NewProposalForm`). Signed out, the
 * middleware's matcher sends the visitor to /signin first and back here
 * afterwards.
 */

import { NewProposalForm } from './NewProposalForm';

export default function NewProposalPage() {
  return <NewProposalForm />;
}
