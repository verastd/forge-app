/**
 * A robot's stored file (a chestplate image or a library head), by its
 * sha256: `GET /bff/avatars/assets/<sha256>`, fetched from
 * `${FORGE_API_URL}/api/avatars/assets/<sha256>` with no identity (they are
 * public: everyone in the lobby sees everyone's robot).
 *
 * Unlike the JSON forwards (`lib/bff-forward.ts`), this answers with the
 * file's own type, from an allowlist of the four the API stores (anything
 * else is a 502), and lets the browser keep it forever: a new upload is a
 * new hash, so a cached copy is never stale. No cookies or other headers go
 * either way.
 */
import { apiUrl } from '../../../../../lib/auth/config';
import { bffError } from '../../../../../lib/bff-forward';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const SHA256 = /^[0-9a-f]{64}$/;
const TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'model/gltf-binary']);
const TIMEOUT_MS = 25_000;

interface Context {
  params: Promise<{ sha256: string }>;
}

export async function GET(_request: Request, { params }: Context): Promise<Response> {
  const { sha256 } = await params;
  if (!SHA256.test(sha256)) return bffError(404, 'not_found');
  const base = apiUrl();
  if (base === null) return bffError(503, 'not_configured');

  let upstream: Response;
  try {
    upstream = await fetch(`${base}/api/avatars/assets/${sha256}`, {
      headers: { accept: [...TYPES].join(', ') },
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return bffError(timedOut ? 504 : 502, timedOut ? 'upstream_timeout' : 'service_unreachable');
  }
  if (upstream.status === 404) {
    await upstream.body?.cancel().catch(() => undefined);
    return bffError(404, 'not_found');
  }
  const type = upstream.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!upstream.ok || !TYPES.has(type)) {
    await upstream.body?.cancel().catch(() => undefined);
    return bffError(502, 'bad_upstream');
  }
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': type,
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    },
  });
}
