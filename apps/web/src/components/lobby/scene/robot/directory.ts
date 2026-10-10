/**
 * Who looks like what: the avatars BFF's list (every dressed robot and the
 * head library), read when the lobby opens and again every minute, so an
 * admin's change reaches everyone in the room without a reload.
 *
 * A member nobody has dressed, and everyone while the list hasn't arrived
 * (or can't: signed out on a server without the API, the practice account),
 * wears their default: @forge/lobby's palette for their id, their own head
 * and their emblem. The lobby never waits on this list to draw anyone.
 */

import { defaultColors } from '@forge/lobby';
import { AvatarListSchema } from '@forge/shared';
import type { AvatarHead, AvatarList } from '@forge/shared';

import type { RobotLook } from './view';

export const AVATARS_URL = '/bff/avatars';
export const REFRESH_MS = 60_000;
/** After a read that failed on the way (offline, a 5xx), sooner than the usual minute. */
const RETRY_MS = 15_000;

/** A refusal that asking again soon won't change: avatars off (404), the practice account (403), signed out (401). */
class Refused extends Error {}

export interface AvatarDirectory {
  /** How `id` (whose display name is `name`) looks right now. */
  look(id: string, name: string): RobotLook;
  /** Bumps whenever the list changes, so callers know to look again. */
  readonly version: number;
  dispose(): void;
}

export function lookFrom(list: AvatarList | null, id: string, name: string): RobotLook {
  const dressed = list?.avatars.find((avatar) => avatar.memberId === id);
  const head: AvatarHead | null = dressed?.head ? (list?.heads.find((h) => h.id === dressed.head) ?? null) : null;
  const accessory: AvatarHead | null = dressed?.accessory ? (list?.heads.find((h) => h.id === dressed.accessory) ?? null) : null;
  const back: AvatarHead | null = dressed?.back ? (list?.heads.find((h) => h.id === dressed.back) ?? null) : null;
  return {
    id,
    name,
    colors: dressed?.colors ?? defaultColors(id),
    head,
    accessory,
    chest: dressed?.chest ?? null,
    chestType: dressed?.chestType ?? null,
    finish: dressed?.finish ?? null,
    back,
    cape: dressed?.cape ?? null,
    chestGlow: dressed?.chestGlow ?? null,
  };
}

export function createAvatarDirectory(fetchImpl: typeof fetch = fetch): AvatarDirectory {
  let list: AvatarList | null = null;
  let version = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | null = null;
  let disposed = false;

  const read = async (): Promise<void> => {
    controller = new AbortController();
    let wait = REFRESH_MS;
    try {
      const response = await fetchImpl(AVATARS_URL, { signal: controller.signal, cache: 'no-store' });
      if (response.status >= 400 && response.status < 500) throw new Refused(`avatars ${response.status}`);
      if (!response.ok) throw new Error(`avatars ${response.status}`);
      const parsed = AvatarListSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error('avatars: unexpected shape');
      if (JSON.stringify(parsed.data) !== JSON.stringify(list)) {
        list = parsed.data;
        version += 1;
      }
    } catch (error) {
      // Keep whatever we had; everyone else wears their default meanwhile.
      if (!(error instanceof Refused)) wait = RETRY_MS;
    } finally {
      controller = null;
    }
    if (!disposed) timer = setTimeout(() => void read(), wait);
  };
  void read();

  return {
    look(id, name) {
      return lookFrom(list, id, name);
    },
    get version() {
      return version;
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      controller?.abort();
    },
  };
}
