/**
 * The avatar editor's client for the avatars BFF (`/bff/avatars*`): reads,
 * saves and uploads, each answer checked against its @forge/shared schema.
 * Uploads go by XMLHttpRequest, the one browser API that reports upload
 * progress, so the editor can show a real progress bar.
 *
 * Every failure is an AvatarsError with a code (the API's `error`, or
 * `service_unreachable`, `timeout` or `bad_response` from here), which
 * `describeAvatarsError` turns into a sentence for the page.
 */

import {
  AvatarAccessSchema,
  AvatarHeadSchema,
  AvatarListSchema,
  AvatarMemberListSchema,
  AvatarSchema,
} from '@forge/shared';
import type {
  Avatar,
  AvatarChestType,
  AvatarHead,
  AvatarHeadFit,
  AvatarList,
  AvatarMemberList,
  AvatarUpdate,
} from '@forge/shared';

/** What a zod schema offers that this file uses. */
interface Schema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

const BASE = '/bff/avatars';
const TIMEOUT_MS = 30_000;
/** Uploads get longer: a 3 MB head on a slow connection. */
const UPLOAD_TIMEOUT_MS = 120_000;

export class AvatarsError extends Error {
  readonly code: string;
  readonly status: number | undefined;
  readonly reason: string | undefined;

  constructor(code: string, status?: number, reason?: string) {
    super(`avatars: ${code}${reason ? ` (${reason})` : ''}`);
    this.name = 'AvatarsError';
    this.code = code;
    this.status = status;
    this.reason = reason;
  }
}

function errorFrom(status: number, body: unknown): AvatarsError {
  const fields = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const code = typeof fields.error === 'string' ? fields.error : `http_${status}`;
  const reason = typeof fields.reason === 'string' ? fields.reason : undefined;
  return new AvatarsError(code, status, reason);
}

async function request<T>(method: 'GET' | 'PUT' | 'DELETE', path: string, schema: Schema<T> | null, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new AvatarsError(error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'service_unreachable');
  }
  if (response.status === 204) return undefined as T;
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) throw errorFrom(response.status, json);
  if (schema === null) return undefined as T;
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new AvatarsError('bad_response', response.status);
  return parsed.data;
}

export const fetchAvatars = (): Promise<AvatarList> => request('GET', '', AvatarListSchema);
export const fetchMembers = (): Promise<AvatarMemberList> => request('GET', '/members', AvatarMemberListSchema);

/**
 * Whether the signed-in caller may use the avatar editor (is an admin), for
 * the account menu. `/me` answers it. An API deployed before `/me` existed
 * answers it 404 with no code of its own, and then the admin-only member list
 * answers instead: listed means admin, `admin_only` means not. Robot avatars
 * switched off, or the practice account, is a plain no. Anything else (signed
 * out, unreachable, a timeout) throws an AvatarsError, so the menu can say it
 * couldn't check rather than quietly showing nothing.
 */
export async function fetchAvatarAccess(): Promise<boolean> {
  try {
    const access = await request('GET', '/me', AvatarAccessSchema);
    return access.canEdit;
  } catch (error) {
    if (!(error instanceof AvatarsError) || error.code !== 'http_404') return refusalOrThrow(error);
  }
  try {
    await fetchMembers();
    return true;
  } catch (error) {
    return refusalOrThrow(error);
  }
}

/** The answers that mean "no editor for you"; everything else is a failure. */
const NOT_AN_EDITOR = new Set(['admin_only', 'avatars-disabled', 'practice_session']);

function refusalOrThrow(error: unknown): false {
  if (error instanceof AvatarsError && NOT_AN_EDITOR.has(error.code)) return false;
  throw error;
}
export const saveAvatar = (memberId: string, update: AvatarUpdate): Promise<Avatar> =>
  request('PUT', `/members/${encodeURIComponent(memberId)}`, AvatarSchema, update);
export const resetAvatar = (memberId: string): Promise<void> =>
  request('DELETE', `/members/${encodeURIComponent(memberId)}`, null);
export const removeChest = (memberId: string): Promise<Avatar> =>
  request('DELETE', `/members/${encodeURIComponent(memberId)}/chest`, AvatarSchema);
export const deleteHead = (headId: string): Promise<void> => request('DELETE', `/heads/${encodeURIComponent(headId)}`, null);

