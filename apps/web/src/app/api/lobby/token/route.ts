/**
 * The lobby's LiveKit room token. A member signed in with GitHub gets a
 * one-hour token for the `lobby` room, as `gh:<GitHub user id>` under their
 * login; the browser joins with it (`livekitFeed`).
 *
 * - POST only (GET is 405), from this origin: the `Origin` check the BFF
 *   uses, plus `Sec-Fetch-Site` when the browser sends it. No body is read.
 * - No session: 401 `unauthenticated`, with `WWW-Authenticate: Bearer`.
 * - The practice account: 403 `practice_session`. It is nobody on GitHub.
 * - Another origin: 403 `bad_origin`.
 * - LiveKit not configured (LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET,
 *   the URL a ws(s) or http(s) URL), or session keys anyone can seal under:
 *   503 `voice_unavailable`.
 * - Otherwise 200 `{ url, token }`, `Cache-Control: private, no-store`.
 *
 * The token is the room's only word on who someone is: peers are shown under
 * the identity and name signed here, never anything a peer sends, so the
 * grant withholds metadata updates (`canUpdateOwnMetadata: false`). It lets a
 * member publish a microphone and nothing else (`canPublishSources`): the
 * lobby has voice, and no camera, screen share or second audio track.
 *
 * The environment is read per request, not at module load, so a build with
 * no LiveKit settings still succeeds, and this route then answers 503.
 */
import { sanitizeName } from '@forge/lobby';
import { AccessToken, TrackSource } from 'livekit-server-sdk';

import { isTrustedOrigin, sessionKeys } from '../../../../lib/auth/config';
import { jsonError } from '../../../../lib/auth/http';
import { getSession } from '../../../../lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROOM = 'lobby';
const TOKEN_TTL = '1h';
const ROOM_URL_SCHEMES = new Set(['wss:', 'ws:', 'https:', 'http:']);

interface LiveKitConfig {
  url: string;
  apiKey: string;
  apiSecret: string;
}

export async function POST(request: Request): Promise<Response> {
  const session = await getSession();
  if (session === null) {
    const response = jsonError(401, 'unauthenticated');
    response.headers.set('WWW-Authenticate', 'Bearer');
    return response;
  }
  // The practice account is nobody on GitHub, so there is nobody to put in the room.
  if (session.demo) return jsonError(403, 'practice_session');
  if (!fromThisOrigin(request)) return jsonError(403, 'bad_origin');

  const livekit = liveKitConfig();
  // Under keys anyone can seal a session with, no session vouches for anyone
  // (getSession already refuses a real one there; this is the backstop).
  if (livekit === null || sessionKeys()?.practiceOnly !== false) return jsonError(503, 'voice_unavailable');

  const token = new AccessToken(livekit.apiKey, livekit.apiSecret, {
    identity: `gh:${session.sub}`,
    name: sanitizeName(session.login),
    ttl: TOKEN_TTL,
  });
  token.addGrant({
    roomJoin: true,
    room: ROOM,
    canPublish: true,
    canPublishSources: [TrackSource.MICROPHONE],
    canSubscribe: true,
    canPublishData: true,
    canUpdateOwnMetadata: false,
  });
  return Response.json(
    { url: livekit.url, token: await token.toJwt() },
    { status: 200, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } },
  );
}

export function GET(): Response {
  const response = jsonError(405, 'method_not_allowed');
  response.headers.set('Allow', 'POST');
  return response;
}

/** The BFF's Origin rule, and a browser's own word (`Sec-Fetch-Site`) when it gives one. */
function fromThisOrigin(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin') return false;
  return isTrustedOrigin(request.headers.get('origin'), new URL(request.url).origin);
}

function liveKitConfig(): LiveKitConfig | null {
  const url = process.env.LIVEKIT_URL;
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!url || !apiKey || !apiSecret || !isRoomUrl(url)) return null;
  return { url, apiKey, apiSecret };
}

function isRoomUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ROOM_URL_SCHEMES.has(url.protocol) && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}
