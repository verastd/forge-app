/**
 * The cave's bricks over the wire: the bricks BFF (`/bff/lobby/bricks`), every
 * answer parsed against @forge/shared's schemas, every refusal turned into a
 * `BrickRefusal` that says, in words, what happened.
 */

import { BRICK, BRICK_PROBLEM_TEXT } from '@forge/lobby';
import type { BrickProblem } from '@forge/lobby';
import { BrickChangeSchema, BrickListSchema, BrickMeSchema } from '@forge/shared';
import type { BrickChange, BrickList, BrickMake, BrickMe, BrickPlace } from '@forge/shared';

export const BRICKS_URL = '/bff/lobby/bricks';

/** A call the API (or the way to it) turned down: its status (0: never got there) and code. */
export class BrickRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly problem: BrickProblem | null = null,
  ) {
    super(refusalText(status, code, problem));
  }
}

const PROBLEMS = new Set<string>(['shape', 'outside', 'overlap', 'floating']);

/** What a refusal means, for the toast. */
export function refusalText(status: number, code: string, problem: BrickProblem | null): string {
  switch (code) {
    case 'wont_fit':
      return problem ? BRICK_PROBLEM_TEXT[problem] : 'It doesn’t fit there.';
    case 'taken':
      return 'Taken: someone got it first.';
    case 'frozen':
      return 'Part of a build: only the Lego bot can take it out.';
    case 'hands_full':
      return 'Your hands are full: place or drop that brick first.';
    case 'not_holding':
      return 'You’re not holding it any more (a hold lasts five minutes).';
    case 'not_the_maker':
      return 'Only the Lego bot makes and removes bricks.';
    case 'brick_limit':
      return `The cave is full: it holds ${BRICK.limit.toLocaleString('en')} bricks.`;
    case 'brick_not_found':
      return 'That brick is gone.';
    case 'unauthenticated':
      return 'Sign in with GitHub to build.';
    case 'practice_session':
      return 'The practice account can’t build: sign in with GitHub.';
    case 'lobby-disabled':
    case 'not_configured':
      return 'Building is switched off for now.';
    default:
      return status === 0 ? 'Couldn’t reach the server: check your connection and try again.' : 'Couldn’t save that: try again.';
  }
}

export interface BrickClient {
  list(since: number | null, signal?: AbortSignal): Promise<BrickList>;
  me(): Promise<BrickMe>;
  make(body: BrickMake): Promise<BrickChange>;
  pick(id: string): Promise<BrickChange>;
  place(id: string, at: BrickPlace): Promise<BrickChange>;
  remove(id: string): Promise<BrickChange>;
}

async function call<T>(
  fetchImpl: typeof fetch,
  path: string,
  init: RequestInit,
  parse: (body: unknown) => { success: true; data: T } | { success: false },
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(`${BRICKS_URL}${path}`, { cache: 'no-store', ...init });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw new BrickRefusal(0, 'network');
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // No JSON: the status alone says it.
  }
  if (!response.ok) {
    const record = (body ?? {}) as { error?: unknown; problem?: unknown };
    const code = typeof record.error === 'string' ? record.error : `http_${response.status}`;
    const problem = typeof record.problem === 'string' && PROBLEMS.has(record.problem) ? (record.problem as BrickProblem) : null;
    throw new BrickRefusal(response.status, code, problem);
  }
  const parsed = parse(body);
  if (!parsed.success) throw new BrickRefusal(response.status, 'unexpected_shape');
  return parsed.data;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export function createBrickClient(fetchImpl: typeof fetch = (...args) => fetch(...args)): BrickClient {
  const change = (body: unknown) => BrickChangeSchema.safeParse(body);
  return {
    list: (since, signal) =>
      call(fetchImpl, since === null ? '' : `?since=${since}`, signal ? { signal } : {}, (body) => BrickListSchema.safeParse(body)),
    me: () => call(fetchImpl, '/me', {}, (body) => BrickMeSchema.safeParse(body)),
    make: (body) => call(fetchImpl, '', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) }, change),
    pick: (id) => call(fetchImpl, `/${id}/pick`, { method: 'PUT' }, change),
    place: (id, at) => call(fetchImpl, `/${id}/place`, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(at) }, change),
    remove: (id) => call(fetchImpl, `/${id}`, { method: 'DELETE' }, change),
  };
}