/** Upload progress, 0..1, as the bytes leave the browser. */
export type OnProgress = (fraction: number) => void;

/** PUTs a JSON body by XHR, reporting upload progress; resolves with the parsed answer. */
function upload<T>(path: string, body: unknown, schema: Schema<T>, onProgress: OnProgress): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `${BASE}${path}`);
    xhr.setRequestHeader('content-type', 'application/json');
    xhr.setRequestHeader('accept', 'application/json');
    xhr.timeout = UPLOAD_TIMEOUT_MS;
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
    };
    xhr.upload.onload = () => onProgress(1);
    xhr.onerror = () => reject(new AvatarsError('service_unreachable'));
    xhr.ontimeout = () => reject(new AvatarsError('timeout'));
    xhr.onload = () => {
      let json: unknown = null;
      try {
        json = JSON.parse(xhr.responseText) as unknown;
      } catch {
        json = null;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(errorFrom(xhr.status, json));
        return;
      }
      const parsed = schema.safeParse(json);
      if (parsed.success) resolve(parsed.data);
      else reject(new AvatarsError('bad_response', xhr.status));
    };
    xhr.send(JSON.stringify(body));
  });
}

/** A file's bytes as base64 (chunked, so a few MB never overflows the call stack). */
export async function fileToBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function uploadChest(memberId: string, file: File, onProgress: OnProgress): Promise<Avatar> {
  const data = await fileToBase64(file);
  return upload(
    `/members/${encodeURIComponent(memberId)}/chest`,
    { contentType: file.type as AvatarChestType, data },
    AvatarSchema,
    onProgress,
  );
}

export async function uploadHead(
  headId: string,
  name: string,
  fit: AvatarHeadFit,
  file: File,
  onProgress: OnProgress,
): Promise<AvatarHead> {
  const data = await fileToBase64(file);
  return upload(`/heads/${encodeURIComponent(headId)}`, { name, fit, data }, AvatarHeadSchema, onProgress);
}

/** A head id from its name: lower case, dashes for anything else, at most 40 characters. */
export function headIdFrom(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

const REASONS: Record<string, string> = {
  not_png: 'That file isn’t really a PNG.',
  not_jpeg: 'That file isn’t really a JPEG.',
  not_webp: 'That file isn’t really a WebP.',
  too_many_pixels: 'That image is too big: 2048 pixels across and down at most.',
  not_glb: 'That isn’t a binary glTF 2.0 file (.glb).',
  not_gltf2: 'That file doesn’t say it is glTF 2.0 inside. Export it again as glTF 2.0 (.glb).',
  external_uri: 'That head points at files outside itself. Export it as one self-contained .glb.',
  buffer_uri: 'That head keeps its geometry in a data URI. Export it as a binary .glb, geometry in the file itself.',
  extension_required: 'That head needs a decoder the lobby doesn’t load (Draco, meshopt…). Export it uncompressed.',
  not_base64: 'The file didn’t arrive intact. Try again.',
  blank: 'Give it a name.',
};

/** A sentence for the page. */
export function describeAvatarsError(error: unknown): string {
  if (!(error instanceof AvatarsError)) return 'Something went wrong. Try again.';
  if (error.reason && REASONS[error.reason]) return REASONS[error.reason]!;
  switch (error.code) {
    case 'admin_only':
      return 'Only admins can change avatars.';
    case 'unauthenticated':
      return 'Your session ended. Sign in again.';
    case 'practice_session':
      return 'The practice account can’t change avatars. Sign in with GitHub.';
    case 'avatars-disabled':
      return 'Robot avatars are switched off (the lobby_avatars flag).';
    case 'file_too_large':
    case 'too_large':
    case 'body_too_large':
      return 'That file is too big.';
    case 'unknown_head':
      return 'That head is no longer in the library. Pick another.';
    case 'avatar_not_found':
      return 'Save this robot’s colours first.';
    case 'head_not_found':
      return 'That head is no longer in the library.';
    case 'timeout':
    case 'upstream_timeout':
      return 'The server took too long to answer. Try again.';
    case 'service_unreachable':
    case 'not_configured':
      return 'Couldn’t reach the server. Check your connection and try again.';
    case 'invalid_request':
      return 'The server refused that. Check the fields and try again.';
    default:
      return `The server refused that (${error.code}). Try again.`;
  }
}
