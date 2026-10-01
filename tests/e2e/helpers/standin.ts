/**
 * A stand-in API on the demo server's API port (DEMO_API_PORT, where that
 * server's FORGE_API_URL and rewrites point), shared by every spec that needs
 * one (auth.spec.ts, bridge-bff.spec.ts, connect.spec.ts).
 *
 * The port is shared, and nothing coordinates it across workers, so a stand-in
 * waits for the port to be free (`listenWhenFree`), holds it for one test, and
 * answers only the paths its test names: any other request is cut off the way
 * a closed port refuses it, so a parallel test expecting "the API is down"
 * still sees exactly that. (CI runs one worker, so there is no overlap there.)
 */
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';

import { DEMO_API_PORT } from './env';

/** One request the stand-in answered. */
export interface Seen {
  method: string;
  /** With its query string, as the request line had it. */
  path: string;
  headers: IncomingHttpHeaders;
  authorization: string | null;
  body: string;
}

export interface Answer {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Answer {
  return { status, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) };
}

/** Listens on `port`, waiting while another spec's stand-in holds it. */
export async function listenWhenFree(server: Server, port: number, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
      });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

/**
 * Runs `body` with `answer` serving DEMO_API_PORT, and hands it every request
 * that was answered. Unanswered requests are destroyed unread, as a closed
 * port would refuse them.
 */
export async function withStandIn(
  answer: (request: Seen) => Answer | undefined,
  body: (seen: Seen[]) => Promise<void>,
): Promise<void> {
  const seen: Seen[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const entry: Seen = {
        method: request.method ?? '',
        path: request.url ?? '',
        headers: request.headers,
        authorization: request.headers.authorization ?? null,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      const reply = answer(entry);
      if (reply === undefined) {
        request.socket.destroy();
        return;
      }
      seen.push(entry);
      response.writeHead(reply.status, reply.headers ?? {});
      response.end(reply.body);
    });
  });
  await listenWhenFree(server, DEMO_API_PORT);
  try {
    await body(seen);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

/** The claims of the assertion the web sent (`Authorization: Bearer <JWT>`), unverified. */
export function assertionClaims(authorization: string | null | undefined): Record<string, unknown> {
  const payload = (authorization ?? '').replace(/^Bearer /, '').split('.')[1] ?? '';
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}
