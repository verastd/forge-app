/**
 * The cave's machines over the wire: the machines BFF (`/bff/lobby/machines`),
 * every answer parsed against @forge/shared's schemas, every refusal turned
 * into a `MachineRefusal` that says, in words, what happened. Blueprint files
 * go up and come down in MACHINE_CHUNK_BYTES chunks (a request or a response
 * carries a few megabytes at most), each step reported for a progress bar.
 */

import { MACHINE, MACHINE_PROBLEM_TEXT } from '@forge/lobby';
import type { MachineProblem } from '@forge/lobby';
import {
  MACHINE_BLUEPRINT_MAX_BYTES,
  MACHINE_CHUNK_BYTES,
  MachineBlueprintListSchema,
  MachineBlueprintSchema,
  MachineChangeSchema,
  MachineListSchema,
  MachineMeSchema,
  MachineUploadSchema,
} from '@forge/shared';
import type { MachineBlueprint, MachineBuild, MachineChange, MachineList, MachineMe, MachineUploadStart } from '@forge/shared';

export const MACHINES_URL = '/bff/lobby/machines';

/** A call the API (or the way to it) turned down: its status (0: never got there) and code. */
export class MachineRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly problem: MachineProblem | null = null,
  ) {
    super(machineRefusalText(status, code, problem));
  }
}

const PROBLEMS = new Set<string>(['outside', 'overlap', 'bricks']);
const megabytes = (bytes: number): string => `${Math.round(bytes / 1024 / 1024)} MB`;

/** What a refusal means, for the toast. */
export function machineRefusalText(status: number, code: string, problem: MachineProblem | null): string {
  switch (code) {
    case 'wont_fit':
      return problem ? MACHINE_PROBLEM_TEXT[problem] : 'It doesn’t fit there.';
    case 'machine_limit':
      return `The cave is full: it holds ${MACHINE.limit} machines. Take one down first.`;
    case 'not_the_mechanic':
      return 'Only the mechanic builds machines.';
    case 'admin_only':
      return 'Only admins can take over the mechanic.';
    case 'blueprint_not_found':
      return 'That blueprint is gone from the library.';
    case 'machine_not_found':
      return 'That machine is already gone.';
    case 'upload_not_found':
      return 'That upload ran out of time: start it again.';
    case 'upload_incomplete':
      return 'Part of the file didn’t arrive: start the upload again.';
    case 'file_too_large':
      return `That file is too big (the most is ${megabytes(MACHINE_BLUEPRINT_MAX_BYTES)}).`;
    case 'invalid_request':
      return 'That file isn’t a model the lobby can show (a self-contained .glb, no Draco or meshopt compression).';
    case 'asset_not_found':
      return 'That machine’s blueprint file is missing.';
    case 'unauthenticated':
      return 'Sign in with GitHub to build.';
    case 'practice_session':
      return 'The practice account can’t build: sign in with GitHub.';
    case 'lobby-disabled':
    case 'not_configured':
      return 'Building is switched off for now.';
    default:
      return status === 0 ? 'Couldn’t reach the server: check your connection and try again.' : 'Something went wrong: try again.';
  }
}

/** How far an upload or a download is: what it's doing, and how much of it is done (0–1). */
export type Progress = (fraction: number) => void;

export interface MachineClient {
  list(since: number | null, signal?: AbortSignal): Promise<MachineList>;
  me(): Promise<MachineMe>;
  standIn(on: boolean): Promise<MachineMe>;
  blueprints(signal?: AbortSignal): Promise<MachineBlueprint[]>;
  /** The mechanic: a blueprint into the library, its file in chunks. */
  upload(meta: Omit<MachineUploadStart, 'bytes' | 'sha256'>, file: ArrayBuffer, progress: Progress, signal: AbortSignal): Promise<MachineBlueprint>;
  deleteBlueprint(id: string): Promise<void>;
  build(body: MachineBuild): Promise<MachineChange>;
  takeDown(id: string): Promise<MachineChange>;
  /** A blueprint's file, by its hash and size, a chunk at a time. */
  file(sha256: string, bytes: number, progress: Progress, signal?: AbortSignal): Promise<ArrayBuffer>;
}

