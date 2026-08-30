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
    grade: 'Guided handoff, 3 taps + paste',
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
