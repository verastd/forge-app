/**
 * /propose: the Propose floor (Phase 5 contract §4). The screen is
 * `ProposeFloor`, a client component behind the `proposals` flag; the rules
 * the pilot runs under, which this page used to show on their own, are
 * collapsed at its foot under "How proposals work" (`HowProposalsWork`).
 */

import { ProposeFloor } from './ProposeFloor';

export default function ProposePage() {
  return <ProposeFloor />;
}
