/**
 * POST /auth/github/repo — "Get started", "Refresh your copy" and "Send for
 * review" on a task page (Phase 7). FORGE does each with the contributor's
 * own one-time GitHub authorization through its OAuth App (scope
 * `public_repo`): a fresh state and PKCE pair, sealed into the transaction
 * cookie as a `repo` attempt for this task and action, then off to GitHub's
 * authorize page. The callback (`./callback`) spends the token on that one
 * action through the API, then revokes it; nothing stores it.
 *
 * The rules, and what each refusal looks like, are `startRepoAuthorization`
 * (`./flow.ts`); this file only wires in the real session, settings and
 * cookie.
 */
import {
  COOKIE,
  cookieOptions,
  createPkcePair,
  isRepoAction,
  publicRepoAuthorizeUrl,
  randomToken,
  sealTransaction,
} from '@forge/auth';
import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';

import { isProduction, sessionKeys } from '../../../../lib/auth/config';
import { isSameOrigin } from '../../../../lib/bff-forward';
import { getSession, repoApp } from '../../../../lib/session';
import { startRepoAuthorization } from './flow';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<Response> {
  return startRepoAuthorization(request, {
    auth: { createPkcePair, isRepoAction, publicRepoAuthorizeUrl, randomToken, sealTransaction },
    sameOrigin: () => isSameOrigin(request),
    session: getSession,
    setup: async () => {
      const app = await repoApp();
      const keys = sessionKeys();
      return app === null || keys === null || keys.practiceOnly ? null : { app, seal: keys.seal };
    },
    keep: async (sealed) => {
      const prod = isProduction();
      (await cookies()).set(COOKIE.transaction(prod), sealed, cookieOptions('transaction', prod));
    },
  });
}
