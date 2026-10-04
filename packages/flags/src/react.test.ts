import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlagConfig } from '@forge/shared';

import { DEFAULT_FLAGS, FLAGS_TIMEOUT_MS, fetchFlags } from './core.js';

/**
 * The flag client's network half: `fetchFlags` (core) and the `useFlags`
 * hook built on it (react). The hook is driven without a renderer: `react`
 * is replaced by a stand-in that records each `useState` slot and runs
 * nothing until the test calls the effect, which is all the hook needs.
 */

interface Slot {
  value: unknown;
  set: (next: unknown) => void;
}

const react = vi.hoisted(() => ({
  slots: [] as Slot[],
  effects: [] as Array<() => void | (() => void)>,
}));

vi.mock('react', () => ({
  useState: (initial: unknown) => {
    const slot: Slot = {
      value: initial,
      set: (next: unknown) => {
        slot.value = next;
      },
    };
    react.slots.push(slot);
    return [initial, slot.set];
  },
  useEffect: (effect: () => void | (() => void)) => {
    react.effects.push(effect);
  },
}));

const { useFlags } = await import('./react.js');

const ALL_ON: FlagConfig = {
  csv_export: true,
  contribute_bridge: true,
  upland_data: true,
  github_signin: true,
  apps_lobby: true,
  mcp_connector: true,
  agent_start: true,
  proposals: true,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A request that never answers, and ignores its abort signal too. */
const hangs = (): Promise<Response> => new Promise<Response>(() => undefined);

/** Mount `useFlags` once: its two state slots, and its effect run. */
function mount(initial?: FlagConfig): { flags: Slot; loading: Slot; unmount: () => void } {
  react.slots.length = 0;
  react.effects.length = 0;
  useFlags(initial);
  const [flags, loading] = react.slots;
  const effect = react.effects[0];
  if (flags === undefined || loading === undefined || effect === undefined) throw new Error('useFlags changed shape');
  const cleanup = effect();
  return { flags, loading, unmount: () => cleanup?.() };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('fetchFlags', () => {
  it('parses what the flag service answers', async () => {
    const fetchImpl = vi.fn(async () => json({ ...DEFAULT_FLAGS, proposals: true }));
    await expect(fetchFlags('http://api.test/api/flags', { fetchImpl })).resolves.toEqual({
      ...DEFAULT_FLAGS,
      proposals: true,
    });
    expect(fetchImpl).toHaveBeenCalledWith('http://api.test/api/flags', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('answers null, never a throw, for a refusal, a body that is not JSON, or no connection', async () => {
    await expect(fetchFlags('u', { fetchImpl: async () => json({ error: 'down' }, 503) })).resolves.toBeNull();
    await expect(fetchFlags('u', { fetchImpl: async () => new Response('<html>', { status: 200 }) })).resolves.toBeNull();
    await expect(
      fetchFlags('u', {
        fetchImpl: async () => {
          throw new TypeError('Failed to fetch');
        },
      }),
    ).resolves.toBeNull();
  });

  it(`gives up after ${FLAGS_TIMEOUT_MS} ms, aborting the request, even if it never settles`, async () => {
    let signal: AbortSignal | undefined;
    const pending = fetchFlags('u', {
      fetchImpl: (_url, init) => {
        signal = init?.signal ?? undefined;
        return hangs();
      },
    });
    let settled: FlagConfig | null | 'pending' = 'pending';
    void pending.then((value) => {
      settled = value;
    });
    await vi.advanceTimersByTimeAsync(FLAGS_TIMEOUT_MS - 1);
    expect(settled).toBe('pending');
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBeNull();
    expect(signal?.aborted).toBe(true);
  });

  it('gives up on a body that never finishes, and takes a shorter wait when asked', async () => {
    const stalled = { ok: true, status: 200, json: hangs } as unknown as Response;
    const pending = fetchFlags('u', { fetchImpl: async () => stalled, timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toBeNull();
  });
});

describe('useFlags', () => {
  it('a flag service that never answers fails closed after 8 s, and loading ends', async () => {
    vi.stubGlobal('fetch', vi.fn(hangs));
    const { flags, loading } = mount();
    expect(loading.value).toBe(true);
    await vi.advanceTimersByTimeAsync(FLAGS_TIMEOUT_MS - 1);
    expect(loading.value).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(loading.value).toBe(false);
    expect(flags.value).toEqual(DEFAULT_FLAGS);
  });

  it('the fallback it was given is what silence means (the practice app passes all-on)', async () => {
    vi.stubGlobal('fetch', vi.fn(hangs));
    const { flags, loading } = mount(ALL_ON);
    await vi.advanceTimersByTimeAsync(FLAGS_TIMEOUT_MS);
    expect(loading.value).toBe(false);
    expect(flags.value).toEqual(ALL_ON);
  });

  it('an answer wins over the fallback, and an answer that comes in time ends loading at once', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ...DEFAULT_FLAGS, proposals: true })));
    const { flags, loading } = mount(ALL_ON);
    await vi.advanceTimersByTimeAsync(0);
    expect(loading.value).toBe(false);
    expect(flags.value).toEqual({ ...DEFAULT_FLAGS, proposals: true });
  });

  it('nothing is set once the component has gone', async () => {
    vi.stubGlobal('fetch', vi.fn(hangs));
    const { flags, loading, unmount } = mount();
    unmount();
    await vi.advanceTimersByTimeAsync(FLAGS_TIMEOUT_MS);
    expect(loading.value).toBe(true);
    expect(flags.value).toEqual(DEFAULT_FLAGS);
  });
});