async function call<T>(
  fetchImpl: typeof fetch,
  path: string,
  init: RequestInit,
  parse: ((body: unknown) => { success: true; data: T } | { success: false }) | null,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(`${MACHINES_URL}${path}`, { cache: 'no-store', ...init });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw new MachineRefusal(0, 'network');
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // No JSON (a 204, or a proxy's page): the status alone says it.
  }
  if (!response.ok) {
    const record = (body ?? {}) as { error?: unknown; problem?: unknown };
    const code = typeof record.error === 'string' ? record.error : `http_${response.status}`;
    const problem = typeof record.problem === 'string' && PROBLEMS.has(record.problem) ? (record.problem as MachineProblem) : null;
    throw new MachineRefusal(response.status, code, problem);
  }
  if (parse === null) return undefined as T;
  const parsed = parse(body);
  if (!parsed.success) throw new MachineRefusal(response.status, 'unexpected_shape');
  return parsed.data;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** Bytes as base64, a slice at a time (a whole chunk spread into one call overflows the stack). */
export function toBase64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function createMachineClient(fetchImpl: typeof fetch = (...args) => fetch(...args)): MachineClient {
  const change = (body: unknown) => MachineChangeSchema.safeParse(body);
  const me = (body: unknown) => MachineMeSchema.safeParse(body);
  return {
    list: (since, signal) => call(fetchImpl, since === null ? '' : `?since=${since}`, signal ? { signal } : {}, (b) => MachineListSchema.safeParse(b)),
    me: () => call(fetchImpl, '/me', {}, me),
    standIn: (on) => call(fetchImpl, '/me/stand-in', { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ on }) }, me),
    blueprints: async (signal) =>
      (await call(fetchImpl, '/blueprints', signal ? { signal } : {}, (b) => MachineBlueprintListSchema.safeParse(b))).blueprints,
    async upload(meta, file, progress, signal) {
      if (file.byteLength > MACHINE_BLUEPRINT_MAX_BYTES) throw new MachineRefusal(413, 'file_too_large');
      const sha256 = await sha256Hex(file);
      const started = await call(
        fetchImpl,
        '/blueprints',
        { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ ...meta, bytes: file.byteLength, sha256 }), signal },
        (b) => MachineUploadSchema.safeParse(b),
      );
      const bytes = new Uint8Array(file);
      try {
        for (let n = 0; n < started.chunks; n += 1) {
          const piece = bytes.subarray(n * started.chunkBytes, (n + 1) * started.chunkBytes);
          await call(
            fetchImpl,
            `/blueprints/${started.id}/chunks/${n}`,
            { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ data: toBase64(piece) }), signal },
            null,
          );
          progress((n + 1) / started.chunks);
        }
        return await call(fetchImpl, `/blueprints/${started.id}/finish`, { method: 'POST', signal }, (b) => MachineBlueprintSchema.safeParse(b));
      } catch (error) {
        // Don't leave half an upload behind (best effort: the API drops it in an hour anyway).
        void call(fetchImpl, `/blueprints/${started.id}`, { method: 'DELETE' }, null).catch(() => undefined);
        throw error;
      }
    },
    deleteBlueprint: (id) => call(fetchImpl, `/blueprints/${id}`, { method: 'DELETE' }, null),
    build: (body) => call(fetchImpl, '', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) }, change),
    takeDown: (id) => call(fetchImpl, `/${id}`, { method: 'DELETE' }, change),
    async file(sha256, bytes, progress, signal) {
      const count = Math.max(1, Math.ceil(bytes / MACHINE_CHUNK_BYTES));
      const out = new Uint8Array(bytes);
      for (let n = 0; n < count; n += 1) {
        let response: Response;
        try {
          // Cacheable forever: a new file is a new hash.
          response = await fetchImpl(`${MACHINES_URL}/assets/${sha256}/${n}`, signal ? { signal } : {});
        } catch (error) {
          if ((error as Error).name === 'AbortError') throw error;
          throw new MachineRefusal(0, 'network');
        }
        if (!response.ok) throw new MachineRefusal(response.status, response.status === 404 ? 'asset_not_found' : `http_${response.status}`);
        const piece = new Uint8Array(await response.arrayBuffer());
        if (n * MACHINE_CHUNK_BYTES + piece.length > bytes) throw new MachineRefusal(response.status, 'unexpected_shape');
        out.set(piece, n * MACHINE_CHUNK_BYTES);
        progress((n + 1) / count);
      }
      return out.buffer;
    },
  };
}
