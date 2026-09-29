/**
 * The dispatch rails (PRD Appendix I.3), as the picker needs them.
 *
 * One internal interface, seven vendors, two mechanisms: rails that accept an
 * API dispatch and rails where the honest answer is a guided handoff. The UX
 * grade is published on the card because a Civilian choosing a rail is really
 * choosing how much work they have to do themselves.
 */

import type { Rail } from '@forge/shared';

export interface RailInfo {
  rail: Rail;
  /** The name the vendor uses, which is the only name the contributor knows. */
  label: string;
  mode: 'api' | 'handoff';
  /** ★ / ★★ / ★★★ from the I.3 matrix — fewer stars is less effort. */
  stars: 1 | 2 | 3;
  /** The grade in words, shown next to the stars. */
  grade: string;
  /** One line about what this rail needs from the contributor. */
  note: string;
  /** Where the handoff sends them. Mirrors HANDOFF_RAILS in the API. */
  deepLink?: string;
}

export const RAIL_INFO: Record<Rail, RailInfo> = {
  copilot: {
    rail: 'copilot',
    label: 'GitHub Copilot',
    mode: 'api',
    stars: 1,
    grade: 'One-click',
    note: 'Nothing else to connect — it uses the same account you signed in with.',
  },
  jules: {
    rail: 'jules',
    label: 'Google Jules',
    mode: 'api',
    stars: 1,
    grade: 'One-click after key setup',
    note: 'Free tier: 15 tasks a day, so this one costs nothing to try.',
  },
  cursor: {
    rail: 'cursor',
    label: 'Cursor',
    mode: 'api',
    stars: 2,
    grade: 'One-click after key setup',
    note: 'Runs on your own Cursor plan, using the key you connected.',
  },
  devin: {
    rail: 'devin',
    label: 'Devin',
    mode: 'api',
    stars: 2,
    grade: 'One-click after key setup',
    note: 'Runs on your own Devin plan, using the key you connected.',
  },
  openhands: {
    rail: 'openhands',
    label: 'OpenHands Cloud',
    mode: 'api',
    stars: 2,
    grade: 'One-click after key setup',
    note: 'Runs on your own OpenHands account, using the key you connected.',
  },
  'claude-code': {
    rail: 'claude-code',
    label: 'Claude Code',
    mode: 'handoff',
    stars: 3,
    // Pick the rail, tap Open: Claude Code opens with the task typed in, so the last step is send.
    grade: 'Guided handoff, 2 taps + send',
    note: 'Nothing to connect. We hand you the wording and open Claude Code for you.',
    deepLink: 'https://claude.ai/code',
  },
  codex: {
    rail: 'codex',
    label: 'OpenAI Codex',
    mode: 'handoff',
    stars: 3,
    grade: 'Guided handoff',
    note: 'Nothing to connect. We hand you the wording and open Codex for you.',
    deepLink: 'https://chatgpt.com/codex',
  },
};

export function railLabel(rail: Rail): string {
  return RAIL_INFO[rail].label;
}

/**
 * A Claude Code URL with the compiled prompt already filled in (v0.2 PRD
 * addendum), so the contributor has nothing to copy: opening it is the whole
 * handoff. `login` is the signed-in GitHub login for a real (non-demo)
 * session; pass null for a demo session or a signed-out visitor, and the
 * link omits the `repositories` hint since there is no real fork to point
 * Claude Code at.
 *
 * Returns null when the URL would exceed 7,000 characters — a prompt that
 * long doesn't fit reliably in a URL bar / server request line, so the
 * caller falls back to the plain deep link plus copy/paste instead.
 *
 * Pure and tiny on purpose: this is the one piece of the handoff worth
 * testing on its own, so it stays simple enough to check by hand.
 */
const CLAUDE_CODE_PREFILL_MAX_LENGTH = 7000;

export function claudeCodePrefillUrl(prompt: string, login: string | null): string | null {
  let url = `https://claude.ai/code?prompt=${encodeURIComponent(prompt)}`;
  if (login !== null) {
    url += `&repositories=${encodeURIComponent(`${login}/forge-app`)}`;
  }
  return url.length > CLAUDE_CODE_PREFILL_MAX_LENGTH ? null : url;
}
