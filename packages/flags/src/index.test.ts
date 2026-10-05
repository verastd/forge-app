import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FLAG_NAMES } from '@forge/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_FLAGS, isEnabled, loadFlags, parseFlags } from './index.js';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

describe('client safety', () => {
  // apps/web bundles `./react` (and through it `./core`) for the browser. A
  // static `node:` import anywhere on that path breaks `next build`, so this
  // guards the boundary at the source level instead of at bundle time.
  it.each(['core.ts', 'react.ts'])('%s has no static node: import', async (file) => {
    const source = await readFile(join(SRC_DIR, file), 'utf8');
    expect(source).not.toMatch(/^\s*import\s[^;]*['"]node:/m);
  });

  it('keeps the node: built-ins in index.ts dynamic', async () => {
    const source = await readFile(join(SRC_DIR, 'index.ts'), 'utf8');
    expect(source).not.toMatch(/^\s*import\s[^;]*['"]node:/m);
    expect(source).toMatch(/await import\('node:fs\/promises'\)/);
  });
});

describe('parseFlags', () => {
  it('accepts a fully valid config unchanged', () => {
    expect(
      parseFlags({
        csv_export: false,
        contribute_bridge: true,
        upland_data: true,
        github_signin: true,
        apps_lobby: true,
        mcp_connector: true,
        agent_start: false,
        proposals: true,
        house_spec: true,
        lobby_avatars: true,
      }),
    ).toEqual({
      csv_export: false,
      contribute_bridge: true,
      upland_data: true,
      github_signin: true,
      apps_lobby: true,
      mcp_connector: true,
      agent_start: false,
      proposals: true,
      house_spec: true,
      lobby_avatars: true,
    });
  });

  it('merges a partial valid config over the defaults', () => {
    expect(parseFlags({ csv_export: false })).toEqual({
      csv_export: false,
      contribute_bridge: DEFAULT_FLAGS.contribute_bridge,
      upland_data: DEFAULT_FLAGS.upland_data,
      github_signin: DEFAULT_FLAGS.github_signin,
      apps_lobby: DEFAULT_FLAGS.apps_lobby,
      mcp_connector: DEFAULT_FLAGS.mcp_connector,
      agent_start: DEFAULT_FLAGS.agent_start,
      proposals: DEFAULT_FLAGS.proposals,
      house_spec: DEFAULT_FLAGS.house_spec,
      lobby_avatars: DEFAULT_FLAGS.lobby_avatars,
    });
  });

  it('a known flag key holding a non-boolean fails the whole parse closed — no partial salvage', () => {
    // contribute_bridge is validly `true` here, but csv_export is corrupt: the
    // fail-closed contract says the *whole* result must be all-false, not
    // "keep the valid keys, zero out the bad one". A typo on one kill switch
    // must not leave a sibling kill switch silently on.
    expect(parseFlags({ csv_export: 'nope', contribute_bridge: true })).toEqual({
      csv_export: false,
      contribute_bridge: false,
      upland_data: false,
      github_signin: false,
      apps_lobby: false,
      mcp_connector: false,
      agent_start: false,
      proposals: false,
      house_spec: false,
      lobby_avatars: false,
    });
  });

  it('ignores unknown extra keys', () => {
    expect(
      parseFlags({
        csv_export: true,
        contribute_bridge: true,
        upland_data: false,
        github_signin: true,
        apps_lobby: true,
        mcp_connector: true,
        agent_start: false,
        proposals: false,
        house_spec: false,
        lobby_avatars: false,
        unknown_flag: true,
      }),
    ).toEqual({
      csv_export: true,
      contribute_bridge: true,
      upland_data: false,
      github_signin: true,
      apps_lobby: true,
      mcp_connector: true,
      agent_start: false,
      proposals: false,
      house_spec: false,
      lobby_avatars: false,
    });
  });

  it('leaves apps_lobby off when a payload predates it (an older API, a hand-written mock)', () => {
    expect(parseFlags({ csv_export: true, contribute_bridge: true, upland_data: true, github_signin: true })).toEqual({
      csv_export: true,
      contribute_bridge: true,
      upland_data: true,
      github_signin: true,
      apps_lobby: false,
      mcp_connector: false,
      agent_start: false,
      proposals: false,
      house_spec: false,
      lobby_avatars: false,
    });
  });

  it('leaves mcp_connector and agent_start off when a payload predates them', () => {
    const result = parseFlags({
      csv_export: true,
      contribute_bridge: true,
      upland_data: true,
      github_signin: true,
      apps_lobby: true,
    });
    expect(result.mcp_connector).toBe(false);
    expect(result.agent_start).toBe(false);
    expect(result.apps_lobby).toBe(true);
  });

  it('leaves proposals off when a payload predates it', () => {
    const result = parseFlags({
      csv_export: true,
      contribute_bridge: true,
      upland_data: true,
      github_signin: true,
      apps_lobby: true,
      mcp_connector: true,
      agent_start: true,
    });
    expect(result.proposals).toBe(false);
    expect(result.agent_start).toBe(true);
  });

  it('leaves house_spec off when a payload predates it', () => {
    const result = parseFlags({
      csv_export: true,
      contribute_bridge: true,
      upland_data: true,
      github_signin: true,
      apps_lobby: true,
      mcp_connector: true,
      agent_start: true,
      proposals: true,
    });
    expect(result.house_spec).toBe(false);
    expect(result.proposals).toBe(true);
  });

  it('leaves lobby_avatars off when a payload predates it', () => {
    const before: Record<string, boolean> = { ...DEFAULT_FLAGS, apps_lobby: true };
    delete before.lobby_avatars;
    const result = parseFlags(before);
    expect(result.lobby_avatars).toBe(false);
    expect(result.apps_lobby).toBe(true);
  });

  it.each(['mcp_connector', 'agent_start', 'proposals', 'house_spec', 'lobby_avatars'])(
    'a non-boolean %s fails every flag closed',
    (name) => {
      expect(parseFlags({ csv_export: true, mcp_connector: true, [name]: 'true' })).toEqual(DEFAULT_FLAGS);
    },
  );

  it('DEFAULT_FLAGS covers every flag, all off', () => {
    expect(Object.keys(DEFAULT_FLAGS)).toEqual([...FLAG_NAMES]);
    expect(Object.values(DEFAULT_FLAGS).every((value) => value === false)).toBe(true);
  });

  it('a non-boolean apps_lobby fails every flag closed', () => {
    expect(
      parseFlags({ csv_export: true, contribute_bridge: true, upland_data: true, github_signin: true, apps_lobby: 'true' }),
    ).toEqual(DEFAULT_FLAGS);
  });

  it('never throws and falls back to defaults for non-object input', () => {
    expect(parseFlags(null)).toEqual(DEFAULT_FLAGS);
    expect(parseFlags(undefined)).toEqual(DEFAULT_FLAGS);
    expect(parseFlags('nonsense')).toEqual(DEFAULT_FLAGS);
    expect(parseFlags(42)).toEqual(DEFAULT_FLAGS);
    expect(parseFlags([1, 2, 3])).toEqual(DEFAULT_FLAGS);
    expect(() => parseFlags(Symbol('x'))).not.toThrow();
  });
});

describe('isEnabled', () => {
  it('reads the named flag out of a resolved config', () => {
    const flags = {
      csv_export: true,
      contribute_bridge: false,
      upland_data: true,
      github_signin: true,
      apps_lobby: true,
      mcp_connector: true,
      agent_start: false,
      proposals: true,
      house_spec: false,
      lobby_avatars: false,
    };
    expect(isEnabled(flags, 'csv_export')).toBe(true);
    expect(isEnabled(flags, 'contribute_bridge')).toBe(false);
    expect(isEnabled(flags, 'upland_data')).toBe(true);
    expect(isEnabled(flags, 'github_signin')).toBe(true);
    expect(isEnabled(flags, 'apps_lobby')).toBe(true);
    expect(isEnabled(flags, 'mcp_connector')).toBe(true);
    expect(isEnabled(flags, 'agent_start')).toBe(false);
    expect(isEnabled(flags, 'proposals')).toBe(true);
    expect(isEnabled(flags, 'house_spec')).toBe(false);
    expect(isEnabled({ ...flags, house_spec: true }, 'house_spec')).toBe(true);
  });
});

describe('loadFlags precedence', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Point cwd at a fresh, empty temp dir so the always-attempted repo
   * config/flags.json layer is cleanly ABSENT and can't bleed the real
   * (mostly-true) repo file into a test that means to isolate other layers. */
  async function useEmptyCwd(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'forge-flags-'));
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    return dir;
  }

  it('an explicit configPath file fully overrides the defaults when no repo config is found', async () => {
    const dir = await useEmptyCwd();
    try {
      const filePath = join(dir, 'flags.json');
      await writeFile(filePath, JSON.stringify({ csv_export: false, contribute_bridge: true }));

      const result = await loadFlags({ configPath: filePath, env: {} });

      expect(result).toEqual({
        csv_export: false,
        contribute_bridge: true,
        upland_data: false,
        github_signin: false,
        apps_lobby: false,
        mcp_connector: false,
        agent_start: false,
        proposals: false,
        house_spec: false,
        lobby_avatars: false,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a partial configPath file merges over the defaults, leaving the other flag at its default', async () => {
    const dir = await useEmptyCwd();
    try {
      const filePath = join(dir, 'flags.json');
      await writeFile(filePath, JSON.stringify({ csv_export: true })); // contribute_bridge omitted

      const result = await loadFlags({ configPath: filePath, env: {} });

      expect(result).toEqual({
        csv_export: true,
        contribute_bridge: DEFAULT_FLAGS.contribute_bridge,
        upland_data: DEFAULT_FLAGS.upland_data,
        github_signin: DEFAULT_FLAGS.github_signin,
        apps_lobby: DEFAULT_FLAGS.apps_lobby,
        mcp_connector: DEFAULT_FLAGS.mcp_connector,
        agent_start: DEFAULT_FLAGS.agent_start,
        proposals: DEFAULT_FLAGS.proposals,
        house_spec: DEFAULT_FLAGS.house_spec,
        lobby_avatars: DEFAULT_FLAGS.lobby_avatars,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('env.FORGE_FLAGS_PATH is honored when configPath is not set', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-flags-'));
    try {
      const filePath = join(dir, 'flags.json');
      await writeFile(filePath, JSON.stringify({ csv_export: false, contribute_bridge: true }));

      const result = await loadFlags({ env: { FORGE_FLAGS_PATH: filePath } });

      // cwd is not mocked here, so the walk-up finds the real repo
      // config/flags.json as layer 1; the flags the path layer leaves alone
      // survive from it: all true except agent_start.
      expect(result).toEqual({
        csv_export: false,
        contribute_bridge: true,
        upland_data: true,
        github_signin: true,
        apps_lobby: true,
        mcp_connector: true,
        agent_start: false,
        proposals: true,
        house_spec: true,
        lobby_avatars: true,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('walks up from process.cwd() (max 5 levels) to find config/flags.json', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-flags-walkup-'));
    try {
      const nested = join(root, 'a', 'b', 'c');
      await mkdir(nested, { recursive: true });
      await mkdir(join(root, 'config'), { recursive: true });
      await writeFile(
        join(root, 'config', 'flags.json'),
        JSON.stringify({ csv_export: false, contribute_bridge: false }),
      );

      vi.spyOn(process, 'cwd').mockReturnValue(nested);

      const result = await loadFlags({ env: {} });

      expect(result).toEqual({
        csv_export: false,
        contribute_bridge: false,
        upland_data: false,
        github_signin: false,
        apps_lobby: false,
        mcp_connector: false,
        agent_start: false,
        proposals: false,
        house_spec: false,
        lobby_avatars: false,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('finds the real repo config/flags.json by walking up from this package', async () => {
    // No mocking: this test relies on `pnpm --filter` running the test
    // script with cwd = packages/flags, two levels below the repo root
    // that owns config/flags.json. config/flags.json — not DEFAULT_FLAGS —
    // is what keeps local/demo behavior enabled (see core.ts); agent_start
    // stays off there until its rails pass the live tests, and proposals and
    // house_spec are on so the operator can test the floor and the house model,
    // and lobby_avatars puts the robots in the lobby.
    const result = await loadFlags({ env: {} });
    expect(result).toEqual({
      csv_export: true,
      contribute_bridge: true,
      upland_data: true,
      github_signin: true,
      apps_lobby: true,
      mcp_connector: true,
      agent_start: false,
      proposals: true,
      house_spec: true,
      lobby_avatars: true,
    });
  });

  it('falls back to all-false defaults when no source is found anywhere above cwd', async () => {
    const dir = await useEmptyCwd();
    try {
      const result = await loadFlags({ env: {} });

      expect(result).toEqual(DEFAULT_FLAGS);
      expect(result).toEqual({
        csv_export: false,
        contribute_bridge: false,
        upland_data: false,
        github_signin: false,
        apps_lobby: false,
        mcp_connector: false,
        agent_start: false,
        proposals: false,
        house_spec: false,
        lobby_avatars: false,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('composes config/flags.json < FORGE_FLAGS_PATH < FORGE_FLAGS_JSON in order, and untouched flags persist across layers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-flags-layers-'));
    try {
      vi.spyOn(process, 'cwd').mockReturnValue(dir);
      await mkdir(join(dir, 'config'), { recursive: true });
      // Layer 1 (repo config): both flags on.
      await writeFile(
        join(dir, 'config', 'flags.json'),
        JSON.stringify({ csv_export: true, contribute_bridge: true }),
      );
      const pathFile = join(dir, 'override.json');
      // Layer 2 (FORGE_FLAGS_PATH): turns csv_export off, doesn't mention contribute_bridge.
      await writeFile(pathFile, JSON.stringify({ csv_export: false }));

      const result = await loadFlags({
        env: {
          FORGE_FLAGS_PATH: pathFile,
          // Layer 3 (FORGE_FLAGS_JSON): turns csv_export back on, doesn't mention contribute_bridge.
          FORGE_FLAGS_JSON: JSON.stringify({ csv_export: true }),
        },
      });

      // csv_export: true (layer 1) -> false (layer 2) -> true (layer 3): the last layer wins.
      // contribute_bridge: never touched after layer 1, so it survives unchanged.
      // upland_data, github_signin, apps_lobby: no layer ever mentions them, so
      // they stay at their all-false default.
      expect(result).toEqual({
        csv_export: true,
        contribute_bridge: true,
        upland_data: false,
        github_signin: false,
        apps_lobby: false,
        mcp_connector: false,
        agent_start: false,
        proposals: false,
        house_spec: false,
        lobby_avatars: false,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('ignores unknown keys in an otherwise-valid layer instead of treating them as invalid', async () => {
    const dir = await useEmptyCwd();
    try {
      const filePath = join(dir, 'flags.json');
      await writeFile(
        filePath,
        JSON.stringify({ csv_export: true, some_future_flag: true, another_unknown: 'x' }),
      );

      const result = await loadFlags({ configPath: filePath, env: {} });

      expect(result).toEqual({
        csv_export: true,
        contribute_bridge: DEFAULT_FLAGS.contribute_bridge,
        upland_data: DEFAULT_FLAGS.upland_data,
        github_signin: DEFAULT_FLAGS.github_signin,
        apps_lobby: DEFAULT_FLAGS.apps_lobby,
        mcp_connector: DEFAULT_FLAGS.mcp_connector,
        agent_start: DEFAULT_FLAGS.agent_start,
        proposals: DEFAULT_FLAGS.proposals,
        house_spec: DEFAULT_FLAGS.house_spec,
        lobby_avatars: DEFAULT_FLAGS.lobby_avatars,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  describe('fail-closed: a present-but-invalid source zeroes out the whole result', () => {
    it('malformed FORGE_FLAGS_JSON fails closed, even over a valid earlier layer', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'forge-flags-'));
      try {
        vi.spyOn(process, 'cwd').mockReturnValue(dir);
        await mkdir(join(dir, 'config'), { recursive: true });
        await writeFile(
          join(dir, 'config', 'flags.json'),
          JSON.stringify({ csv_export: true, contribute_bridge: true }),
        );

        const result = await loadFlags({ env: { FORGE_FLAGS_JSON: '{not valid json' } });

        expect(result).toEqual({
          csv_export: false,
          contribute_bridge: false,
          upland_data: false,
          github_signin: false,
          apps_lobby: false,
          mcp_connector: false,
          agent_start: false,
          proposals: false,
          house_spec: false,
          lobby_avatars: false,
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('a malformed config/flags.json found by the walk-up itself fails closed', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'forge-flags-repo-bad-'));
      try {
        vi.spyOn(process, 'cwd').mockReturnValue(dir);
        await mkdir(join(dir, 'config'), { recursive: true });
        await writeFile(join(dir, 'config', 'flags.json'), '{not valid json');

        const result = await loadFlags({ env: {} });

        expect(result).toEqual({
          csv_export: false,
          contribute_bridge: false,
          upland_data: false,
          github_signin: false,
          apps_lobby: false,
          mcp_connector: false,
          agent_start: false,
          proposals: false,
          house_spec: false,
          lobby_avatars: false,
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('a configPath file that is not valid JSON fails closed', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'forge-flags-bad-'));
      try {
        const filePath = join(dir, 'flags.json');
        await writeFile(filePath, '{not valid json');

        await expect(loadFlags({ configPath: filePath, env: {} })).resolves.toEqual({
          csv_export: false,
          contribute_bridge: false,
          upland_data: false,
          github_signin: false,
          apps_lobby: false,
          mcp_connector: false,
          agent_start: false,
          proposals: false,
          house_spec: false,
          lobby_avatars: false,
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('a FORGE_FLAGS_PATH pointing at a file that does not exist fails closed', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'forge-flags-missing-'));
      try {
        const missingPath = join(dir, 'does-not-exist.json');

        const result = await loadFlags({ configPath: missingPath, env: {} });

        expect(result).toEqual({
          csv_export: false,
          contribute_bridge: false,
          upland_data: false,
          github_signin: false,
          apps_lobby: false,
          mcp_connector: false,
          agent_start: false,
          proposals: false,
          house_spec: false,
          lobby_avatars: false,
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('a known flag key holding a non-boolean fails closed, even when a sibling key in the same layer is validly true', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'forge-flags-'));
      try {
        vi.spyOn(process, 'cwd').mockReturnValue(dir);
        await mkdir(join(dir, 'config'), { recursive: true });
        await writeFile(
          join(dir, 'config', 'flags.json'),
          JSON.stringify({ csv_export: true, contribute_bridge: true }),
        );

        const result = await loadFlags({
          env: { FORGE_FLAGS_JSON: JSON.stringify({ csv_export: 'nope', contribute_bridge: true }) },
        });

        expect(result).toEqual({
          csv_export: false,
          contribute_bridge: false,
          upland_data: false,
          github_signin: false,
          apps_lobby: false,
          mcp_connector: false,
          agent_start: false,
          proposals: false,
          house_spec: false,
          lobby_avatars: false,
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('a non-object top-level payload fails closed (FORGE_FLAGS_JSON)', async () => {
      const dir = await useEmptyCwd();
      try {
        const result = await loadFlags({ env: { FORGE_FLAGS_JSON: JSON.stringify([1, 2, 3]) } });

        expect(result).toEqual({
          csv_export: false,
          contribute_bridge: false,
          upland_data: false,
          github_signin: false,
          apps_lobby: false,
          mcp_connector: false,
          agent_start: false,
          proposals: false,
          house_spec: false,
          lobby_avatars: false,
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('a non-object top-level payload fails closed (a file layer)', async () => {
      const dir = await useEmptyCwd();
      try {
        const filePath = join(dir, 'flags.json');
        await writeFile(filePath, JSON.stringify('hello'));

        const result = await loadFlags({ configPath: filePath, env: {} });

        expect(result).toEqual({
          csv_export: false,
          contribute_bridge: false,
          upland_data: false,
          github_signin: false,
          apps_lobby: false,
          mcp_connector: false,
          agent_start: false,
          proposals: false,
          house_spec: false,
          lobby_avatars: false,
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('logs the reason once via console.warn when failing closed', async () => {
      const dir = await useEmptyCwd();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await loadFlags({ env: { FORGE_FLAGS_JSON: '{not valid json' } });

        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0]?.[0]).toContain('FORGE_FLAGS_JSON');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
