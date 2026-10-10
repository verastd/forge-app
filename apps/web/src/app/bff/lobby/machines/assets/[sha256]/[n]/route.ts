/**
 * A chunk of a machine blueprint's file, by its sha256:
 * `GET /bff/lobby/machines/assets/<sha256>/<n>`, fetched from
 * `${FORGE_API_URL}/api/lobby/machines/assets/<sha256>/<n>` with no identity
 * (machines are public: everyone in the cave sees them). A blueprint can be
 * bigger than a response may carry, so it comes MACHINE_CHUNK_BYTES at a time.
 *
 * Unlike the JSON forwards (`lib/bff-forward.ts`), this answers with raw bytes
 * and lets the browser keep them forever: a new file is a new hash, so a
 * cached chunk is never stale. No cookies or other headers go either way.
 */
import { apiUrl } from '../../../../../../../lib/auth/config';
import { bffError } from '../../../../../../../lib/bff-forward';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const SHA256 = /^[0-9a-f]{64}$/;
const CHUNK = /^[0-9]{1,2}$/;
const TIMEOUT_MS = 25_000;

interface Context {
  params: Promise<{ sha256: string; n: string }>;
}

export async function GET(_request: Request, { params }: Context): Promise<Response> {
  const { sha256, n } = await params;
  if (!SHA256.test(sha256) || !CHUNK.test(n)) return bffError(404, 'not_found');
  const base = apiUrl();
  if (base === null) return bffError(503, 'not_configured');

  let upstream: Response;
  try {
    upstream = await fetch(`${base}/api/lobby/machines/assets/${sha256}/${Number(n)}`, {
      headers: { accept: 'application/octet-stream' },
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
  if (!upstream.ok || type !== 'application/octet-stream') {
    await upstream.body?.cancel().catch(() => undefined);
    return bffError(502, 'bad_upstream');
  }
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    },
  });
}
