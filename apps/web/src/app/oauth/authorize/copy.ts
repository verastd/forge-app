/**
 * The consent flow's words, in one place: the consent page draws them, and
 * the Allow/Cancel handler's plain error pages use the same ones, so a
 * visitor reads the same sentence for the same situation wherever it shows.
 */

export interface Notice {
  title: string;
  message: string;
}

export const NOTICES = {
  /** A practice (demo) session: it is nobody on GitHub, so the API has nobody to connect. */
  practice: {
    title: 'Practice accounts can’t connect agents.',
    message: 'Sign in with GitHub.',
  },
  /** The `mcp_connector` flag is off. Same words as /connect's fail-closed message. */
  off: {
    title: 'The FORGE connector is switched off right now.',
    message: 'Nothing was connected. Please try again later.',
  },
  unavailable: {
    title: 'FORGE can’t connect agents right now',
    message: 'Nothing was connected. Please try again in a few minutes.',
  },
  invalid: {
    title: 'This connection request isn’t valid',
    message:
      'FORGE stopped it here instead of sending you anywhere. Go back to your agent and connect again.',
  },
  empty: {
    title: 'Nothing to approve here',
    message:
      'This page opens when an agent asks to connect to FORGE. If you have just signed in, go back to your agent and connect again.',
  },
  signedOut: {
    title: 'You’re signed out',
    message: 'Nothing was connected. Sign in, then choose Allow or Cancel again.',
  },
  crossOrigin: {
    title: 'FORGE didn’t accept that',
    message:
      'Allow and Cancel only count when you press them on FORGE’s own page, so nothing was connected. Go back to your agent and connect again.',
  },
} as const satisfies Readonly<Record<string, Notice>>;

export type NoticeKind = keyof typeof NOTICES;

/**
 * A request the API refused but may tell the app about: the page says why
 * and offers the way back. Nothing sends the visitor there unasked, so a link
 * to FORGE can't bounce anyone to another site on its own.
 */
export const CANT_GO_AHEAD = 'This connection request can’t go ahead';
export const RETURN_NOTE = 'Nothing was connected. Going back tells the app that asked why.';

/** "This connection request can’t go ahead: <why>." (or just the first part when the API gave no why). */
export function cantGoAhead(why: string): string {
  const reason = why.replace(/[\s.]+$/u, '');
  return reason === '' ? `${CANT_GO_AHEAD}.` : `${CANT_GO_AHEAD}: ${reason}.`;
}

/** What a connected agent may do (scope `forge.tasks`), in the words the consent screen uses. */
export const CAN = [
  'See FORGE tasks',
  'Claim and release tasks in your name',
  'Report progress',
  'Read your pull request’s check results',
  'Submit your pull request link',
] as const;

/** What it may not, whatever it asks. */
export const CANNOT = [
  'Push code for you',
  'See your private repositories',
  'Spend money',
  'Change your FORGE account',
] as const;
